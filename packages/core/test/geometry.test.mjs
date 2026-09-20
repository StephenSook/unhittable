// Geometry is where an accessibility tool earns or loses its standing, so
// every case below was computed by hand first and the expected value written
// into the assertion before the code was run. Where a case is a boundary, the
// boundary is stated in the comment in pixels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WCAG_MIN_PX, WCAG_ENHANCED_PX, SPACING_RADIUS_PX,
  cpiToCssPxPerMm, holdFractionRect, axisHoldFraction, minimumBox,
  scaleForHoldRect, circleIntersectsRect, circlesIntersect, meetsSizeMinimum,
  evaluateSpacing, judgeElement, summarise, holdSquare,
} from '../src/geometry.js';
import { recordingToPath, holdFraction, cpiToPxPerMm } from '../src/replay.js';

const REC = new URL('../data/006_StretchHold_RightWrist.txt', import.meta.url);
const path = recordingToPath(fs.readFileSync(REC, 'utf8'));

test('the published constants are the published ones', () => {
  assert.equal(WCAG_MIN_PX, 24);            // SC 2.5.8 Level AA
  assert.equal(WCAG_ENHANCED_PX, 44);       // SC 2.5.5 Level AAA
  assert.equal(SPACING_RADIUS_PX, 12);      // a 24 px DIAMETER circle
});

test('cpi to CSS px per mm accounts for display scaling and refuses nonsense', () => {
  // At scale 1 a CSS pixel is a device pixel, so this must agree exactly with
  // the device-space conversion the replay layer already uses.
  assert.equal(cpiToCssPxPerMm(800), cpiToPxPerMm(800));
  // Windows at 150% scaling: the same hand movement covers two thirds as many
  // CSS pixels, which makes targets EASIER to hold when measured in CSS px.
  assert.ok(Math.abs(cpiToCssPxPerMm(1200, { scale: 1.5 }) - 1200 / 25.4 / 1.5) < 1e-12);
  assert.ok(cpiToCssPxPerMm(800, { scale: 2 }) < cpiToCssPxPerMm(800, { scale: 1 }));
  assert.throws(() => cpiToCssPxPerMm(0), /positive/);
  assert.throws(() => cpiToCssPxPerMm(800, { scale: 0 }), /positive/);
});

// --------------------------------------------------------------------------
// Primitives. Tangency is the boundary that decides real pages, so it is
// pinned explicitly in both directions.
// --------------------------------------------------------------------------

test('circle versus rectangle, including exact tangency', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(circleIntersectsRect(5, 5, 1, rect), 'a circle inside the rect intersects it');
  assert.ok(circleIntersectsRect(-2, 5, 3, rect), 'overlapping from the left');
  // Centre 12 px left of the left edge with radius 12: touches at exactly one
  // point. The standard says the circles must not INTERSECT, and a tangent is
  // not an intersection, so this must pass.
  assert.equal(circleIntersectsRect(-12, 5, 12, rect), false, 'exact tangency is not intersection');
  assert.ok(circleIntersectsRect(-11.99, 5, 12, rect), 'a hundredth of a pixel closer does intersect');
  // Corner case in the literal sense: nearest point is the corner (0,0).
  // Distance from (-6,-8) to (0,0) is 10.
  assert.equal(circleIntersectsRect(-6, -8, 10, rect), false, 'tangent at a corner');
  assert.ok(circleIntersectsRect(-6, -8, 10.01, rect), 'just past tangent at a corner');
});

test('circle versus circle, including exact tangency', () => {
  assert.ok(circlesIntersect(0, 0, 12, 23, 0, 12), 'centres 23 apart, radii sum 24');
  assert.equal(circlesIntersect(0, 0, 12, 24, 0, 12), false, 'centres exactly 24 apart are tangent');
  assert.ok(circlesIntersect(0, 0, 12, 0, 0, 1), 'concentric');
});

test('the size minimum is inclusive at exactly 24', () => {
  assert.ok(meetsSizeMinimum({ x: 0, y: 0, w: 24, h: 24 }));
  assert.equal(meetsSizeMinimum({ x: 0, y: 0, w: 23.99, h: 24 }), false);
  assert.equal(meetsSizeMinimum({ x: 0, y: 0, w: 24, h: 23.99 }), false);
  assert.ok(meetsSizeMinimum({ x: 0, y: 0, w: 400, h: 24 }), 'wide and exactly tall enough');
});

// --------------------------------------------------------------------------
// The Spacing exception. This is the half of SC 2.5.8 that tools skip.
// --------------------------------------------------------------------------

