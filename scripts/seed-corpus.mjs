// seed-corpus.mjs - measure a defined set of real sites, once, and store it.
//
// The corpus is what turns a finding about a dataset into a finding about the
// web. Three disciplines keep it honest:
//
//   1. robots.txt is checked and obeyed. A single user-initiated scan is a
//      browser visit and does not need permission; an automated sweep of
//      forty sites is a crawl and does. The distinction is deliberate and is
//      stated on the site.
//
//   2. A WAF challenge served as HTTP 200 is detected and EXCLUDED. Enterprise
//      protection commonly answers a bot with a challenge page carrying a 200,
//      and a scanner that trusts the status code silently records "this site
//      has four buttons" as a measurement. Every exclusion is recorded with
//      its reason rather than dropped.
//
//   3. Requests are paced. Forty homepages at one every few seconds is
//      indistinguishable from a person browsing; a tight loop is an attack.
//
// Usage: node --env-file=.env scripts/seed-corpus.mjs [--limit N] [--viewport desktop|mobile] [--dry]

import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { scanUrl, ResolverCache, USER_AGENT } from '../apps/api/src/scanner.js';
import { getRecording, DEFAULT_RECORDING } from '../apps/api/src/recordings.js';
import * as db from '../apps/api/src/db.js';
import { createGuardProxy } from '../apps/api/src/guard-proxy.js';
import { isAllowed, statusMeaning } from '../packages/core/src/robots.js';

const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(argOf('--limit', '999'));
const VIEWPORT = argOf('--viewport', 'desktop');
const DRY = args.includes('--dry');
const PACE_MS = Number(argOf('--pace', '3000'));

const { sites } = JSON.parse(fs.readFileSync('scripts/sites.json', 'utf8'));

/**
 * Fetch and apply robots.txt. Parsing lives in packages/core/src/robots.js so
 * it can be tested; this function only does the network part and the policy.
 */
async function robotsAllows(url, ua = 'Unhittable') {
  const u = new URL(url);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  let res;
  try {
    res = await fetch(robotsUrl, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(9000),
      redirect: 'follow',
    });
  } catch (e) {
    return { allowed: false, why: `could not read robots.txt: ${e.message}` };
  }

  const meaning = statusMeaning(res.status);
  if (!meaning.parse) return { allowed: meaning.allowed, why: meaning.why };

  let text;
  try { text = await res.text(); } catch (e) { return { allowed: false, why: `unreadable robots.txt: ${e.message}` }; }
  if (text.length > 512_000) return { allowed: false, why: 'robots.txt implausibly large' };

  return isAllowed(text, ua, u.pathname + u.search);
}

/**
 * Is this a bot challenge wearing an HTTP 200?
 *
 * Checked by CONTENT, never by status, because the whole failure mode is a
 * challenge page returning 200. A scanner that misses this records a busy
 * homepage as having three controls and publishes it.
 */
function looksLikeChallenge(report) {
  const t = (report.title || '').toLowerCase();
  const challengeTitles = [
    'just a moment', 'attention required', 'access denied', 'are you a robot',
    'security check', 'pardon our interruption', 'bot verification', 'checking your browser',
    'human verification', 'one more step', 'blocked', 'forbidden', 'error 403',
  ];
  for (const c of challengeTitles) if (t.includes(c)) return `challenge page: title "${report.title}"`;
  if (report.status >= 400) return `HTTP ${report.status}`;
  // A major organisation's homepage with almost no interactive controls did
  // not load. A real homepage has navigation.
  if (report.summary.n < 5) return `only ${report.summary.n} interactive targets, which is not a real homepage`;
  return null;
}

const recording = getRecording(DEFAULT_RECORDING);
const pool = DRY ? null : db.createPool(process.env.DATABASE_URL);
if (pool) await db.migrate(pool);

const browser = await chromium.launch({ headless: true });
const resolver = new ResolverCache();

// The sweep that produces the published numbers goes through the same
// connection fence the deployed API uses. It did not, and that was the point
// of the finding: the corpus is the most security-sensitive path here,
// because it visits forty third-party sites unattended.
const guardProxy = createGuardProxy();
const proxyUrl = await guardProxy.listen();
console.log(`connection fence listening on ${proxyUrl}\n`);

const outcome = { scanned: [], skippedRobots: [], excluded: [], failed: [] };
let i = 0;

