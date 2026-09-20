// analyse.js - your own hand, through the same core as everything else.
//
// The functions imported here are the identical files the website, the scan
// API and the 121-test suite use. Nothing about the measurement is
// reimplemented for the phone, so a number here and a number on the site
// cannot disagree.

import { tremorSpectrum, accelGToDisplacementMm, peakToPeak, rms } from '@unhittable/core/tremor.js';
import { holdFractionRect, scaleForHoldRect } from '@unhittable/core/geometry.js';
import { G } from './capture.js';
import { MM_PER_CSS_PX, WCAG_MIN_MM, WCAG_ENHANCED_MM } from './theme.js';

/** The band. Wide enough for essential tremor, which runs to 12 Hz. */
export const BAND = { loHz: 3, hiHz: 12 };

/**
 * Turn a resampled recording into a tremor measurement and the target size it
 * implies.
 *
 * On a TOUCHSCREEN the millimetre-to-target mapping is direct: a finger that
 * moves one millimetre is one millimetre off the point it was aiming at.
 * There is no counts-per-inch and no pointer acceleration curve, which makes
 * this the cleaner half of the measurement and the reason the phone is worth
 * building rather than being a port of the website.
 */
export function analyse(grid, { mmPerDp }) {
  // Units. expo DeviceMotion reports m/s^2; the core expects g.
  const toG = (arr) => Float64Array.from(arr, (v) => v / G);
  const magnitude = Float64Array.from({ length: grid.n }, (_, i) =>
    Math.hypot(grid.x[i], grid.y[i], grid.z[i]) / G);

  const spec = tremorSpectrum(magnitude, grid.fs, BAND);

  const dx = accelGToDisplacementMm(toG(grid.x), grid.fs, BAND);
  const dy = accelGToDisplacementMm(toG(grid.y), grid.fs, BAND);
  const a = Math.floor(grid.n * 0.2), b = Math.ceil(grid.n * 0.8);
  const x = dx.slice(a, b), y = dy.slice(a, b);
  const path = { x, y, n: x.length, fs: grid.fs, seconds: x.length / grid.fs };

  const p2pMm = Math.max(peakToPeak(x), peakToPeak(y));
  const rmsMm = Math.max(rms(x), rms(y));

  // One millimetre of finger travel is one millimetre on the glass, so the
  // conversion to device-independent pixels is the screen's own geometry and
  // nothing else.
  const dpPerMm = 1 / mmPerDp;
  const wcagDp = WCAG_MIN_MM * dpPerMm;
  const enhancedDp = WCAG_ENHANCED_MM * dpPerMm;

  const holdAtWcag = holdFractionRect(path, dpPerMm, wcagDp, wcagDp);
  const holdAtEnhanced = holdFractionRect(path, dpPerMm, enhancedDp, enhancedDp);
  const k = scaleForHoldRect(path, dpPerMm, wcagDp, wcagDp, 0.95);
  const needMm = k === null ? null : WCAG_MIN_MM * k;

  return {
    path,
    hz: spec?.hz ?? null,
    prominence: spec?.prominence ?? null,
    // The same bar the 260-subject cohort used. Zero of 2,300 null draws
    // reached it, so below this we say "no detectable tremor" rather than
    // printing a frequency that is really noise.
    detectable: (spec?.prominence ?? 0) >= 5,
    p2pMm, rmsMm,
    fs: grid.fs,
    measuredHz: grid.measuredHz,
    belowNyquist: grid.belowNyquist,
    wcagDp, enhancedDp,
    holdAtWcag, holdAtEnhanced,
    needMm,
    needDp: needMm === null ? null : needMm * dpPerMm,
    needCssPx: needMm === null ? null : needMm / MM_PER_CSS_PX,
  };
}
