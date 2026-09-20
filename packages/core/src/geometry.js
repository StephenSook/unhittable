// geometry.js - what a recorded tremor does to a real rendered element.
//
// The replay layer answers "can this hand hold a square of side N". A real web
// page is not squares. It is rectangles, mostly wide and short, sitting next to
// each other, and the standard that governs them has an exception built out of
// circles. This module is the honest version of the question.
//
// Everything here is pure: rectangles in, numbers out. It is imported by the
// browser, by the scan API and by the test suite from the same file.

import { holdFraction } from './replay.js';

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA. */
export const WCAG_MIN_PX = 24;
/** WCAG 2.2 SC 2.5.5 Target Size (Enhanced), Level AAA. */
export const WCAG_ENHANCED_PX = 44;
/** Radius of the circle the Spacing exception is built from: 24 px diameter. */
export const SPACING_RADIUS_PX = WCAG_MIN_PX / 2;

/**
 * Counts per inch to CSS pixels per millimetre of hand movement.
 *
 * This is the one genuinely undetermined link in the chain, and it is worse
 * than a single unknown constant because the answer depends on the operating
 * system. A mouse reports counts per inch. On macOS the pointer delta is
 * expressed in points, so display backing scale does not enter. On Windows
 * with pointer acceleration disabled a count moves one physical pixel, so a
 * page at 150% display scaling sees two thirds as many CSS pixels of travel.
 * The OS acceleration curve sits on top of both and is user-configurable.
 *
 * So this function takes the scaling explicitly and every result built on it
 * is published as a sweep rather than as a number. `scale` is CSS pixels per
 * physical pixel: 1 for an unscaled display, 1.5 for Windows at 150%, 2 for a
 * Retina panel driven in physical pixels.
 */
export function cpiToCssPxPerMm(cpi, { scale = 1 } = {}) {
  if (!(cpi > 0)) throw new Error('cpiToCssPxPerMm: cpi must be positive');
  if (!(scale > 0)) throw new Error('cpiToCssPxPerMm: scale must be positive');
  return cpi / 25.4 / scale;
}

/**
 * Fraction of the recording the cursor spends inside a w-by-h rectangle
 * centred on the point the person is aiming at.
 *
 * Same generous reading as the square case: perfect aim is assumed and the
 * tremor is charged only for the excursion around it. Real acquisition is
 * harder.
 */
export function holdFractionRect(path, pxPerMm, wPx, hPx) {
  if (!(wPx > 0) || !(hPx > 0)) throw new Error('holdFractionRect: extents must be positive');
  const hw = wPx / 2, hh = hPx / 2;
  let inside = 0;
  for (let i = 0; i < path.n; i++) {
    if (Math.abs(path.x[i] * pxPerMm) <= hw && Math.abs(path.y[i] * pxPerMm) <= hh) inside++;
  }
  return inside / path.n;
}

/**
 * Marginal hold along ONE axis, ignoring the other.
 *
 * Reported separately because it is the finding a square minimum cannot
 * express: a 180 by 20 button is generous horizontally and fails vertically,
 * and one number for "target size" hides which axis is the problem. These are
 * MARGINAL probabilities. They do not multiply to the joint hold unless the
 * two axes are independent, which for a tremor they are not, so the joint
 * figure from holdFractionRect is the one that is true.
 */
export function axisHoldFraction(path, pxPerMm, extentPx, axis = 'x') {
  if (!(extentPx > 0)) throw new Error('axisHoldFraction: extent must be positive');
  const v = axis === 'y' ? path.y : path.x;
  const h = extentPx / 2;
  let inside = 0;
  for (let i = 0; i < path.n; i++) if (Math.abs(v[i] * pxPerMm) <= h) inside++;
  return inside / path.n;
}

/** The smallest axis-aligned box this path never leaves, in pixels. */
export function minimumBox(path, pxPerMm) {
  let mx = 0, my = 0;
  for (let i = 0; i < path.n; i++) {
    const ax = Math.abs(path.x[i] * pxPerMm), ay = Math.abs(path.y[i] * pxPerMm);
    if (ax > mx) mx = ax;
    if (ay > my) my = ay;
  }
  return { wPx: 2 * mx, hPx: 2 * my };
}

/**
 * How much bigger this exact element would have to be, keeping its aspect
 * ratio, to be held `want` of the time. Returns the multiplier, or null if
 * even a very large version cannot reach the rate, which cannot happen for a
 * bounded recording but is checked rather than assumed.
 *
 * Aspect ratio is preserved because that is the change a designer can actually
 * make to an existing component without redrawing the layout.
 */
