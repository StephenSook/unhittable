// capture.js - record the phone's own accelerometer honestly.
//
// Three things decide whether this measurement is real rather than
// plausible, and all three are handled here rather than assumed.
//
// 1. THE SAMPLE RATE IS MEASURED, NEVER ASSUMED. setUpdateInterval is a
//    request. iOS passes it to CoreMotion, which honours what the hardware
//    supports. Android delivers on a Choreographer frame and, without the
//    HIGH_SAMPLING_RATE_SENSORS permission declared in the manifest,
//    registers the sensor at SENSOR_DELAY_NORMAL, which is 5 Hz. Tremor runs
//    to 12 Hz, so a 5 Hz stream is below Nyquist for the whole band and
//    produces a confident, aliased, wrong answer. We declare the permission
//    AND we report the rate we actually got.
//
// 2. DELIVERY JITTERS, so samples are resampled onto a uniform grid from
//    their own timestamps before any spectral work. An FFT assumes even
//    spacing and quietly smears the peak when it does not get it.
//
// 3. THE SIGN CONVENTION DIFFERS BETWEEN PLATFORMS and we refuse to depend on
//    it. iOS Safari and expo both report roughly -9.81 on z when face up;
//    the web spec says +9.81. Band-limiting to the tremor band removes the
//    gravity term entirely, so the disagreement cannot reach the result.

import { DeviceMotion } from 'expo-sensors';

export const G = 9.80665;
export const TARGET_HZ = 100;
export const DURATION_S = 10;

/**
 * Record for `seconds`, reporting progress. Resolves with the raw samples and
 * the rate that was actually achieved.
 */
export function record({ seconds = DURATION_S, onProgress } = {}) {
  return new Promise(async (resolve, reject) => {
    const available = await DeviceMotion.isAvailableAsync().catch(() => false);
    if (!available) return reject(new Error('This device has no motion sensor available to the app.'));

    DeviceMotion.setUpdateInterval(1000 / TARGET_HZ);

    const t = [], ax = [], ay = [], az = [];
    const started = Date.now();
    let sub = null;
    let timer = null;

    const stop = () => {
      if (sub) { sub.remove(); sub = null; }
      if (timer) { clearInterval(timer); timer = null; }
    };

    sub = DeviceMotion.addListener((d) => {
      // accelerationIncludingGravity is the field present on every platform.
      // acceleration needs sensor fusion and can be absent, or present and
      // identically zero, on a device without a usable gyroscope.
      const a = d.accelerationIncludingGravity ?? d.acceleration;
      if (!a || typeof a.x !== 'number') return;
      t.push(Date.now() - started);
      ax.push(a.x); ay.push(a.y); az.push(a.z ?? 0);
    });

    timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      onProgress?.({
        elapsed: Math.min(elapsed, seconds),
        remaining: Math.max(0, seconds - elapsed),
        samples: t.length,
        hz: elapsed > 0.5 ? t.length / elapsed : null,
      });
      if (elapsed >= seconds) {
        stop();
        if (t.length < 64) return reject(new Error(`Only ${t.length} samples arrived in ${seconds} seconds. The sensor is not delivering data.`));
        resolve({ t, ax, ay, az, seconds: elapsed });
      }
    }, 100);
  });
}

/**
 * Resample irregularly delivered samples onto a uniform grid by linear
 * interpolation, and return the grid's true rate.
 *
 * The measured rate is returned rather than the requested one, because every
 * figure downstream depends on it and reporting 100 Hz while receiving 47 is
 * the kind of error that produces a wrong frequency with no warning.
 */
export function resample({ t, ax, ay, az }) {
  const n = t.length;
  const spanS = (t[n - 1] - t[0]) / 1000;
  if (!(spanS > 0)) throw new Error('The samples carry no elapsed time.');
  const measuredHz = (n - 1) / spanS;

  // Snap to a sane grid: never claim more resolution than arrived.
  const gridHz = Math.max(20, Math.min(120, Math.round(measuredHz)));
  const count = Math.floor(spanS * gridHz);
  const out = { x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count) };

  let j = 0;
  for (let i = 0; i < count; i++) {
    const want = t[0] + (i * 1000) / gridHz;
    while (j < n - 2 && t[j + 1] < want) j++;
    const span = t[j + 1] - t[j];
    const f = span > 0 ? (want - t[j]) / span : 0;
    out.x[i] = ax[j] + (ax[j + 1] - ax[j]) * f;
    out.y[i] = ay[j] + (ay[j + 1] - ay[j]) * f;
    out.z[i] = az[j] + (az[j + 1] - az[j]) * f;
  }

  return {
    ...out,
    n: count,
    fs: gridHz,
    measuredHz,
    // Below twice the top of the tremor band, the measurement is not
    // trustworthy and the UI says so rather than printing a number.
    belowNyquist: gridHz < 24,
  };
}