test('two small targets far apart both earn the spacing exception', () => {
  // 16x16 boxes at x=100 and x=200. Centres (108,108) and (208,108), 100 px
  // apart, so the two 12 px circles clear each other by a wide margin, and
  // circle A's nearest approach to box B is 200-108 = 92 px.
  const rects = [
    { x: 100, y: 100, w: 16, h: 16 },
    { x: 200, y: 100, w: 16, h: 16 },
  ];
  const s = evaluateSpacing(rects);
  assert.ok(s[0].spacingApplies && s[0].spacingPass, 'A should pass by spacing');
  assert.ok(s[1].spacingApplies && s[1].spacingPass, 'B should pass by spacing');
  assert.deepEqual(s[0].blockedBy, []);
});

test('two small targets crowded together both lose the exception', () => {
  // 16x16 at x=100 and x=118. Centres (108,108) and (126,108) are 18 px apart,
  // under the 24 px sum of radii, so the circles intersect. Circle A also
  // reaches box B: nearest point (118,108) is 10 px away, under 12.
  const rects = [
    { x: 100, y: 100, w: 16, h: 16 },
    { x: 118, y: 100, w: 16, h: 16 },
  ];
  const s = evaluateSpacing(rects);
  assert.equal(s[0].spacingPass, false);
  assert.equal(s[1].spacingPass, false);
  assert.deepEqual(s[0].blockedBy, [1]);
  assert.deepEqual(s[1].blockedBy, [0]);
});

test('a COMPLIANT neighbour blocks the exception with its bounding box', () => {
  // The asymmetry most implementations get wrong. A large target has no
  // circle of its own, but an undersized target's circle must still clear the
  // large target's BOX.
  //
  // Small 10x10 at (100,100), centre (105,105), radius 12 reaches x=117.
  // Large 40x40 starting at x=115 therefore intrudes by 2 px.
  const blocked = evaluateSpacing([
    { x: 100, y: 100, w: 10, h: 10 },
    { x: 115, y: 100, w: 40, h: 40 },
  ]);
  assert.equal(blocked[0].spacingPass, false, 'the small target is blocked by a compliant neighbour');
  assert.deepEqual(blocked[0].blockedBy, [1]);
  assert.equal(blocked[1].spacingApplies, false, 'the large target is judged on size, not spacing');
  assert.equal(blocked[1].spacingPass, true);

  // Slide the large target right so its edge sits at exactly 117: tangent, so
  // by the standard's wording the exception survives.
  const tangent = evaluateSpacing([
    { x: 100, y: 100, w: 10, h: 10 },
    { x: 117, y: 100, w: 40, h: 40 },
  ]);
  assert.equal(tangent[0].spacingPass, true, 'tangency preserves the exception');
});

test('a single small target on an empty page earns the exception', () => {
  const s = evaluateSpacing([{ x: 0, y: 0, w: 8, h: 8 }]);
  assert.ok(s[0].spacingApplies && s[0].spacingPass);
});

test('evaluateSpacing returns one verdict per input, in order', () => {
  const rects = Array.from({ length: 7 }, (_, i) => ({ x: i * 500, y: 0, w: 12, h: 12 }));
  const s = evaluateSpacing(rects);
  assert.equal(s.length, 7);
  assert.ok(s.every((e) => e.spacingPass));
});

// --------------------------------------------------------------------------
// Rectangles under a real recording.
// --------------------------------------------------------------------------

test('a square rectangle agrees exactly with the square-target function', () => {
  const ppm = cpiToPxPerMm(800);
  for (const s of [12, 24, 44, 96]) {
    assert.equal(holdFractionRect(path, ppm, s, s), holdFraction(path, ppm, s));
    assert.equal(holdSquare(path, ppm, s), holdFraction(path, ppm, s));
  }
});

test('the joint hold can never exceed either marginal hold', () => {
  // Being inside the box is the intersection of two events, so this is a
  // property of probability rather than of this recording, and it must hold
  // for every shape tried.
  const ppm = cpiToPxPerMm(800);
  for (const [w, h] of [[24, 24], [180, 20], [20, 180], [300, 44], [8, 600]]) {
    const joint = holdFractionRect(path, ppm, w, h);
    const mx = axisHoldFraction(path, ppm, w, 'x');
    const my = axisHoldFraction(path, ppm, h, 'y');
    assert.ok(joint <= mx + 1e-12 && joint <= my + 1e-12,
      `joint ${joint} exceeded a marginal (${mx}, ${my}) for ${w}x${h}`);
  }
});

test('REAL DATA: a wide short button fails on its short axis', () => {
  // The shape a square minimum cannot describe. 180x20 is an ordinary primary
  // button. It is generous horizontally and too short vertically, and the
  // report has to say which.
  const ppm = cpiToPxPerMm(800);
  const wide = { x: 0, y: 0, w: 180, h: 20 };
  const j = judgeElement(wide, { spacingApplies: false, spacingPass: true }, path, ppm);
  assert.ok(j.holdX > j.holdY, 'the long axis must be the easier one');
  assert.equal(j.limitingAxis, 'y');
  assert.equal(j.sizeOk, false, '20 px tall is under the 24 px minimum');
});

