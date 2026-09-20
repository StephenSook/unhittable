// End-to-end proof that the scanner works against a REAL browser loading a
// REAL page over HTTP, not against a mock of one.
//
// The fixture is built so that every verdict below can be worked out by hand
// from the CSS, and the expected values were written before the scanner was
// run against it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { scanUrl, VIEWPORTS, USER_AGENT } from '../src/scanner.js';
import { recordingToPath } from '@unhittable/core/replay.js';
import { normaliseTargetUrl } from '@unhittable/core/url-guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REC = new URL('../../../packages/core/data/006_StretchHold_RightWrist.txt', import.meta.url);
const tremor = recordingToPath(fs.readFileSync(REC, 'utf8'));

// The fixture is on loopback, which the real fence refuses. Tests therefore
// inject a permissive fence. This is a code-level parameter with no path from
// an HTTP request, and the last test in this file proves the DEFAULT still
// refuses loopback so the relaxation cannot leak into the deployed service.
const openFence = async (u) => (u instanceof URL ? u : normaliseTargetUrl(u));

let server, browser, base;

before(async () => {
  const html = fs.readFileSync(path.join(here, 'fixtures', 'page.html'), 'utf8');
  const responsive = fs.readFileSync(path.join(here, 'fixtures', 'page-responsive.html'), 'utf8');
  server = http.createServer((req, res) => {
    if (req.url === '/responsive') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(responsive);
    }
    if (req.url === '/notapage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"hello":true}');
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

const scan = (opts = {}) =>
  scanUrl({ browser, guard: openFence }, { url: base + (opts.p ?? '/'), path: tremor, ...opts });

test('the scanner loads a real page and reports the page it loaded', async () => {
  const r = await scan();
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Scanner fixture');
  assert.equal(r.viewport.name, 'desktop');
  assert.equal(r.viewport.deviceScaleFactor, 1, 'one CSS pixel must be one measured pixel');
  assert.ok(r.elements.length > 0);
  assert.ok(r.durationMs > 0);
});

test('measured sizes match the stylesheet exactly', async () => {
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));
  assert.deepEqual(
    { w: by('#compliant').w, h: by('#compliant').h }, { w: 44, h: 44 });
  assert.deepEqual(
    { w: by('#exact').w, h: by('#exact').h }, { w: 24, h: 24 });
  assert.deepEqual(
    { w: by('#wide').w, h: by('#wide').h }, { w: 200, h: 20 });
});

test('elements that are not operable are excluded, not failed', async () => {
  const r = await scan();
  const ids = r.elements.map((e) => e.selector);
  assert.ok(!ids.some((s) => s.includes('#gone')), 'display:none must not be measured');
  assert.ok(!ids.some((s) => s.includes('#off')), 'a disabled control is not a target');
  assert.ok(!ids.some((s) => s.includes('#ariahidden')), 'aria-hidden must not be measured');
  assert.ok(r.skipped.notRendered >= 1);
  assert.ok(r.skipped.disabled >= 1);
});

test('SC 2.5.8 size verdicts are what the CSS says they should be', async () => {
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));
  assert.equal(by('#compliant').sizeOk, true, '44x44 clears the minimum');
  assert.equal(by('#exact').sizeOk, true, 'exactly 24x24 clears it, inclusively');
  assert.equal(by('#wide').sizeOk, false, '20 px tall is under the minimum');
  assert.equal(by('#tiny').sizeOk, false, '12x12 is under it');
});

test('the Spacing exception is applied, and applied correctly', async () => {
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));
  // #tiny sits alone at (600,600) with nothing within 12 px, so the exception
  // rescues it and the standard says PASS despite 12x12.
  assert.equal(by('#tiny').spacingApplies, true);
  assert.equal(by('#tiny').spacingPass, true, 'an isolated small target earns the exception');
  assert.equal(by('#tiny').wcagPass, true);
  assert.equal(by('#tiny').wcagExemptReason, 'undersized but adequately spaced');

  // #crowdA and #crowdB are 16x16 at x=100 and x=118: centres 18 px apart,
  // inside the 24 px sum of radii, so neither earns it.
  assert.equal(by('#crowdA').spacingPass, false);
  assert.equal(by('#crowdB').spacingPass, false);
  assert.equal(by('#crowdA').wcagPass, false, 'crowded small targets fail the criterion');
});

test('a link in a sentence is detected as inline-exempt, a block link is not', async () => {
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));
  assert.equal(by('#inline').inlineExempt, true, 'a link inside running prose is in a sentence');
  assert.equal(by('#inline').wcagPass, true);
  assert.equal(by('#inline').wcagExemptReason, 'inline, in a sentence');
  assert.equal(by('#blocklink').inlineExempt, false, 'a sized block link is not in a sentence');
});

test('THE FINDING: a target can pass the standard and fail the hand', async () => {
  const r = await scan();
  const exact = r.elements.find((e) => e.selector.includes('#exact'));
  assert.equal(exact.wcagPass, true, 'the standard says this 24x24 button is fine');
  assert.ok(exact.hold < 0.5, `and the recorded hand held it ${(exact.hold * 100).toFixed(0)}% of the time`);
  assert.equal(exact.passesStandardButNotHand, true);
  assert.ok(exact.needWPx > 24, 'the report must say how big it would have to be');
  assert.ok(r.summary.passesStandardButNotHand >= 1);
});

