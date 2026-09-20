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
//    the web spec says +9.81. The world frame is defined by the record's own
//    mean acceleration, so no convention is hardcoded anywhere.
//
// 4. ROTATION IS REMOVED HERE, AND UNLIKE THE DATASET IT HAS TO BE. The
//    phone reports accelerationIncludingGravity, which CARRIES gravity, so a
//    wrist that turns in place changes how much gravity falls on each axis
//    and fabricates apparent movement: five degrees is worth 1.75 mm. The
//    clinical recordings do not have this problem because their channel is
//    already gravity-free, but this one does, so the gyroscope is recorded
//    alongside and used to rotate into a frame where gravity is constant.

import { Platform } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import { rotationRateToBodyAxes, hasRotationRate } from './axes.js';

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
    const gx = [], gy = [], gz = [];
    const started = Date.now();
    let sub = null;
    let timer = null;

    const stop = () => {
      if (sub) { sub.remove(); sub = null; }
      if (timer) { clearInterval(timer); timer = null; }
    };

    let rotationSamples = 0;
    sub = DeviceMotion.addListener((d) => {
      // accelerationIncludingGravity is the field present on every platform,
      // and it is the one we want: the attitude filter needs gravity in order
      // to know which way is down.
      const a = d.accelerationIncludingGravity ?? d.acceleration;
      if (!a || typeof a.x !== 'number') return;
      t.push(Date.now() - started);
      ax.push(a.x); ay.push(a.y); az.push(a.z ?? 0);
      // Platform-dependent axis mapping and degrees to radians, both
      // verified against the installed native source. See axes.js.
      if (hasRotationRate(d.rotationRate)) rotationSamples++;
      const w = rotationRateToBodyAxes(d.rotationRate, Platform.OS);
      gx.push(w.x); gy.push(w.y); gz.push(w.z);
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
        // COVERAGE, not presence. One non-zero sample in a thousand is a
        // mostly zero-filled stream, and zeros look to the filter exactly
        // like a wrist that is not turning.
        const gyroCoverage = t.length ? rotationSamples / t.length : 0;
        resolve({ t, ax, ay, az, gx, gy, gz, gyroCoverage, hasGyro: gyroCoverage >= 0.8, seconds: elapsed });
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
export function resample({ t, ax, ay, az, gx, gy, gz, hasGyro, gyroCoverage }) {
  const n = t.length;
  const spanS = (t[n - 1] - t[0]) / 1000;
  if (!(spanS > 0)) throw new Error('The samples carry no elapsed time.');
  const measuredHz = (n - 1) / spanS;

  // Snap to a sane grid: never claim more resolution than arrived.
  const gridHz = Math.max(20, Math.min(120, Math.round(measuredHz)));
  const count = Math.floor(spanS * gridHz);
  const out = {
    x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
    gx: new Float64Array(count), gy: new Float64Array(count), gz: new Float64Array(count),
  };

  let j = 0;
  for (let i = 0; i < count; i++) {
    const want = t[0] + (i * 1000) / gridHz;
    while (j < n - 2 && t[j + 1] < want) j++;
    const span = t[j + 1] - t[j];
    const f = span > 0 ? (want - t[j]) / span : 0;
    out.x[i] = ax[j] + (ax[j + 1] - ax[j]) * f;
    out.y[i] = ay[j] + (ay[j + 1] - ay[j]) * f;
    out.z[i] = az[j] + (az[j + 1] - az[j]) * f;
    if (gx) {
      out.gx[i] = gx[j] + (gx[j + 1] - gx[j]) * f;
      out.gy[i] = gy[j] + (gy[j + 1] - gy[j]) * f;
      out.gz[i] = gz[j] + (gz[j + 1] - gz[j]) * f;
    }
  }

  return {
    ...out,
    n: count,
    fs: gridHz,
    measuredHz,
    hasGyro: !!hasGyro,
    gyroCoverage: gyroCoverage ?? 0,
    // Below twice the top of the tremor band, the measurement is not
    // trustworthy and the UI says so rather than printing a number.
    belowNyquist: gridHz < 24,
  };
}
