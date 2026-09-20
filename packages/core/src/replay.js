// replay.js - what a recorded tremor does to a pointing task.
//
// Everything here is pure and synchronous so it can be tested in Node and run
// in the browser from the same file. The page animates these numbers; it does
// not compute different ones.

import { parsePadsRecord, accelGToDisplacementMm, tremorSpectrum, peakToPeak, rms, PADS_FS } from './tremor.js';
import { derotate } from './attitude.js';
import { planeFamily, extent3D, PLANE_COUNT } from './geometry.js';

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA. */
export const WCAG_MIN_PX = 24;
/** WCAG 2.2 SC 2.5.5 Target Size (Enhanced), Level AAA. */
export const WCAG_ENHANCED_PX = 44;

/**
 * Counts per inch to pixels per millimetre.
 *
 * This is the one genuinely underdetermined link in the chain and the reason
 * every result here is a curve rather than a number. A mouse reports counts
 * per inch, the operating system then applies its own pointer-acceleration
 * curve, and on Windows that curve is user-configurable and undocumented.
 * So the honest presentation is a sweep across the plausible range, not a
 * single conversion asserted as fact.
 */
export function cpiToPxPerMm(cpi) {
  if (!(cpi > 0)) throw new Error('cpiToPxPerMm: cpi must be positive');
  return cpi / 25.4;
}

/**
 * Turn one PADS recording into a two-dimensional cursor path in millimetres.
 *
 * Two axes, not the magnitude, because a cursor moves in a plane and a button
 * is a rectangle, and collapsing to a scalar would throw away the geometry
 * that decides whether a click lands.
 *
 * ON THE FRAME, AND ON TWO CORRECTIONS: ONE REMOVED, ONE KEPT.
 *
 * A rotating accelerometer that carries gravity fabricates apparent movement,
 * because tilting changes how much gravity falls on each axis. That is real,
 * and this project briefly shipped a gyroscope-based attitude correction for
 * it.
 *
 * The correction was then removed, because PADS does not carry gravity. Its
 * accelerometer channel is already gravity-free, the way CoreMotion's
 * userAcceleration is: the mean magnitude across these records is 0.001 to
 * 0.14 g rather than the ~1 g a gravity-bearing channel shows. So the
 * confound's mechanism is absent, and the filter that was supposed to remove
 * it was deriving attitude from noise. See docs/FALSE-GREENS.md entry 14.
 *
 * What removing gravity does NOT do is make the frame inertial. The wrist
 * still turns, so over ten seconds real acceleration is smeared between x, y
 * and z, and integrating the raw device axes as though they were a fixed
 * plane mixes the signal with itself. Measured on the shipped recordings,
 * correcting that changes amplitude by -7% to +51%.
 *
 * So the gyroscope IS used, just not for what it was used for before: it
 * removes time-varying rotation without any accelerometer feedback, which
 * needs no gravity. The result is a frame that is fixed but of unknown
 * orientation, and the remaining ambiguity is swept rather than assumed away.
 * All three axes are kept, because the out-of-plane component was being
 * silently discarded and it is large.
 */
export function recordingToPath(text, { loHz = 3.5, hiHz = 8, trim = 0.2, planes = PLANE_COUNT } = {}) {
  const r = parsePadsRecord(text);

  // Gyroscope only, from identity, no accelerometer feedback: this removes
  // the rotation without needing an absolute vertical the data cannot supply.
  let src = { ex: r.ax, ey: r.ay, ez: r.az }, sweptDeg = null;
  try { const d = derotate(r, PADS_FS); src = d; sweptDeg = d.sweptDeg; }
  catch { /* no gyroscope: fall back to device axes and report it */ }

  const dxAll = accelGToDisplacementMm(src.ex, PADS_FS, { loHz, hiHz });
  const dyAll = accelGToDisplacementMm(src.ey, PADS_FS, { loHz, hiHz });
  const dzAll = accelGToDisplacementMm(src.ez, PADS_FS, { loHz, hiHz });

  // Drop the ends, where the analysis window tapers the signal toward zero.
  const a = Math.floor(r.n * trim);
  const b = Math.ceil(r.n * (1 - trim));
  const x = dxAll.slice(a, b);
  const y = dyAll.slice(a, b);
  const z = dzAll.slice(a, b);

  const magnitude = Float64Array.from({ length: r.n }, (_, i) => Math.hypot(r.ax[i], r.ay[i], r.az[i]));
  const spec = tremorSpectrum(magnitude, PADS_FS, { loHz, hiHz });

  const path3 = { x, y, z, n: x.length, fs: PADS_FS, seconds: x.length / PADS_FS };
  const family = planeFamily(path3, planes);

  // A pointing device moves in one particular plane and we cannot say which
  // of these it is, so the 2D path shown on screen is the family member with
  // the LARGEST excursion, and every published figure is the floor across all
  // of them. Showing the largest and publishing the smallest is deliberate:
  // the picture should not be milder than the claim.
  let show = family[0], showExtent = -1;
  for (const f of family) {
    const e = Math.max(peakToPeak(f.x), peakToPeak(f.y));
    if (e > showExtent) { showExtent = e; show = f; }
  }

  return {
    x: show.x, y: show.y,
    n: x.length,
    fs: PADS_FS,
    seconds: x.length / PADS_FS,
    hz: spec?.hz ?? null,
    prominence: spec?.prominence ?? null,
    // Rotation invariant: the largest extent in any direction in space,
    // rather than the larger of two arbitrary projections.
    p2pMm: extent3D(path3),
    rmsMm: Math.max(rms(x), rms(y), rms(z)),
    path3,
    family,
    // Total angle the wrist swept, in degrees. Large values mean the
    // de-rotation did real work and that accumulated gyro bias deserves more
    // suspicion, so it is published rather than hidden.
    sweptDeg,
    // The accelerometer channel's mean magnitude, published because it is
    // what decides whether an attitude correction is even applicable.
    gravityG: r.gravityG ?? null,
  };
}