export function scaleForHoldRect(path, pxPerMm, wPx, hPx, want = 0.95, maxScale = 4096) {
  if (holdFractionRect(path, pxPerMm, wPx * maxScale, hPx * maxScale) < want) return null;
  let lo = 1e-6, hi = maxScale;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (holdFractionRect(path, pxPerMm, wPx * mid, hPx * mid) >= want) hi = mid; else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// WCAG 2.2 SC 2.5.8, implemented rather than approximated.
//
// The criterion is not "at least 24 by 24". It is "at least 24 by 24 EXCEPT"
// followed by five exceptions, and the first of them is geometric:
//
//   Spacing: Undersized targets (those less than 24 by 24 CSS pixels) are
//   positioned so that if a 24 CSS pixel diameter circle is centered on the
//   bounding box of each, the circles do not intersect another target or the
//   circle for another undersized target.
//
// A tool that checks only the size half reports failures the standard does not
// make, which is how an accessibility tool loses the room. Both halves are
// implemented here and both are tested against hand-computed cases.
// ---------------------------------------------------------------------------

/** Centre of a {x, y, w, h} rectangle. */
function centreOf(r) {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

/** Does a circle overlap an axis-aligned rectangle? Tangency is not overlap. */
export function circleIntersectsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** Do two circles overlap? Tangency is not overlap. */
export function circlesIntersect(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by;
  const sum = ar + br;
  return dx * dx + dy * dy < sum * sum;
}

/** Is this rectangle at least 24 by 24 CSS pixels? */
export function meetsSizeMinimum(rect, min = WCAG_MIN_PX) {
  return rect.w >= min && rect.h >= min;
}

/**
 * Evaluate the Spacing exception for every target on a page.
 *
 * Input is the full list of targets, because the exception is a property of
 * the arrangement and cannot be decided one element at a time. Returns one
 * entry per input target, in the same order.
 *
 * Note the asymmetry in the standard, which is easy to get wrong: an
 * undersized target's circle must clear every OTHER TARGET'S BOUNDING BOX,
 * including targets that are themselves large enough, and additionally must
 * clear the CIRCLE of any other undersized target. A sized neighbour therefore
 * blocks the exception with its box, not with a circle it does not have.
 */
export function evaluateSpacing(rects, { min = WCAG_MIN_PX } = {}) {
  const r = SPACING_RADIUS_PX;
  const undersized = rects.map((t) => !meetsSizeMinimum(t, min));
  const centres = rects.map(centreOf);

  return rects.map((t, i) => {
    if (!undersized[i]) return { spacingApplies: false, spacingPass: true, blockedBy: [] };
    const { cx, cy } = centres[i];
    const blockedBy = [];
    for (let j = 0; j < rects.length; j++) {
      if (j === i) continue;
      if (circleIntersectsRect(cx, cy, r, rects[j])) { blockedBy.push(j); continue; }
      if (undersized[j] && circlesIntersect(cx, cy, r, centres[j].cx, centres[j].cy, r)) blockedBy.push(j);
    }
    return { spacingApplies: true, spacingPass: blockedBy.length === 0, blockedBy };
  });
}

// ---------------------------------------------------------------------------
// ROTATION INVARIANCE.
//
// The world frame recovered in attitude.js has a well-determined vertical,
// because gravity supplies it, and an ARBITRARY azimuth, because recovering
// compass heading would need a magnetometer the dataset does not carry. So
// the horizontal PLANE is real, and the split of a tremor between "x" and "y"
// inside that plane is not.
//
// That matters here and nowhere else in the project. A square target does not
// care. A 141 by 30 button cares a great deal, and an earlier version of the
// report named the limiting axis as "width" or "height" using coordinates
// that a different arbitrary rotation would have swapped.
//
// Two honest replacements:
//
//   - Hold on a rectangle is evaluated over many azimuths and the WORST is
//     published. An accessibility floor should assume the unlucky alignment,
//     and unlike a single arbitrary choice it is a quantity that does not move
//     when the frame does.
//   - The axis that gets named is a property of the ELEMENT, its short side,
//     which is well defined no matter how the tremor is oriented.
// ---------------------------------------------------------------------------

/** Rotate a path in the horizontal plane. Cheap: two multiplies per sample. */
export function rotatePath(path, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const x = new Float64Array(path.n), y = new Float64Array(path.n);
  for (let i = 0; i < path.n; i++) {
    x[i] = path.x[i] * c - path.y[i] * s;
    y[i] = path.x[i] * s + path.y[i] * c;
  }
  return { ...path, x, y };
}

/**
 * Hold over every azimuth, since we cannot know which one is real.
 *
 * Returns the worst, the best and the median. The worst is what the report
 * leads with: it is the conservative reading and it is invariant to the
 * arbitrary choice our frame happens to have made.
 */
export function holdOverAzimuths(path, pxPerMm, wPx, hPx, steps = 36) {
  const holds = [];
  for (let k = 0; k < steps; k++) {
    holds.push(holdFractionRect(rotatePath(path, (Math.PI * k) / steps), pxPerMm, wPx, hPx));
  }
  holds.sort((a, b) => a - b);
  return {
    worst: holds[0],
    best: holds[holds.length - 1],
    median: holds[Math.floor(holds.length / 2)],
    spread: holds[holds.length - 1] - holds[0],
  };
}

/**
 * The largest peak-to-peak extent in ANY direction.
 *
 * max(p2p(x), p2p(y)) is not rotation invariant, so it reports a different
 * amplitude for the same hand depending on an arbitrary choice. This does not.
 */
export function extentOverAzimuths(path, steps = 36) {
  let worst = 0;
  for (let k = 0; k < steps; k++) {
    const r = rotatePath(path, (Math.PI * k) / steps);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < r.n; i++) { if (r.x[i] < lo) lo = r.x[i]; if (r.x[i] > hi) hi = r.x[i]; }
    if (hi - lo > worst) worst = hi - lo;
  }
  return worst;
}

/** Which side of the ELEMENT is the binding constraint. A property of the box. */
export function bindingSide(rect) {
  if (rect.w === rect.h) return null;
  return rect.w < rect.h ? 'width' : 'height';
}

/**
 * The full verdict for one element: what the standard says, and what the
 * recorded hand says. These are deliberately separate fields. We are not
 * redefining conformance and we do not want to be read as doing so. The
 * standard's own answer is reported first and unmodified; ours sits beside it.
 */
export function judgeElement(rect, spacing, pathOrPaths, pxPerMm, { want = 0.95 } = {}) {
  const sizeOk = meetsSizeMinimum(rect);
  const wcagPass = sizeOk || (spacing.spacingApplies && spacing.spacingPass);

  // The caller may pass a pre-rotated family of paths, which is how a scan of
  // eight hundred controls stays fast: the rotations are computed once for
  // the page rather than once per element.
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];

  let worst = Infinity, best = -Infinity, worstPath = paths[0];
  for (const p of paths) {
    const h = holdFractionRect(p, pxPerMm, rect.w, rect.h);
    if (h < worst) { worst = h; worstPath = p; }
    if (h > best) best = h;
  }

  // The PUBLISHED hold is the worst azimuth. Our world frame has a
  // well-determined vertical, from gravity, and an arbitrary rotation about
  // it, because no magnetometer is available to fix a heading. A single
  // reading therefore depends on a choice that carries no physical meaning,
  // and for a wide short control the two ends of that choice can differ by
  // thirty points. An accessibility floor takes the unlucky alignment.
  const hold = worst;
  const scale = scaleForHoldRect(worstPath, pxPerMm, rect.w, rect.h, want);

  return {
    wPx: rect.w,
    hPx: rect.h,
    sizeOk,
    spacingApplies: spacing.spacingApplies,
    spacingPass: spacing.spacingPass,
    wcagPass,
    hold,
    holdBest: best,
    // How much the unknowable azimuth is worth on this control, published so
    // the uncertainty is visible instead of hidden inside a single number.
    holdSpread: best - worst,
    // The side that binds is a property of the ELEMENT, so it survives any
    // rotation of the tremor. An earlier version named a tremor axis instead,
    // which a different arbitrary frame would have swapped.
    bindingSide: bindingSide(rect),
    scaleNeeded: scale,
    needWPx: scale === null ? null : rect.w * scale,
    needHPx: scale === null ? null : rect.h * scale,
    passesStandardButNotHand: wcagPass && hold < want,
  };
}

