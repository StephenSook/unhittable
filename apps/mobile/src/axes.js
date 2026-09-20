// axes.js - expo reports rotation rate on different axes per platform.
//
// This is the kind of defect that produces a worse result than doing nothing,
// silently. A wrong axis mapping feeds the attitude filter rotations about
// the wrong axes, so it adds error where it was meant to remove it, and
// nothing crashes or looks unusual.
//
// VERIFIED AGAINST THE INSTALLED SOURCE rather than the documentation, which
// does not state this.
//
//   node_modules/expo-sensors/ios/DeviceMotionModule.swift:107
//     "alpha": radiansToDegrees(rotationRate.z),
//     "beta":  radiansToDegrees(rotationRate.y),
//     "gamma": radiansToDegrees(rotationRate.x),
//
//   .../android/.../DeviceMotionModule.kt:239
//     putDouble("alpha", toDegrees(values[0]))   // Android gyro X
//     putDouble("beta",  toDegrees(values[1]))   // Android gyro Y
//     putDouble("gamma", toDegrees(values[2]))   // Android gyro Z
//
// So alpha is the device's Z on iOS and its X on Android. Beta is Y on both.
// Reading beta as X, which an earlier version did, swapped two axes on iOS
// and cyclically shifted all three on Android.
//
// Both platforms report DEGREES per second. The core works in radians, and
// getting that wrong would be a silent factor of 57.

const DEG_TO_RAD = Math.PI / 180;

/**
 * Map an expo `rotationRate` payload onto the device's own x, y, z axes, in
 * radians per second, matching the axes its accelerometer reports on.
 *
 * @param {{alpha?: number, beta?: number, gamma?: number}|null} r
 * @param {'ios'|'android'|string} platform
 */
export function rotationRateToBodyAxes(r, platform) {
  if (!r) return { x: 0, y: 0, z: 0 };
  const a = r.alpha ?? 0, b = r.beta ?? 0, g = r.gamma ?? 0;
  const body = platform === 'ios'
    ? { x: g, y: b, z: a }      // alpha is z, gamma is x
    : { x: a, y: b, z: g };     // alpha is x, gamma is z
  return {
    x: body.x * DEG_TO_RAD,
    y: body.y * DEG_TO_RAD,
    z: body.z * DEG_TO_RAD,
  };
}

/** Did this payload carry any rotation at all? */
export function hasRotationRate(r) {
  if (!r) return false;
  return [r.alpha, r.beta, r.gamma].some((v) => typeof v === 'number' && v !== 0);
}
