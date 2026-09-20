// The chain from acceleration to displacement has one closed-form check that
// makes the whole thing verifiable: for simple harmonic motion at frequency f
// with displacement amplitude A, the acceleration amplitude is A*(2*pi*f)^2.
// So we can synthesise an acceleration with a KNOWN displacement behind it and
// assert the pipeline recovers that displacement.
//
// The synthetic signals here are a unit test of an integrator against an
// answer written down in advance. Every claim about a PATIENT is measured on
// the real PADS recordings and reported separately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, ifft, nextPow2 } from '../src/dsp.js';
import {
  G,
  parsePadsRecord,
  accelToDisplacement,
  accelGToDisplacementMm,
  tremorSpectrum,
  rms,
  peakToPeak,
  mmToPx,
} from '../src/tremor.js';

test('ifft inverts fft', () => {
  const n = 256;
  const re = new Float64Array(n), im = new Float64Array(n);
  const orig = new Float64Array(n);
  for (let i = 0; i < n; i++) { orig[i] = Math.sin(i * 0.3) + 0.4 * Math.cos(i * 1.1); re[i] = orig[i]; }
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - orig[i]) < 1e-10, `sample ${i} drifted to ${re[i]}`);
    assert.ok(Math.abs(im[i]) < 1e-10, `imaginary residue ${im[i]} at ${i}`);
  }
});

test('CLOSED FORM: a known 5 Hz, 4 mm motion is recovered from its acceleration', () => {
  const fs = 100, n = 2048;
  const f = 5;              // Hz, inside the Parkinsonian rest-tremor band
  const ampMm = 4;          // millimetres of displacement amplitude
  const ampM = ampMm / 1000;

  // x(t) = A sin(wt)  =>  a(t) = -A w^2 sin(wt)
  const w = 2 * Math.PI * f;
  const accel = new Float64Array(n);
  for (let i = 0; i < n; i++) accel[i] = -ampM * w * w * Math.sin((w * i) / fs);

  const disp = accelToDisplacement(accel, fs, { loHz: 3, hiHz: 12 });

  // The Hann taper suppresses the ends, so compare over the middle where the
  // window is near unity, and divide the window back out.
  const mid = disp.subarray(Math.floor(n * 0.4), Math.floor(n * 0.6));
  const recoveredMm = rms(mid) * 1000 * Math.SQRT2;   // rms to amplitude
  const wCentre = 0.5 * (1 - Math.cos((2 * Math.PI * (n / 2)) / (n - 1)));
  const corrected = recoveredMm / wCentre;

  const errPct = (Math.abs(corrected - ampMm) / ampMm) * 100;
  assert.ok(errPct < 12, `recovered ${corrected.toFixed(2)} mm from a true 4 mm, ${errPct.toFixed(1)}% error`);
});

test('a constant acceleration offset does NOT become a runaway drift', () => {
  // This is the whole reason integration happens in the frequency domain.
  // Summing twice in time turns a DC offset into a parabola; band-limiting
  // first removes the f -> 0 singularity before it can do anything.
  const fs = 100, n = 2048;
  const accel = new Float64Array(n).fill(0.5 * G);   // half a g, constant
  const disp = accelToDisplacement(accel, fs, { loHz: 3, hiHz: 12 });

  const mm = peakToPeak(disp) * 1000;
  assert.ok(mm < 1, `a constant offset produced ${mm.toFixed(3)} mm of excursion`);
});

test('out-of-band motion is rejected, in-band motion is kept', () => {
  const fs = 100, n = 2048;
  const w1 = 2 * Math.PI * 0.4;    // slow arm drift, below the band
  const w2 = 2 * Math.PI * 5;      // tremor, inside the band
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    a[i] = -0.02 * w1 * w1 * Math.sin(w1 * t) + -0.004 * w2 * w2 * Math.sin(w2 * t);
  }
  const withBand = accelToDisplacement(a, fs, { loHz: 3, hiHz: 12 });
  const wideBand = accelToDisplacement(a, fs, { loHz: 0.2, hiHz: 12 });

  // The 2 cm drift dwarfs the 4 mm tremor, so a wide band must show far more
  // excursion than a band that excludes it.
  assert.ok(
    peakToPeak(wideBand) > peakToPeak(withBand) * 3,
    'the band limit is not actually excluding the slow component',
  );
});

test('parsePadsRecord reads the seven documented columns', () => {
  const text = [
    '0.0000000000,0.0024944639,0.0035931196,-0.0019103107,-0.0021300754,0.0080497824,0.0038456670',
    '0.0096659660,0.0043557975,0.0006654288,-0.0008668122,0.0010494720,0.0101928283,0.0027841311',
  ].join('\n');
  const r = parsePadsRecord(text);
  assert.equal(r.n, 2);
  assert.ok(Math.abs(r.t[1] - 0.009665966) < 1e-9);
  assert.ok(Math.abs(r.ax[0] - 0.0024944639) < 1e-12);
  assert.ok(Math.abs(r.gz[1] - 0.0027841311) < 1e-12);
});

test('parsePadsRecord refuses a malformed row rather than guessing', () => {
  assert.throws(() => parsePadsRecord('1,2,3'), /expected 7/);
});

test('tremorSpectrum finds a planted 5.5 Hz line and reports it confidently', () => {
  const fs = 100, n = 2048;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.05 * Math.sin((2 * Math.PI * 5.5 * i) / fs) + 0.002 * Math.sin(i * 7.7);
  const s = tremorSpectrum(a, fs);
  assert.ok(s, 'no tremor line found');
  assert.ok(Math.abs(s.hz - 5.5) < 0.3, `found ${s.hz.toFixed(2)} Hz`);
  assert.ok(s.prominence > 5, `prominence only ${s.prominence.toFixed(1)}`);
});

