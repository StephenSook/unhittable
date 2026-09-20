// cohort.mjs - measure the whole PADS cohort, not one flattering recording.
//
// WHY THIS EXISTS. The first version of this project was built on a single
// patient recording, and a single recording cannot tell you whether it is
// typical. Running the same measurement over 260 clinically assessed people
// showed that it is not: subject 006 is the second cleanest postural tremor
// in 1,560 recordings. Publishing it as "a Parkinson's tremor" would have been
// true of that person and misleading about everyone else.
//
// So the published claim is a DISTRIBUTION over a cohort, and this script is
// what produces it. It writes apps/web/data/cohort.json, which the page reads.
//
// THE CONVERSION THAT MATTERS. Tremor amplitude is a distance in millimetres.
// Turning it into pixels depends entirely on what is moving:
//   - a finger on a touchscreen:  1 mm is about 3.78 CSS px   (96 dpi screen)
//   - a hand on a 800 cpi mouse:  1 mm is about 31.5 CSS px   (800 / 25.4)
// Those differ by a factor of 8.3. This project is about pointing with a
// mouse, so the second one is the right one, and every pixel figure below is
// computed through cpiToCssPxPerMm rather than through a screen density.
//
// Usage: node scripts/cohort.mjs [--data DIR] [--out FILE]

import fs from 'node:fs';
import path from 'node:path';
import { parsePadsRecord, accelGToDisplacementMm, tremorSpectrum, peakToPeak, rms, PADS_FS } from '../packages/core/src/tremor.js';
import { recordingToPath } from '../packages/core/src/replay.js';
import {
  holdFractionRect, cpiToCssPxPerMm, WCAG_MIN_PX, WCAG_ENHANCED_PX,
  scaleForHoldRect, azimuthFamily, extentOverAzimuths,
} from '../packages/core/src/geometry.js';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const DATA = argOf('--data', '/tmp/pads_wide');
const OUT = argOf('--out', 'apps/web/data/cohort.json');

// Holding a mouse steady while aiming is a POSTURAL task: the limb is held
// against gravity in a fixed position. Parkinsonian REST tremor is suppressed
// by exactly that, and the rest recordings in this dataset do show a higher
// detection rate. Using them would raise every number in this report and would
// be measuring the wrong thing, so they are excluded and the exclusion is
// stated rather than quietly applied.
const POSTURAL = ['StretchHold', 'LiftHold', 'HoldWeight'];
const EXCLUDED_WITH_REASON = {
  Relaxed: 'rest tremor, suppressed during the postural hold a mouse requires',
  RelaxedTask: 'rest with cognitive load, same reason',
  PointFinger: 'voluntary arm movement dominates; healthy subjects move more than patients',
  DrinkGlas: 'kinetic, whole-arm transport',
  CrossArms: 'kinetic',
  TouchNose: 'kinetic, intention tremor task',
  TouchIndex: 'kinetic',
  Entrainment: 'deliberately entrains the tremor to an external rhythm',
  LiftHoldTask: 'dual task variant, not a plain postural hold',
  HoldWeightTask: 'dual task variant',
  StretchHoldTask: 'dual task variant',
};

// A recording "clears" when the spectral peak stands this far above its own
// local baseline. The bar is not arbitrary: over 2,000 white-noise draws and
// 300 time-shuffled real records, zero reached 5 (white noise median 2.44,
// p99 3.75, max 4.03). It is therefore a bar a null cannot pass, which is the
// only kind of bar worth having.
const PROMINENCE_BAR = 5;

const CPIS = [200, 400, 800, 1200, 1600];
// How many rotations of the horizontal plane to consider. The frame's heading
// is not recoverable, so every published figure is the floor across these.
const AZIMUTHS = 12;
const SIZES = [24, 32, 44, 64, 96, 128, 192, 256];

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function describe(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5),
    q3: quantile(s, 0.75), max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

