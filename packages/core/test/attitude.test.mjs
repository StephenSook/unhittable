// The distinguishing test. A wrist that TURNS and a hand that MOVES produce
// similar-looking accelerometer records, and the whole claim of this project
// depends on telling them apart. Each case below is synthesised so the true
// answer is known exactly before the code runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { removeRotation, rotate, quaternionBetween } from '../src/attitude.js';
import { parsePadsRecord } from '../src/tremor.js';
const require = createRequire(import.meta.url);
import { accelGToDisplacementMm } from '../src/tremor.js';

const FS = 100, N = 1024, F0 = 5.0, W = 2 * Math.PI * F0;

/** Peak-to-peak of the part the production path actually keeps. */
function retainedP2P(d) {
  const a = Math.floor(d.length * 0.2), b = Math.ceil(d.length * 0.8);
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i < b; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
  return hi - lo;
}

/**
 * A device rotating about its x axis by theta(t), translating not at all.
 * Gravity is a unit vector, so the body reads [0, sin(theta), cos(theta)],
 * and the gyroscope reads the true angular rate.
 */
function rotatingOnly(thetaDeg) {
  const th = (thetaDeg * Math.PI) / 180;
  const ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N);
  const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    const theta = th * Math.sin(W * t);
    ax[i] = 0; ay[i] = Math.sin(theta); az[i] = Math.cos(theta);
    gx[i] = th * W * Math.cos(W * t);            // d(theta)/dt
  }
  return { ax, ay, az, gx, gy, gz, n: N };
}

/** A device translating along world x by X0*sin(wt), never rotating. */
function translatingOnly(mm) {
  const X0 = mm / 2;                              // amplitude, so p2p is `mm`
  const ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N);
  const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    ax[i] = -(W * W) * X0 * Math.sin(W * t) / 1000 / 9.80665;   // mm/s^2 -> g
    ay[i] = 0; az[i] = 1;
  }
  return { ax, ay, az, gx, gy, gz, n: N };
}

test('quaternionBetween handles the parallel and antiparallel corners', () => {
  assert.deepEqual(quaternionBetween([0, 0, 1], [0, 0, 1]), [1, 0, 0, 0]);
  const flip = quaternionBetween([0, 0, 1], [0, 0, -1]);
  const v = rotate(flip, [0, 0, 1]);
  assert.ok(Math.abs(v[2] + 1) < 1e-9, 'an antiparallel pair must still rotate correctly');
  const q = quaternionBetween([1, 0, 0], [0, 1, 0]);
  const r = rotate(q, [1, 0, 0]);
  assert.ok(Math.hypot(r[0] - 0, r[1] - 1, r[2] - 0) < 1e-9);
});

test('THE CONFOUND: pure rotation reads as real movement before correction', () => {
  // This is the defect an adversarial review found, reproduced here so the
  // fix below has something to be measured against.
  const rec = rotatingOnly(5);
  const uncorrected = accelGToDisplacementMm(rec.ay, FS, { loHz: 3, hiHz: 12 });
  const apparent = retainedP2P(uncorrected);
  assert.ok(apparent > 1.5,
    `a 5 degree rotation with zero translation should fabricate over 1.5 mm, got ${apparent.toFixed(3)}`);
});

test('THE FIX: the gyroscope removes it, and what is left is nearly nothing', () => {
  const rec = rotatingOnly(5);
  const w = removeRotation(rec, FS);
  const dx = accelGToDisplacementMm(w.ex, FS, { loHz: 3, hiHz: 12 });
  const dy = accelGToDisplacementMm(w.ey, FS, { loHz: 3, hiHz: 12 });
  const residual = Math.max(retainedP2P(dx), retainedP2P(dy));

  const uncorrected = retainedP2P(accelGToDisplacementMm(rec.ay, FS, { loHz: 3, hiHz: 12 }));
  assert.ok(residual < uncorrected / 5,
    `correction must remove most of the artefact: ${uncorrected.toFixed(3)} mm became ${residual.toFixed(3)} mm`);
  assert.ok(residual < 0.4,
    `a stationary rotating wrist must not read as a third of a millimetre of travel, got ${residual.toFixed(3)} mm`);
  assert.ok(w.tiltDeg > 3, `the filter should notice roughly 5 degrees of tilt, saw ${w.tiltDeg.toFixed(1)}`);
});