test('axis hold rises with extent and reaches one when the axis is huge', () => {
  const ppm = cpiToPxPerMm(800);
  let prev = -1;
  for (const e of [4, 8, 16, 32, 64, 128, 512, 4096]) {
    const h = axisHoldFraction(path, ppm, e, 'x');
    assert.ok(h >= prev - 1e-12, `hold fell from ${prev} to ${h} at extent ${e}`);
    prev = h;
  }
  assert.equal(prev, 1, 'a very wide axis must hold the whole recording');
});

test('minimumBox is the box the path never leaves', () => {
  const n = 720, R = 10;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; x[i] = R * Math.cos(a); y[i] = R * Math.sin(a) / 2; }
  const circle = { x, y, n, fs: 100, seconds: n / 100 };
  const b = minimumBox(circle, 1);
  assert.ok(Math.abs(b.wPx - 2 * R) < 1e-6);
  assert.ok(Math.abs(b.hPx - R) < 1e-6, 'a flattened ellipse needs half the height');
  assert.ok(Math.abs(holdFractionRect(circle, 1, b.wPx, b.hPx) - 1) < 1e-9);
});

test('scaleForHoldRect returns a factor that actually achieves the rate', () => {
  const ppm = cpiToPxPerMm(800);
  const el = { x: 0, y: 0, w: 120, h: 32 };
  const k = scaleForHoldRect(path, ppm, el.w, el.h, 0.95);
  assert.ok(k, 'a factor must exist for a bounded recording');
  assert.ok(holdFractionRect(path, ppm, el.w * k, el.h * k) >= 0.95, 'the factor must reach the rate');
  assert.ok(holdFractionRect(path, ppm, el.w * k * 0.9, el.h * k * 0.9) < 0.95, 'and must be near the boundary');
});

test('scaleForHoldRect preserves aspect ratio', () => {
  const ppm = cpiToPxPerMm(800);
  const k = scaleForHoldRect(path, ppm, 200, 20, 0.9);
  const jr = judgeElement({ x: 0, y: 0, w: 200, h: 20 }, { spacingApplies: false, spacingPass: true }, path, ppm, { want: 0.9 });
  assert.ok(Math.abs(jr.needWPx / jr.needHPx - 200 / 20) < 1e-9, 'the shape must not change');
  assert.ok(Math.abs(jr.scaleNeeded - k) < 1e-9);
});

// --------------------------------------------------------------------------
// The verdict, and the case the whole project exists to surface.
// --------------------------------------------------------------------------

test('REAL DATA: a target can satisfy the standard and still be unhittable', () => {
  const ppm = cpiToPxPerMm(800);
  // Exactly the minimum the standard permits, so the standard says PASS.
  const j = judgeElement({ x: 0, y: 0, w: 24, h: 24 }, { spacingApplies: false, spacingPass: true }, path, ppm);
  assert.equal(j.sizeOk, true);
  assert.equal(j.wcagPass, true);
  assert.ok(j.hold < 0.5, `a conforming 24 px target held ${(j.hold * 100).toFixed(0)}% of the time`);
  assert.equal(j.passesStandardButNotHand, true);
});

test('REAL DATA: a large enough target satisfies both', () => {
  const ppm = cpiToPxPerMm(800);
  const j = judgeElement({ x: 0, y: 0, w: 400, h: 400 }, { spacingApplies: false, spacingPass: true }, path, ppm);
  assert.equal(j.wcagPass, true);
  assert.equal(j.hold, 1);
  assert.equal(j.passesStandardButNotHand, false);
  assert.ok(j.scaleNeeded <= 1, 'an oversized target needs no enlargement');
});

test('summarise reports the median correctly for odd and even counts', () => {
  const mk = (hold) => ({ hold, wcagPass: true, passesStandardButNotHand: hold < 0.95 });
  assert.equal(summarise([mk(0.1), mk(0.5), mk(0.9)]).medianHold, 0.5);
  assert.equal(summarise([mk(0.2), mk(0.4), mk(0.6), mk(0.8)]).medianHold, 0.5);
  const s = summarise([mk(0.1), mk(0.99)]);
  assert.equal(s.n, 2);
  assert.equal(s.worstHold, 0.1);
  assert.equal(s.bestHold, 0.99);
  assert.equal(s.handPass, 1);
  assert.equal(s.passesStandardButNotHand, 1);
});

test('summarise refuses to invent numbers for an empty page', () => {
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.equal(s.medianHold, null);
  assert.equal(s.worstHold, null);
});

test('holdFractionRect refuses a non-positive extent', () => {
  assert.throws(() => holdFractionRect(path, 1, 0, 10), /positive/);
  assert.throws(() => holdFractionRect(path, 1, 10, -1), /positive/);
  assert.throws(() => axisHoldFraction(path, 1, 0), /positive/);
});