/**
 * The fraction of time the cursor sits inside a square target centred on the
 * point the person is aiming at.
 *
 * This is the probability a click lands, for someone who has already aimed
 * correctly. It is deliberately the most generous possible reading: it
 * assumes perfect aim and charges the tremor only for the excursion around
 * that aim. The real world is worse, because acquiring the target is itself
 * harder. Choosing the generous metric means the finding cannot be dismissed
 * as an artifact of a pessimistic model.
 */
export function holdFraction(path, pxPerMm, targetPx) {
  if (!(targetPx > 0)) throw new Error('holdFraction: targetPx must be positive');
  const h = targetPx / 2;
  let inside = 0;
  for (let i = 0; i < path.n; i++) {
    if (Math.abs(path.x[i] * pxPerMm) <= h && Math.abs(path.y[i] * pxPerMm) <= h) inside++;
  }
  return inside / path.n;
}

/** The smallest target this path never leaves, in pixels. */
export function targetNeverLeft(path, pxPerMm) {
  let m = 0;
  for (let i = 0; i < path.n; i++) {
    m = Math.max(m, Math.abs(path.x[i] * pxPerMm), Math.abs(path.y[i] * pxPerMm));
  }
  return 2 * m;
}

/**
 * The smallest target at which the cursor is inside at least `want` of the
 * time. Answers the question WCAG should have asked: how big does it have to
 * be?
 */
export function targetForHoldRate(path, pxPerMm, want = 0.95, maxPx = 4096) {
  let lo = 1, hi = maxPx;
  if (holdFraction(path, pxPerMm, hi) < want) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (holdFraction(path, pxPerMm, mid) >= want) hi = mid; else lo = mid;
  }
  return hi;
}

/** The full sweep: hit rate for every target size at every sensitivity. */
export function hitCurve(path, {
  cpis = [200, 400, 800, 1200, 1600],
  sizes = [24, 32, 44, 64, 96, 128, 192, 256],
} = {}) {
  return {
    cpis, sizes,
    grid: cpis.map((cpi) => {
      const ppm = cpiToPxPerMm(cpi);
      return {
        cpi,
        pxPerMm: ppm,
        neverLeftPx: targetNeverLeft(path, ppm),
        need95Px: targetForHoldRate(path, ppm, 0.95),
        cells: sizes.map((s) => ({ sizePx: s, hold: holdFraction(path, ppm, s) })),
      };
    }),
  };
}

/**
 * Position at a given wall-clock time, looping, for the live cursor.
 * Linear interpolation between samples so the motion is smooth at any frame
 * rate rather than stepping at the recording's 100 Hz.
 */
export function sampleAt(path, seconds, pxPerMm) {
  const t = ((seconds % path.seconds) + path.seconds) % path.seconds;
  const f = t * path.fs;
  const i = Math.floor(f);
  const frac = f - i;
  const j = (i + 1) % path.n;
  return {
    x: (path.x[i] + (path.x[j] - path.x[i]) * frac) * pxPerMm,
    y: (path.y[i] + (path.y[j] - path.y[i]) * frac) * pxPerMm,
  };
}

/**
 * Where a measured amplitude sits on the MDS-UPDRS clinical ladder.
 *
 * Published for honesty rather than for scoring. It is the difference between
 * saying "a Parkinson's tremor" and saying "a tremor a neurologist would grade
 * as slight", and the second is what our recordings actually are.
 */
export function updrsBand(p2pMm) {
  const cm = p2pMm / 10;
  if (cm < 1) return { grade: 1, label: 'slight', cm, range: 'under 1 cm' };
  if (cm < 3) return { grade: 2, label: 'mild', cm, range: '1 to 3 cm' };
  if (cm < 10) return { grade: 3, label: 'moderate', cm, range: '3 to 10 cm' };
  return { grade: 4, label: 'severe', cm, range: 'over 10 cm' };
}