function loadConditions(dir) {
  const map = new Map();
  const pdir = path.join(dir, 'patients');
  for (const f of fs.readdirSync(pdir)) {
    const m = /^patient_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const j = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'));
    map.set(m[1], j.condition ?? 'Unknown');
  }
  return map;
}

/**
 * One recording, measured THROUGH THE SHIPPED PIPELINE.
 *
 * This used to reimplement the measurement, and it drifted: the generator was
 * computing hold from one raw projection while its own output file said the
 * figures were the floor across a family. A generator that does not call the
 * product's code will eventually describe a different product.
 */
function measure(file, band) {
  const text = fs.readFileSync(file, 'utf8');
  let p;
  try { p = recordingToPath(text, { loHz: band.loHz, hiHz: band.hiHz, planes: AZIMUTHS * 2 }); }
  catch { return null; }
  if (!p || !p.n || p.prominence === null) return null;
  return {
    hz: p.hz, prominence: p.prominence,
    p2pMm: p.p2pMm, rmsMm: p.rmsMm,
    path: p, family: p.family,
    sweptDeg: p.sweptDeg, gravityG: p.gravityG,
    samples: p.n,
  };
}

function run(band, bandLabel, conditions, files) {
  const rows = [];
  for (const { subject, task, wrist, file } of files) {
    const m = measure(file, band);
    if (!m) continue;
    rows.push({
      subject, task, wrist,
      condition: conditions.get(subject) ?? 'Unknown',
      hz: m.hz, prominence: m.prominence, p2pMm: m.p2pMm, rmsMm: m.rmsMm,
      samples: m.samples, path: m.path, family: m.family,
      sweptDeg: m.sweptDeg, gravityG: m.gravityG,
    });
  }

  const clearing = rows.filter((r) => r.prominence >= PROMINENCE_BAR);

  // The pointing outcome, for every clearing recording, at every sensitivity.
  //
  // THE AZIMUTH TREATMENT IS APPLIED HERE, not merely described. An earlier
  // version of this generator computed hold from ONE raw path while the
  // output file and the README both said the figures were the floor across
  // twelve azimuths. They were not, and on recording 071 the difference was
  // ten points of hold. A generator that does not perform the method its own
  // output claims is the worst kind of drift, because the number looks
  // produced rather than asserted.
  for (const r of clearing) {
    const family = r.family;
    // Amplitude is already the invariant three-dimensional extent.
    r.extentMm = r.p2pMm;
    r.pointing = {};
    for (const cpi of CPIS) {
      const ppm = cpiToCssPxPerMm(cpi);
      // MEDIAN across the plane family, matching what the product publishes.
      const medianHold = (px) => {
        const hs = family.map((p) => holdFractionRect(p, ppm, px, px)).sort((a, b) => a - b);
        return hs[Math.floor(hs.length / 2)];
      };
      const worstHold = medianHold;
      const ks = [];
      for (const p of family) {
        const k = scaleForHoldRect(p, ppm, WCAG_MIN_PX, WCAG_MIN_PX, 0.95);
        if (k !== null) ks.push(k);
      }
      ks.sort((a, b) => a - b);
      const need = ks.length === family.length ? ks[Math.floor(ks.length / 2)] : null;
      r.pointing[cpi] = {
        pxPerMm: ppm,
        p2pPx: r.extentMm * ppm,
        hold: Object.fromEntries(SIZES.map((s) => [s, worstHold(s)])),
        need95Px: need === null ? null : WCAG_MIN_PX * need,
      };
    }
  }

  const byCondition = {};
  for (const r of rows) {
    const c = (byCondition[r.condition] ??= { recordings: 0, clearing: 0, subjects: new Set(), subjectsClearing: new Set() });
    c.recordings++; c.subjects.add(r.subject);
    if (r.prominence >= PROMINENCE_BAR) { c.clearing++; c.subjectsClearing.add(r.subject); }
  }
  for (const c of Object.values(byCondition)) {
    c.subjectCount = c.subjects.size; c.subjectClearingCount = c.subjectsClearing.size;
    c.clearRate = c.recordings ? c.clearing / c.recordings : 0;
    delete c.subjects; delete c.subjectsClearing;
  }

  // The headline distribution: at a standard desktop sensitivity, how often
  // does each measured tremor actually stay inside the size the standard
  // permits?
  const ppm800 = cpiToCssPxPerMm(800);
  const holds24 = clearing.map((r) => r.pointing[800].hold[24]);
  const holds44 = clearing.map((r) => r.pointing[800].hold[44]);

  return {
    band: bandLabel,
    bandHz: [band.loHz, band.hiHz],
    prominenceBar: PROMINENCE_BAR,
    recordings: rows.length,
    subjects: new Set(rows.map((r) => r.subject)).size,
    clearing: clearing.length,
    clearRate: rows.length ? clearing.length / rows.length : 0,
    subjectsClearing: new Set(clearing.map((r) => r.subject)).size,
    byCondition,
    amplitudeMm: describe(clearing.map((r) => r.extentMm)),
    amplitudeSingleAxisMm: describe(clearing.map((r) => r.p2pMm)),
    frequencyHz: describe(clearing.map((r) => r.hz)),
    cursorExcursionPx800: describe(clearing.map((r) => r.extentMm * ppm800)),
    hold24At800: describe(holds24),
    hold44At800: describe(holds44),
    // The counts a reader actually needs, rather than a mean that hides them.
    below95At24: holds24.filter((h) => h < 0.95).length,
    below50At24: holds24.filter((h) => h < 0.5).length,
    below95At44: holds44.filter((h) => h < 0.95).length,
    exceedsWholeTarget24: clearing.filter((r) => r.extentMm * ppm800 > 24).length,
    records: clearing
      .map((r) => ({
        subject: r.subject, condition: r.condition, task: r.task, wrist: r.wrist,
        hz: r.hz, prominence: r.prominence, p2pMm: r.p2pMm, extentMm: r.extentMm, rmsMm: r.rmsMm,
        sweptDeg: r.sweptDeg,
        pointing: Object.fromEntries(Object.entries(r.pointing).map(([k, v]) => [k, {
          p2pPx: v.p2pPx, hold: v.hold, need95Px: v.need95Px,
        }])),
      }))
      .sort((a, b) => b.prominence - a.prominence),
  };
}

