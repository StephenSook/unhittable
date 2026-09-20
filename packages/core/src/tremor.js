// tremor.js - turning a real patient's wrist acceleration into the distance
// their hand actually moved.
//
// Input is the PADS corpus on PhysioNet (parkinsons-disease-smartwatch 1.0.0):
// 469 participants, bilateral Apple Watch Series 4, six-axis IMU at 100 Hz,
// recorded during standardised neurological tasks, open access under
// CC BY-NC-SA 4.0. These are real people with real diagnoses, not a slider
// labelled "tremor intensity".
//
// The output is a displacement trace in millimetres, which is the thing a
// pointing task actually cares about.

import { fft, ifft, nextPow2, detrend, hann, spectrum, prominentPeak } from './dsp.js';

export const G = 9.80665;            // m/s^2 per g, exact by definition
export const PADS_FS = 100;          // Hz, stated in the PADS observation metadata

/**
 * Parse one PADS timeseries file.
 *
 * Seven comma-separated columns: Time (s), Accelerometer X/Y/Z (g),
 * Gyroscope X/Y/Z (rad/s). 2048 rows, which is 20.48 s at 100 Hz.
 */
export function parsePadsRecord(text) {
  const lines = text.trim().split('\n');
  const n = lines.length;
  const t = new Float64Array(n);
  const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
  const gx = new Float64Array(n), gy = new Float64Array(n), gz = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const c = lines[i].split(',');
    if (c.length < 7) throw new Error(`PADS row ${i} has ${c.length} columns, expected 7`);
    t[i] = +c[0]; ax[i] = +c[1]; ay[i] = +c[2]; az[i] = +c[3];
    gx[i] = +c[4]; gy[i] = +c[5]; gz[i] = +c[6];
  }
  // The mean acceleration magnitude, which says whether this channel carries
  // gravity. PADS does not: it is roughly 0.001 to 0.14 g here, not ~1 g.
  // Callers use it to decide whether an attitude correction applies at all.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.hypot(ax[i], ay[i], az[i]);
  const gravityG = n ? sum / n : 0;

  return { n, t, ax, ay, az, gx, gy, gz, gravityG };
}

/**
 * Band-limited double integration, done in the frequency domain.
 *
 * Getting displacement from acceleration by summing twice in the time domain
 * is the obvious approach and it is a trap: any constant offset becomes a
 * ramp and then a parabola, so the answer drifts away from the data. The
 * usual patches (high-pass the result, detrend after each pass) are
 * approximate and interact with the band you care about.
 *
 * In the frequency domain integration is exact. Each integration divides by
 * i*omega, so integrating twice multiplies by -1/omega^2:
 *
 *     X_displacement(f) = -X_acceleration(f) / (2*pi*f)^2
 *
 * Drift is the f -> 0 limit of that expression, which is why it blows up, and
 * why band-limiting first is not a cleanup step but a precondition. Zeroing
 * everything outside the tremor band removes the singularity before it can do
 * any damage, and it is also exactly what we want physically: we are asking
 * how far the hand moved BECAUSE OF THE TREMOR, not where the arm drifted to.
 *
 * Returns displacement in metres, same length as the input.
 */
