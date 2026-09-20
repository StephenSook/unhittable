// Built from RAW expo payloads, because the previous mapping was written from
// the field NAMES and the names do not mean the same thing on both platforms.
// A test that starts from pre-normalised gx/gy/gz arrays cannot catch that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationRateToBodyAxes, hasRotationRate } from '../src/axes.js';

const DEG = Math.PI / 180;
const close = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

test('iOS: alpha is the device Z axis and gamma is X, per the installed Swift', () => {
  // DeviceMotionModule.swift:107
  //   "alpha": radiansToDegrees(rotationRate.z)
  //   "beta":  radiansToDegrees(rotationRate.y)
  //   "gamma": radiansToDegrees(rotationRate.x)
  const w = rotationRateToBodyAxes({ alpha: 30, beta: 20, gamma: 10 }, 'ios');
  assert.ok(close(w.x, 10 * DEG), 'gamma must become x');
  assert.ok(close(w.y, 20 * DEG), 'beta must become y');
  assert.ok(close(w.z, 30 * DEG), 'alpha must become z');
});

test('Android: alpha is the device X axis and gamma is Z, per the installed Kotlin', () => {
  // DeviceMotionModule.kt:239
  //   putDouble("alpha", toDegrees(values[0]))   // gyro X
  //   putDouble("beta",  toDegrees(values[1]))   // gyro Y
  //   putDouble("gamma", toDegrees(values[2]))   // gyro Z
  const w = rotationRateToBodyAxes({ alpha: 30, beta: 20, gamma: 10 }, 'android');
  assert.ok(close(w.x, 30 * DEG), 'alpha must become x');
  assert.ok(close(w.y, 20 * DEG), 'beta must become y');
  assert.ok(close(w.z, 10 * DEG), 'gamma must become z');
});

test('THE BUG: the two platforms disagree, so one mapping cannot serve both', () => {
  // An earlier version used beta -> x, gamma -> y, alpha -> z on both. That
  // swapped x and y on iOS and cyclically shifted all three on Android, and
  // it would have fed the attitude filter rotations about the wrong axes,
  // adding error where it was meant to remove it, without throwing anything.
  const payload = { alpha: 1, beta: 2, gamma: 3 };
  const ios = rotationRateToBodyAxes(payload, 'ios');
  const android = rotationRateToBodyAxes(payload, 'android');
  assert.ok(!close(ios.x, android.x), 'x must differ between platforms, or the mapping is not platform aware');
  assert.ok(close(ios.y, android.y), 'y is beta on both');
  assert.ok(!close(ios.z, android.z), 'z must differ too');
});

test('degrees become radians, because the core works in radians', () => {
  // Both native modules call a toDegrees conversion before emitting. Missing
  // this is a silent factor of 57.
  const w = rotationRateToBodyAxes({ alpha: 180, beta: 0, gamma: 0 }, 'android');
  assert.ok(close(w.x, Math.PI), `180 deg/s should be pi rad/s, got ${w.x}`);
});

test('a single-axis rotation stays on a single axis', () => {
  for (const platform of ['ios', 'android']) {
    for (const field of ['alpha', 'beta', 'gamma']) {
      const w = rotationRateToBodyAxes({ [field]: 45 }, platform);
      const nonZero = [w.x, w.y, w.z].filter((v) => Math.abs(v) > 1e-15);
      assert.equal(nonZero.length, 1,
        `${platform} ${field} leaked onto ${nonZero.length} axes`);
      assert.ok(close(nonZero[0], 45 * DEG));
    }
  }
});

test('a missing or empty payload is zero rather than NaN', () => {
  for (const bad of [null, undefined, {}]) {
    const w = rotationRateToBodyAxes(bad, 'ios');
    assert.deepEqual(w, { x: 0, y: 0, z: 0 });
  }
  assert.equal(hasRotationRate(null), false);
  assert.equal(hasRotationRate({}), false);
  assert.equal(hasRotationRate({ alpha: 0, beta: 0, gamma: 0 }), false,
    'an all-zero payload is not evidence of a gyroscope');
  assert.equal(hasRotationRate({ alpha: 0, beta: 0.01, gamma: 0 }), true);
});