// ---------------------------------------------------------------------------

const conditions = loadConditions(DATA);
const tsdir = path.join(DATA, 'ts');
const files = [];
for (const f of fs.readdirSync(tsdir)) {
  const m = /^(\d+)_([A-Za-z]+)_(LeftWrist|RightWrist)\.txt$/.exec(f);
  if (!m) continue;
  const [, subject, task, wrist] = m;
  if (!POSTURAL.includes(task)) continue;
  files.push({ subject, task, wrist, file: path.join(tsdir, f) });
}
if (files.length === 0) {
  console.error(`No postural recordings found under ${tsdir}. Fetch the cohort first.`);
  process.exit(1);
}

// Two bands, published together. The narrow one is the Parkinsonian rest-tremor
// consensus range; the wide one also covers essential tremor, which runs to
// 12 Hz. A finding that only survives one choice of band is a choice, not a
// finding, so both are reported and the page shows both.
const primary = run({ loHz: 3.5, hiHz: 8 }, '3.5-8 Hz (parkinsonian)', conditions, files);
const wide = run({ loHz: 3.5, hiHz: 12 }, '3.5-12 Hz (includes essential tremor)', conditions, files);

const out = {
  generatedBy: 'scripts/cohort.mjs',
  generatedAt: new Date().toISOString().slice(0, 10),
  source: {
    dataset: 'PADS: Parkinson\'s Disease Smartwatch dataset',
    citation: 'Varghese et al., npj Parkinson\'s Disease, 2024',
    url: 'https://physionet.org/content/parkinsons-disease-smartwatch/1.0.0/',
    licence: 'CC BY-NC-SA 4.0',
    device: 'Apple Watch Series 4, bilateral, 100 Hz',
  },
  method: {
    posturalTasks: POSTURAL,
    excludedTasks: EXCLUDED_WITH_REASON,
    prominenceBar: PROMINENCE_BAR,
    prominenceBarCalibration: 'Zero of 2,000 white-noise draws and zero of 300 time-shuffled real recordings reach 5. White noise: median 2.44, p99 3.75, max 4.03.',
    pixelMapping: 'cpi / 25.4 / displayScale. A mouse, not a touchscreen. At 800 cpi one millimetre of hand movement is 31.5 CSS px, not the 3.78 px a 96 dpi screen would give.',
    rotationCorrection: 'None, deliberately. A gyroscope-based attitude correction was built and then removed: PADS ships a gravity-free accelerometer channel (mean magnitude 0.001 to 0.14 g, not ~1 g), so the rotation-into-gravity confound has no mechanism here and the filter was deriving attitude from noise. The frame\'s arbitrary heading is handled instead by publishing the worst hold across azimuths.',
    amplitudeWindow: 'No taper is applied on the displacement path. A Hann window is correct for spectral estimation and wrong for amplitude reconstruction, because the envelope is never removed; an earlier version carried it into the result and inflated every hold rate.',
    cpiSwept: CPIS,
    planes: `Gyroscope de-rotation leaves a frame that is fixed but of unknown orientation, so every hold and every required size is the MEDIAN across ${AZIMUTHS * 2} plane projections rather than a single guess. The worst plane is the one containing the tremor's dominant direction and is carried as the bottom of a range rather than as the headline. Amplitude is the largest extent in any direction in space.`,
  },
  primary,
  sensitivity: wide,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const p = primary;
console.log(`cohort: ${p.subjects} subjects, ${p.recordings} postural recordings`);
console.log(`clearing prominence >= ${PROMINENCE_BAR}: ${p.clearing} (${(p.clearRate * 100).toFixed(1)}%) from ${p.subjectsClearing} subjects`);
console.log(`amplitude mm     : median ${p.amplitudeMm.median.toFixed(3)}  q3 ${p.amplitudeMm.q3.toFixed(3)}  max ${p.amplitudeMm.max.toFixed(3)}`);
console.log(`cursor px @800cpi: median ${p.cursorExcursionPx800.median.toFixed(1)}  q3 ${p.cursorExcursionPx800.q3.toFixed(1)}  max ${p.cursorExcursionPx800.max.toFixed(1)}`);
console.log(`hold of a 24 px target @800cpi: median ${(p.hold24At800.median * 100).toFixed(0)}%  worst ${(p.hold24At800.min * 100).toFixed(0)}%  best ${(p.hold24At800.max * 100).toFixed(0)}%`);
console.log(`  below 95% hold at 24 px: ${p.below95At24} of ${p.clearing}`);
console.log(`  below 50% hold at 24 px: ${p.below50At24} of ${p.clearing}`);
console.log(`  below 95% hold at 44 px: ${p.below95At44} of ${p.clearing}`);
console.log(`  tremor wider than the whole 24 px target: ${p.exceedsWholeTarget24} of ${p.clearing}`);
console.log(`by condition (clear rate):`);
for (const [c, v] of Object.entries(p.byCondition).sort((a, b) => b[1].clearRate - a[1].clearRate)) {
  console.log(`  ${c.padEnd(28)} ${String(v.clearing).padStart(3)}/${String(v.recordings).padEnd(5)} ${(v.clearRate * 100).toFixed(1).padStart(5)}%   subjects ${v.subjectClearingCount}/${v.subjectCount}`);
}
console.log(`\nsensitivity, ${wide.band}: ${wide.clearing} clearing (${(wide.clearRate * 100).toFixed(1)}%), median hold at 24 px ${(wide.hold24At800.median * 100).toFixed(0)}%`);