export function accelToDisplacement(accel, fs, { loHz = 3, hiHz = 12 } = {}) {
  const n = accel.length;
  const nfft = nextPow2(n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);

  // NO WINDOW HERE, deliberately, and this is the subtle part.
  //
  // A Hann taper is the right thing for estimating a SPECTRUM, because it
  // trades resolution for leakage and neither of those affects where a peak
  // sits. It is the wrong thing for reconstructing an AMPLITUDE, because the
  // taper multiplies the signal by an envelope that is never removed. An
  // earlier version windowed here, and the recovered displacement then had
  // the Hann shape baked into it: a true 2.000 mm amplitude read as 0.778 mm
  // one fifth of the way into the record and 1.991 mm at the centre.
  //
  // Peak-to-peak survived that almost intact, because the peak lands near the
  // middle where the gain is 1, which is exactly why it went unnoticed. The
  // HOLD FRACTION did not: most of the evaluated record had been pulled
  // toward the centre of the target, so every published hold rate was too
  // generous and the finding looked weaker than it is.
  //
  // Zeroing the out-of-band bins is itself a filter, so the broadband
  // discontinuity at the record's wrap point is largely removed, and the
  // caller discards the first and last fifth where the remainder lands.
  re.set(detrend(accel, Math.min(n - 1, 201)));

  fft(re, im);

  const df = fs / nfft;

  // The band edges are TAPERED, not square.
  //
  // Zeroing bins abruptly is a brick-wall filter, and a brick wall rings. A
  // tone sitting near the cutoff comes back with that ringing added to it: at
  // 7.87 Hz against an 8 Hz edge, a true 4.000 mm peak-to-peak was recovered
  // as 4.663 mm, a 16.6 percent OVER-estimate. Over-estimating is the unsafe
  // direction here, because it inflates our own finding, and our detected
  // tremors run right up to 8 Hz.
  //
  // A raised-cosine transition over a fraction of the band removes it. This is
  // the standard reason filters are not built with square edges, and the
  // earlier validator missed it by testing only frequencies away from the
  // cutoff.
  const taper = Math.max(0.35, (hiHz - loHz) * 0.18);

  // The integration divides by (2*pi*f)^2, so the DC bin and anything close to
  // it blow up. The brick wall used to zero them as a side effect of zeroing
  // everything below the cutoff; a taper does not, and for a band whose
  // transition reaches below zero it let DC straight through with infinite
  // gain and returned NaN for the whole record. A floor is therefore explicit
  // rather than incidental.
  const FLOOR_HZ = Math.max(df, 0.5);

  const ramp = (f) => {
    if (f < FLOOR_HZ) return 0;
    if (f <= loHz - taper || f >= hiHz + taper) return 0;
    if (f >= loHz && f <= hiHz) return 1;
    const d = f < loHz ? (f - (loHz - taper)) / taper : ((hiHz + taper) - f) / taper;
    return 0.5 * (1 - Math.cos(Math.PI * d));
  };

  for (let k = 0; k < nfft; k++) {
    // Real input, so bin k and bin nfft-k are conjugates; fold to a frequency.
    const f = (k <= nfft / 2 ? k : nfft - k) * df;
    const g = ramp(f);
    if (g === 0) { re[k] = 0; im[k] = 0; continue; }
    const w = 2 * Math.PI * f;
    const scale = (-1 / (w * w)) * g;
    re[k] *= scale;
    im[k] *= scale;
  }

  ifft(re, im);
  return re.slice(0, n);
}

/** Convenience: acceleration in g to displacement in millimetres. */
export function accelGToDisplacementMm(accelG, fs, band) {
  const ms2 = Float64Array.from(accelG, (v) => v * G);
  const metres = accelToDisplacement(ms2, fs, band);
  return Float64Array.from(metres, (v) => v * 1000);
}

/**
 * The dominant tremor frequency and how strongly it stands out.
 *
 * `prominence` here is the same measure the camera instrument uses, so a
 * "there is a tremor" judgement is made the same way in both halves of this
 * project. A subject whose strongest line in the band barely clears its own
 * neighbourhood does not have a measurable tremor, and we exclude them rather
 * than pretending every recording contains one.
 */
export function tremorSpectrum(accel, fs, { loHz = 3, hiHz = 15 } = {}) {
  const x = hann(detrend(accel, Math.min(accel.length - 1, 201)));
  const { mag, nfft } = spectrum(x);
  const hzPerBin = fs / nfft;
  const loBin = Math.max(2, Math.round(loHz / hzPerBin));
  const hiBin = Math.min(mag.length - 2, Math.round(hiHz / hzPerBin));
  const p = prominentPeak(mag.subarray(0, hiBin + 2), nfft, { loBin, baselineHalfWidth: 30 });
  if (!p) return null;

  // The curve is returned so a page can DRAW the spectrum it is quoting a
  // peak from. A frequency printed without its spectrum asks the reader to
  // trust that a peak exists; showing the curve lets them see it, or see
  // that it does not.
  const curve = [];
  for (let b = 1; b <= hiBin; b++) curve.push({ hz: b * hzPerBin, mag: mag[b] });

  return { hz: p.cyclesPerSample * fs, prominence: p.prominence, hzPerBin, curve };
}

/** Root-mean-square of a trace, which for displacement is the usual summary. */
export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Peak-to-peak excursion, which is what actually makes you miss a button. */
export function peakToPeak(x) {
  let lo = Infinity, hi = -Infinity;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo;
}

/**
 * Hand millimetres to screen pixels.
 *
 * This is the one genuinely underdetermined step in the chain and it is
 * labelled rather than buried. A mouse reports counts per inch, the operating
 * system then applies its own pointer acceleration curve, and the result
 * depends on hardware and settings we cannot know. So this is a PARAMETER to
 * be swept, not a constant to be asserted, and every result this project
 * publishes is reported as a function of it.
 *
 * The default corresponds to 800 CPI with no acceleration, which is a common
 * default: 800 counts per 25.4 mm is 31.5 px per mm.
 */
export function mmToPx(mm, pxPerMm = 800 / 25.4) {
  return mm * pxPerMm;
}