for (const site of sites.slice(0, LIMIT)) {
  i++;
  const tag = `[${String(i).padStart(2)}/${Math.min(sites.length, LIMIT)}] ${site.label}`;

  const robots = await robotsAllows(site.url);
  if (!robots.allowed) {
    console.log(`${tag}: SKIPPED, ${robots.why}`);
    outcome.skippedRobots.push({ ...site, why: robots.why });
    if (pool) await db.recordCorpusError(pool, site.url, `robots: ${robots.why}`).catch(() => {});
    continue;
  }

  let report;
  try {
    report = await scanUrl({ browser, resolver }, {
      url: site.url, path: recording.path, cpi: 800, viewport: VIEWPORT, timeoutMs: 30_000, proxyUrl,
    });
  } catch (e) {
    console.log(`${tag}: FAILED, ${e.message.slice(0, 110)}`);
    outcome.failed.push({ ...site, why: e.message.slice(0, 200) });
    if (pool) await db.recordCorpusError(pool, site.url, e.message).catch(() => {});
    await new Promise((r) => setTimeout(r, PACE_MS));
    continue;
  }

  const challenge = looksLikeChallenge(report);
  if (challenge) {
    console.log(`${tag}: EXCLUDED, ${challenge}`);
    outcome.excluded.push({ ...site, why: challenge, targets: report.summary.n });
    if (pool) await db.recordCorpusError(pool, site.url, `excluded: ${challenge}`).catch(() => {});
    await new Promise((r) => setTimeout(r, PACE_MS));
    continue;
  }

  const s = report.summary;
  console.log(`${tag}: ${String(s.n).padStart(4)} targets | ${String(s.n - s.wcagPass).padStart(3)} fail SC 2.5.8 | ` +
    `${String(s.passesStandardButNotHand).padStart(4)} pass it and fail the hand | median hold ${(s.medianHold * 100).toFixed(0)}%`);

  if (pool) {
    await db.upsertCorpusSite(pool, site);
    await db.saveScan(pool, report, { recordingId: recording.id, inCorpus: true });
  }
  outcome.scanned.push({ ...site, summary: s, url: report.url });

  await new Promise((r) => setTimeout(r, PACE_MS));
}

await browser.close();
await guardProxy.close();

console.log('\n================ CORPUS ================');
console.log(`scanned  ${outcome.scanned.length}`);
console.log(`excluded ${outcome.excluded.length}   (bot challenge or not a real page)`);
console.log(`robots   ${outcome.skippedRobots.length}`);
console.log(`failed   ${outcome.failed.length}`);

if (pool) {
  // Rows from a superseded default recording are stale duplicates of the same
  // pages, not extra evidence. Clear them before reporting.
  const stale = await pool.query('DELETE FROM scans WHERE in_corpus AND recording_id <> $1', [recording.id]);
  if (stale.rowCount) console.log(`cleared ${stale.rowCount} corpus rows from a superseded recording`);
  const { aggregate: a } = await db.corpusSummary(pool, recording.id);
  console.log('\n--- the published number ---');
  console.log(`${a.sites} sites, ${a.targets} interactive controls measured`);
  console.log(`fail SC 2.5.8 outright          : ${a.fail_standard} (${(100 * a.fail_standard / a.targets).toFixed(1)}%)`);
  console.log(`PASS the standard, fail the hand: ${a.pass_standard_fail_hand} (${(100 * a.pass_standard_fail_hand / a.targets).toFixed(1)}%)`);
  console.log(`held under 95% of the time      : ${a.below_95} (${(100 * a.below_95 / a.targets).toFixed(1)}%)`);
  console.log(`missed more often than hit      : ${a.below_50} (${(100 * a.below_50 / a.targets).toFixed(1)}%)`);
  console.log(`limited by HEIGHT               : ${a.limited_by_height}`);
  console.log(`limited by WIDTH                : ${a.limited_by_width}`);
  console.log(`median control                  : ${Number(a.median_w).toFixed(0)} by ${Number(a.median_h).toFixed(0)} px`);
  console.log(`median hold                     : ${(a.median_hold * 100).toFixed(0)}%`);
  await pool.end();
}
fs.writeFileSync('/tmp/corpus-run.json', JSON.stringify(outcome, null, 2));
console.log('\nper-site detail: /tmp/corpus-run.json');