test('mmToPx is a stated parameter, not a hidden constant', () => {
  // 800 CPI with no acceleration is 800 counts per 25.4 mm.
  assert.ok(Math.abs(mmToPx(25.4) - 800) < 1e-9);
  assert.ok(Math.abs(mmToPx(1, 10) - 10) < 1e-12);
  // Doubling the gain doubles the pixels, which is the sweep this project runs.
  assert.equal(mmToPx(3, 20), mmToPx(3, 10) * 2);
});

test('rms and peakToPeak agree with hand arithmetic on a sinusoid', () => {
  const n = 4096;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 3 * Math.sin((2 * Math.PI * 8 * i) / n);
  assert.ok(Math.abs(rms(x) - 3 / Math.SQRT2) < 0.01, `rms ${rms(x)}`);
  assert.ok(Math.abs(peakToPeak(x) - 6) < 0.01, `p2p ${peakToPeak(x)}`);
});

test('tremorSpectrum returns the curve it took its peak from', () => {
  // A frequency quoted without its spectrum asks a reader to take the peak on
  // trust. The curve has to be the SAME data the peak came from, so the peak
  // must sit at the curve's maximum inside the analysis band.
  const fs = 100, n = 1024, f0 = 5.0;
  const x = Float64Array.from({ length: n }, (_, i) => 0.05 * Math.sin(2 * Math.PI * f0 * i / fs));
  const s = tremorSpectrum(x, fs, { loHz: 2, hiHz: 15 });
  assert.ok(s, 'a clean 5 Hz tone must be detected');
  assert.ok(Array.isArray(s.curve) && s.curve.length > 20, 'the curve must be populated');
  assert.ok(s.curve.every((c) => Number.isFinite(c.hz) && Number.isFinite(c.mag)));
  assert.ok(s.curve[s.curve.length - 1].hz <= 15 + s.hzPerBin, 'the curve must stop at the analysis ceiling');

  const peak = s.curve.reduce((a, b) => (b.mag > a.mag ? b : a));
  assert.ok(Math.abs(peak.hz - s.hz) <= 2 * s.hzPerBin,
    `the reported peak ${s.hz.toFixed(2)} Hz must coincide with the curve maximum ${peak.hz.toFixed(2)} Hz`);
  assert.ok(Math.abs(s.hz - f0) < 0.2, `recovered ${s.hz.toFixed(2)} Hz for a ${f0} Hz input`);
});

test('REGRESSION: recovered amplitude is FLAT across the record, not tapered', () => {
  // The bug this pins: accelToDisplacement used to apply a Hann window before
  // transforming and never removed it, so the recovered displacement carried
  // the window's envelope. A true 2.000 mm amplitude read as 0.778 mm one
  // fifth of the way into the record and 1.991 mm at the centre.
  //
  // Peak-to-peak barely moved, because the peak lands near the middle where
  // the gain is 1. That is precisely why it survived review: the headline
  // amplitude looked right. What it corrupted was the HOLD FRACTION, which
  // integrates over the whole retained record and was therefore reported as
  // more generous than the truth.
  //
  // So this test asserts FLATNESS, not peak-to-peak. Peak-to-peak cannot see
  // this defect and an assertion on it would have passed throughout.
  const fs = 100, n = 1024, f0 = 5.0, A = 2.0;           // 2 mm amplitude, 4 mm p2p
  const w = 2 * Math.PI * f0;
  const accelG = Float64Array.from({ length: n },
    (_, i) => -(w * w) * A * Math.sin((w * i) / fs) / 1000 / 9.80665);

  const d = accelGToDisplacementMm(accelG, fs, { loHz: 3, hiHz: 12 });

  const localAmplitude = (centreFraction) => {
    const i = Math.floor(n * centreFraction);
    const seg = d.slice(i - 25, i + 25);
    let lo = Infinity, hi = -Infinity;
    for (const v of seg) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return (hi - lo) / 2;
  };

  // Across the portion recordingToPath actually keeps, every local amplitude
  // must be the true one. The windowed version failed the first of these by a
  // factor of nearly three.
  const samples = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80].map(localAmplitude);
  for (const [i, a] of samples.entries()) {
    assert.ok(Math.abs(a - A) / A < 0.05,
      `local amplitude ${a.toFixed(3)} mm at position ${[0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80][i]} ` +
      `differs from the true ${A} mm by more than 5%, which means an envelope is present`);
  }

  // And the flatness itself: the ends of the retained window must match its
  // middle. Under the Hann bug this ratio was about 0.39.
  const ratio = Math.min(samples[0], samples[6]) / samples[3];
  assert.ok(ratio > 0.95, `the retained record is tapered: edge/centre amplitude ratio is ${ratio.toFixed(3)}`);
});

test('the spectrum path KEEPS its window, because that is the correct choice there', () => {
  // The fix above must not be over-applied. A taper trades resolution for
  // leakage, and neither affects where a peak sits, so windowing is right for
  // spectral estimation and wrong only for amplitude reconstruction.
  const fs = 100, n = 1024;
  const x = Float64Array.from({ length: n },
    (_, i) => 0.05 * Math.sin(2 * Math.PI * 5 * i / fs) + 0.004 * Math.sin(2 * Math.PI * 9 * i / fs));
  const s = tremorSpectrum(x, fs, { loHz: 2, hiHz: 15 });
  assert.ok(Math.abs(s.hz - 5) < 0.2, `the dominant tone must still be found at 5 Hz, got ${s.hz.toFixed(2)}`);
  assert.ok(s.prominence > 5, 'and it must still stand clear of the floor');
});