/**
 * The rotation family a scan judges against. Computed once per page.
 * `steps` of 1 means "do not consider azimuth", which is only correct when
 * the frame's heading is actually known.
 */
export function azimuthFamily(path, steps = 12) {
  if (steps <= 1) return [path];
  const out = [];
  for (let k = 0; k < steps; k++) out.push(rotatePath(path, (Math.PI * k) / steps));
  return out;
}

/** Roll a page's per-element verdicts into the numbers a report leads with. */
export function summarise(judged, { want = 0.95 } = {}) {
  const n = judged.length;
  if (n === 0) {
    return { n: 0, wcagPass: 0, handPass: 0, passesStandardButNotHand: 0, medianHold: null, worstHold: null };
  }
  const holds = judged.map((j) => j.hold).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return {
    n,
    wcagPass: judged.filter((j) => j.wcagPass).length,
    handPass: judged.filter((j) => j.hold >= want).length,
    passesStandardButNotHand: judged.filter((j) => j.passesStandardButNotHand).length,
    medianHold: n % 2 ? holds[mid] : (holds[mid - 1] + holds[mid]) / 2,
    worstHold: holds[0],
    bestHold: holds[n - 1],
  };
}

/** Square-target convenience, so the page and the report share one function. */
export function holdSquare(path, pxPerMm, sizePx) {
  return holdFraction(path, pxPerMm, sizePx);
}

