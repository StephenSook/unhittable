// rejudge.mjs - recompute every stored scan against the current core.
//
// The measured GEOMETRY of a page does not change when our analysis changes,
// only the verdict does. So when the displacement pipeline is corrected, the
// polite and honest move is to re-judge the rectangles already on disk rather
// than fetch forty strangers' homepages a third time. It is also the faster
// check: if a code change alters a published number, this says so in seconds.

import { recordingToPath } from '../packages/core/src/replay.js';
import { evaluateSpacing, judgeElement, summarise, cpiToCssPxPerMm, azimuthFamily } from '../packages/core/src/geometry.js';
import { getRecording, DEFAULT_RECORDING } from '../apps/api/src/recordings.js';
import * as db from '../apps/api/src/db.js';

const pool = db.createPool(process.env.DATABASE_URL);
if (!pool) { console.error('DATABASE_URL is required'); process.exit(1); }

// Corpus rows only. This used to select EVERY scan and rewrite each one's
// recording_id to the current default, silently reinterpreting an ad-hoc scan
// that had deliberately been made with another recording.
const rec0 = getRecording(DEFAULT_RECORDING);
const { rows } = await pool.query(
  'SELECT id, recording_id, cpi, want, report FROM scans WHERE in_corpus ORDER BY id');
console.log(`re-judging ${rows.length} stored scans`);

let changed = 0;
for (const row of rows) {
  // Every corpus row is re-judged against the CURRENT default, because the
  // published figure must describe one consistent hand rather than whichever
  // recording happened to be default when each row was written.
  const rec = getRecording(DEFAULT_RECORDING);
  const report = row.report;
  const rects = report.elements.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
  const spacing = evaluateSpacing(rects);
  const ppm = cpiToCssPxPerMm(row.cpi);
  const family = azimuthFamily(rec.path, 12);

  const before = report.summary.passesStandardButNotHand;
  report.elements = report.elements.map((e, i) => {
    const j = judgeElement(rects[i], spacing[i], family, ppm, { want: row.want });
    return {
      ...e, ...j,
      wcagPass: j.wcagPass || e.inlineExempt,
      wcagExemptReason: j.sizeOk ? null
        : e.inlineExempt ? 'inline, in a sentence'
        : (j.spacingApplies && j.spacingPass) ? 'undersized but adequately spaced'
        : null,
    };
  });
  const s = summarise(report.elements, { want: row.want });
  report.summary = { ...report.summary, ...s };
  if (s.passesStandardButNotHand !== before) changed++;

  // ONE TRANSACTION PER SCAN. These were three separate autocommit queries, so
  // a failure between the delete and the insert left a scan with no element
  // rows at all, silently dropping it from the public aggregate, and a reader
  // during the run could observe a mixture of two algorithms.
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  await client.query(
    `UPDATE scans SET recording_id = $8, report = $2, n_wcag_pass = $3, n_hand_pass = $4,
       n_standard_not_hand = $5, median_hold = $6, worst_hold = $7 WHERE id = $1`,
    [row.id, report, s.wcagPass, s.handPass, s.passesStandardButNotHand, s.medianHold, s.worstHold, rec.id]);

  await client.query('DELETE FROM elements WHERE scan_id = $1', [row.id]);
  if (report.elements.length) {
    const cols = 15, values = [], params = [];
    report.elements.forEach((e, i) => {
      const b = i * cols;
      values.push(`(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(',')})`);
      params.push(row.id, e.tag ?? null, e.role ?? null, (e.name ?? '').slice(0, 300),
        (e.selector ?? '').slice(0, 500), e.w, e.h, e.sizeOk, e.wcagPass, !!e.inlineExempt,
        e.hold, e.holdBest ?? e.hold, e.holdSpread ?? 0, e.bindingSide ?? null, e.passesStandardButNotHand);
    });
    await client.query(
      `INSERT INTO elements (scan_id, tag, role, name, selector, w, h, size_ok, wcag_pass,
        inline_exempt, hold, hold_best, hold_spread, binding_side, standard_not_hand)
       VALUES ${values.join(',')}`, params);
  }
  await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`scan ${row.id} could not be re-judged, and was rolled back rather than left without elements: ${e.message}`);
  } finally {
    client.release();
  }
}

const { aggregate: a } = await db.corpusSummary(pool, rec0.id);
const n = Number(a.targets);
console.log(`\n${changed} of ${rows.length} scans changed verdict counts\n`);
console.log('--- the published number, recomputed ---');
console.log(`${a.sites} sites, ${n} interactive controls`);
console.log(`fail SC 2.5.8 outright          : ${a.fail_standard} (${(100 * a.fail_standard / n).toFixed(1)}%)`);
console.log(`PASS the standard, fail the hand: ${a.pass_standard_fail_hand} (${(100 * a.pass_standard_fail_hand / n).toFixed(1)}%)`);
console.log(`held under 95% of the time      : ${a.below_95} (${(100 * a.below_95 / n).toFixed(1)}%)`);
console.log(`missed more often than hit      : ${a.below_50} (${(100 * a.below_50 / n).toFixed(1)}%)`);
console.log(`limited by HEIGHT / WIDTH       : ${a.limited_by_height} / ${a.limited_by_width}`);
console.log(`median control                  : ${Number(a.median_w).toFixed(0)} by ${Number(a.median_h).toFixed(0)} px`);
console.log(`median hold                     : ${(a.median_hold * 100).toFixed(0)}%`);
await pool.end();