test('AND IT KEEPS THE SIGNAL: real translation survives the correction', () => {
  // The obvious way to pass the test above is to destroy everything. This is
  // the other half of the distinguishing prediction.
  const rec = translatingOnly(4.0);
  const w = removeRotation(rec, FS);
  const dx = accelGToDisplacementMm(w.ex, FS, { loHz: 3, hiHz: 12 });
  const dy = accelGToDisplacementMm(w.ey, FS, { loHz: 3, hiHz: 12 });
  const recovered = Math.max(retainedP2P(dx), retainedP2P(dy));
  assert.ok(Math.abs(recovered - 4.0) / 4.0 < 0.12,
    `a true 4 mm translation must survive, recovered ${recovered.toFixed(3)} mm`);
  assert.ok(w.tiltDeg < 2, `nothing rotated, so tilt should stay small, saw ${w.tiltDeg.toFixed(2)}`);
});

test('BOTH AT ONCE: the translation is recovered and the rotation is not counted', () => {
  const rot = rotatingOnly(5);
  const tr = translatingOnly(4.0);
  const mixed = {
    n: N,
    ax: Float64Array.from({ length: N }, (_, i) => rot.ax[i] + tr.ax[i]),
    ay: Float64Array.from({ length: N }, (_, i) => rot.ay[i]),
    az: Float64Array.from({ length: N }, (_, i) => rot.az[i]),
    gx: rot.gx, gy: rot.gy, gz: rot.gz,
  };
  const w = removeRotation(mixed, FS);
  const dx = accelGToDisplacementMm(w.ex, FS, { loHz: 3, hiHz: 12 });
  const dy = accelGToDisplacementMm(w.ey, FS, { loHz: 3, hiHz: 12 });
  const recovered = Math.hypot(retainedP2P(dx), retainedP2P(dy));
  // The honest bar: the answer must be much closer to the 4 mm of real
  // movement than to the 4 + 1.75 mm an uncorrected pipeline would report.
  assert.ok(recovered > 3.3 && recovered < 5.0,
    `expected roughly the 4 mm that was really there, got ${recovered.toFixed(3)} mm`);
  assert.ok(w.rotationShare > 0.05,
    `the correction should report that it removed something, share was ${w.rotationShare.toFixed(3)}`);
});

test('a record with no gyroscope degrades rather than throwing', () => {
  // PADS always carries a gyroscope, but a phone recording might not, and a
  // missing channel must not crash the pipeline.
  const rec = translatingOnly(4.0);
  const w = removeRotation({ ax: rec.ax, ay: rec.ay, az: rec.az, n: N }, FS);
  assert.equal(w.n, N);
  assert.ok(Number.isFinite(w.gravityG));
});

test('THE PRECONDITION: real PADS records do NOT carry gravity, and the filter refuses them', () => {
  // The defect this pins is the worst one this project had. The attitude
  // filter assumed the accelerometer carried gravity, because gravity is the
  // only thing that fixes an absolute vertical. PADS ships a gravity-FREE
  // channel, the way CoreMotion's userAcceleration does.
  //
  // Every synthetic test above passes because it INJECTS a 1 g vector. They
  // validated a case the production data never presents, and the filter ran
  // on real records deriving attitude from a few thousandths of a g of noise,
  // reporting 73 degrees of tilt on a stationary wrist.
  //
  // So: assert the fact about the data, and assert that the function refuses
  // rather than quietly producing a number.
  const fs = require('node:fs');
  const dir = new URL('../data/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') && f !== 'LICENSE-DATA.txt');
  assert.ok(files.length >= 6, 'the shipped recordings must be present');

  for (const f of files) {
    const r = parsePadsRecord(fs.readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(r.gravityG < 0.6,
      `${f} has mean |a| = ${r.gravityG.toFixed(4)} g. If this ever approaches 1 the channel ` +
      `has changed and the attitude question must be reopened.`);
    assert.throws(() => removeRotation(r, 100), /does not carry gravity/,
      `${f} must be refused by the attitude filter, not silently processed`);
  }
});

test('and the filter still works where gravity IS present, which is the phone', () => {
  // Refusing everything would be the lazy way to pass the test above.
  const rec = rotatingOnly(5);                 // synthetic, gravity-bearing
  const w = removeRotation(rec, FS);
  assert.ok(w.gravityG > 0.9 && w.gravityG < 1.1);
  assert.ok(w.tiltDeg > 3);
});