test('the binding side is named, and it is a fact about the element', async () => {
  const r = await scan();
  const wide = r.elements.find((e) => e.selector.includes('#wide'));
  assert.equal(wide.bindingSide, 'height', '200 wide by 20 tall is bound by its height');
  // The published hold is the floor across azimuths, because the horizontal
  // frame's heading is not recoverable without a magnetometer.
  assert.ok(wide.hold <= wide.holdBest);
  assert.ok(wide.holdSpread >= 0);
  // Aspect ratio is preserved by the recommendation.
  assert.ok(Math.abs(wide.needWPx / wide.needHPx - 200 / 20) < 1e-6);
});

test('accessible names are recovered from several sources', async () => {
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));
  assert.equal(by('#field').name, 'Your name', 'from aria-label');
  assert.equal(by('#wide').name, 'A wide primary action', 'from visible text');
});

test('the mobile viewport is a different measurement, not a relabelled one', async () => {
  const d = await scan({ p: '/responsive', viewport: 'desktop' });
  const m = await scan({ p: '/responsive', viewport: 'mobile' });
  assert.equal(m.viewport.name, 'mobile');
  assert.equal(m.page.viewport.w, VIEWPORTS.mobile.width, 'a responsive page lays out at the device width');
  assert.equal(d.page.viewport.w, VIEWPORTS.desktop.width);
  assert.notEqual(d.page.viewport.w, m.page.viewport.w);
  assert.equal(m.warnings.length, 0, 'a responsive page has nothing to warn about');
});

test('a page with no viewport meta tag is caught shrinking every target at once', async () => {
  // This test exists because an earlier version of it asserted 390 and got
  // 980. The scanner was right: without a viewport meta tag a phone lays the
  // page out at its default width and scales the result down to fit, so every
  // target is displayed smaller than it measures. That shrink multiplies the
  // whole page rather than failing any single element, so it is reported as a
  // page-level warning and never folded into the element counts.
  const m = await scan({ p: '/', viewport: 'mobile' });
  assert.equal(m.page.hasViewportMeta, false);
  assert.ok(m.page.layoutWidth > VIEWPORTS.mobile.width,
    `expected a wide default layout, measured ${m.page.layoutWidth}`);
  assert.ok(m.page.layoutScale < 0.6, `every target is shown at ${m.page.layoutScale} of measured size`);
  const w = m.warnings.find((x) => x.kind === 'no-viewport-meta');
  assert.ok(w, 'the warning must be present');
  assert.match(w.detail, /no viewport meta tag/);

  // And it must NOT fire on desktop, where a 980 px layout in a 1280 px
  // window is simply a page that does not fill the window.
  const d = await scan({ p: '/', viewport: 'desktop' });
  assert.equal(d.warnings.length, 0);
});

test('sensitivity changes the outcome, which is why it is swept and not assumed', async () => {
  const slow = await scan({ cpi: 200 });
  const fast = await scan({ cpi: 1600 });
  const pick = (r) => r.elements.find((e) => e.selector.includes('#exact')).hold;
  assert.ok(pick(slow) > pick(fast), 'a lower sensitivity must make the same target easier to hold');
});

test('a non-HTML response is refused rather than measured', async () => {
  await assert.rejects(scan({ p: '/notapage' }), /not a web page/);
});

test('a redirect is followed and the destination is re-checked', async () => {
  const r = await scan({ p: '/redirect' });
  assert.equal(r.title, 'Scanner fixture');
  assert.ok(r.requestedUrl.endsWith('/redirect'));
  assert.ok(!r.url.endsWith('/redirect'), 'the report names the page that actually loaded');
});

test('the scanner identifies itself honestly in its User-Agent', async () => {
  assert.match(USER_AGENT, /Unhittable\/1\.0/);
  assert.match(USER_AGENT, /github\.com\/StephenSook\/unhittable/);
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<button style="width:24px;height:24px">x</button>');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  await scanUrl({ browser, guard: openFence },
    { url: `http://127.0.0.1:${s.address().port}/`, path: tremor });
  await new Promise((r) => s.close(r));
  assert.ok(seen.length > 0 && /Unhittable/.test(seen[0]), 'the site owner can see who we are in their logs');
});

test('THE FENCE IS ON BY DEFAULT: no injected guard means loopback is refused', async () => {
  // The test above relaxes the fence deliberately. This one proves the
  // relaxation is not the default, which is the only reason the relaxation is
  // acceptable at all.
  await assert.rejects(
    scanUrl({ browser }, { url: base + '/', path: tremor }),
    /loopback/,
    'the deployed default must refuse to scan a private address',
  );
  await assert.rejects(
    scanUrl({ browser }, { url: 'http://169.254.169.254/latest/meta-data/', path: tremor }),
    /metadata|link-local/,
  );
});

test('REGRESSION: adjacent navigation links are NOT waved through as inline prose', async () => {
  // The bug: the inline check subtracted only the element's own text from its
  // parent's, so a sibling LINK supplied the characters that made the first
  // link look like it sat in a sentence. Both then skipped the size and the
  // spacing tests entirely, which is the opposite of what the exception is
  // for and would have hidden real failures on every nav bar on the web.
  const r = await scan();
  const by = (id) => r.elements.find((e) => e.selector.includes(id));

  assert.equal(by('#navA').inlineExempt, false, 'a nav link next to another nav link is not in a sentence');
  assert.equal(by('#navB').inlineExempt, false);

  // And the genuine case must still be recognised, or the fix has just
  // disabled the exception rather than corrected it.
  assert.equal(by('#inline').inlineExempt, true, 'a link inside running prose is still exempt');
});
