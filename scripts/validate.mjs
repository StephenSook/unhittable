// validate.mjs - prove the measurement chain against answers known in advance.
//
// This exists because METHOD.md used to publish an accuracy figure that no
// code in this repository computed. A number in a document that nothing
// generates is a claim, and it stays green after the algorithm changes
// underneath it. This script produces every accuracy figure the docs quote,
// CI runs it, and a regression fails the build rather than the reader.
//
// Usage: node scripts/validate.mjs [--json]

import { accelGToDisplacementMm, tremorSpectrum } from '../packages/core/src/tremor.js';
import { removeRotation } from '../packages/core/src/attitude.js';

const G = 9.80665;
const FS = 100;
const N = 1024;
const json = process.argv.includes('--json');

const retained = (d) => {
  const a = Math.floor(d.length * 0.2), b = Math.ceil(d.length * 0.8);
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i < b; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
  return { p2p: hi - lo, lo, hi };
};

/** A pure translation of known amplitude, expressed as the acceleration it implies. */
function syntheticTranslation(f0, ampMm) {
  const w = 2 * Math.PI * f0;
  return Float64Array.from({ length: N }, (_, i) => -(w * w) * ampMm * Math.sin((w * i) / FS) / 1000 / G);
}

const results = { amplitude: [], flatness: [], frequency: [], rotation: [], worstAmplitudeErrPct: 0 };

// ---- 1. Amplitude recovery across the clinical band and four decades of size
for (const f0 of [3.5, 4, 5, 6, 7, 8, 10, 12]) {
  for (const ampMm of [0.05, 0.5, 2, 10]) {
    const d = accelGToDisplacementMm(syntheticTranslation(f0, ampMm), FS, { loHz: 3, hiHz: 13 });
    const got = retained(d).p2p;
    const truth = 2 * ampMm;
    const errPct = ((got - truth) / truth) * 100;
    results.amplitude.push({ f0, truthMm: truth, recoveredMm: got, errPct });
    results.worstAmplitudeErrPct = Math.max(results.worstAmplitudeErrPct, Math.abs(errPct));
  }
}

// ---- 2. Flatness. The property the Hann bug broke, and the one peak-to-peak
//         cannot see, so it is measured separately and explicitly.
for (const f0 of [4, 5, 7]) {
  const d = accelGToDisplacementMm(syntheticTranslation(f0, 2), FS, { loHz: 3, hiHz: 13 });
  const at = (frac) => { const i = Math.floor(N * frac); return retained(d.slice(i - 25, i + 25)).p2p / 2; };
  const edge = Math.min(at(0.22), at(0.78)), centre = at(0.5);
  results.flatness.push({ f0, edgeMm: edge, centreMm: centre, ratio: edge / centre });
}

// ---- 3. Frequency recovery
for (const f0 of [3.5, 4.3, 5.05, 6.2, 7.9, 11.4]) {
  const x = Float64Array.from({ length: N }, (_, i) => 0.05 * Math.sin(2 * Math.PI * f0 * i / FS));
  const s = tremorSpectrum(x, FS, { loHz: 2, hiHz: 15 });
  results.frequency.push({ f0, recovered: s.hz, errHz: s.hz - f0, prominence: s.prominence });
}

// ---- 4. Rotation rejection: the defect that nearly invalidated the project
for (const deg of [1, 2, 5, 10]) {
  const th = (deg * Math.PI) / 180, w = 2 * Math.PI * 5;
  const rec = { n: N, ax: new Float64Array(N), ay: new Float64Array(N), az: new Float64Array(N),
                gx: new Float64Array(N), gy: new Float64Array(N), gz: new Float64Array(N) };
  for (let i = 0; i < N; i++) {
    const t = i / FS, theta = th * Math.sin(w * t);
    rec.ay[i] = Math.sin(theta); rec.az[i] = Math.cos(theta); rec.gx[i] = th * w * Math.cos(w * t);
  }
  const before = retained(accelGToDisplacementMm(rec.ay, FS, { loHz: 3, hiHz: 12 })).p2p;
  const world = removeRotation(rec, FS);
  const after = Math.max(
    retained(accelGToDisplacementMm(world.ex, FS, { loHz: 3, hiHz: 12 })).p2p,
    retained(accelGToDisplacementMm(world.ey, FS, { loHz: 3, hiHz: 12 })).p2p);
  results.rotation.push({ deg, apparentBeforeMm: before, residualAfterMm: after, rejection: before / after });
}

if (json) { console.log(JSON.stringify(results, null, 2)); }
else {
  const f = (x, n = 3) => Number(x).toFixed(n);
  console.log('AMPLITUDE RECOVERY, pure translation of known size');
  console.log('   f0 Hz   true p2p mm   recovered mm    error %');
  for (const r of results.amplitude) {
    console.log(`  ${String(r.f0).padStart(5)}   ${f(r.truthMm).padStart(11)}   ${f(r.recoveredMm).padStart(12)}   ${f(r.errPct, 2).padStart(8)}`);
  }
  console.log(`\n  worst absolute amplitude error: ${f(results.worstAmplitudeErrPct, 2)} %`);

  console.log('\nFLATNESS across the retained window, which peak-to-peak cannot see');
  console.log('   f0 Hz    edge mm   centre mm    ratio');
  for (const r of results.flatness) {
    console.log(`  ${String(r.f0).padStart(5)}   ${f(r.edgeMm).padStart(8)}   ${f(r.centreMm).padStart(9)}   ${f(r.ratio).padStart(6)}`);
  }

  console.log('\nFREQUENCY RECOVERY');
  console.log('   true Hz   recovered   error Hz   prominence');
  for (const r of results.frequency) {
    console.log(`  ${String(r.f0).padStart(8)}   ${f(r.recovered, 2).padStart(9)}   ${f(r.errHz, 3).padStart(8)}   ${f(r.prominence, 1).padStart(10)}`);
  }

  console.log('\nROTATION REJECTION, a tilting wrist that does not translate at all');
  console.log('   tilt deg   apparent before mm   residual after mm   rejection');
  for (const r of results.rotation) {
    console.log(`  ${String(r.deg).padStart(8)}   ${f(r.apparentBeforeMm).padStart(18)}   ${f(r.residualAfterMm).padStart(17)}   ${f(r.rejection, 1).padStart(9)}x`);
  }
}

// ---- gates. CI runs this, so a regression fails the build, not the reader.
const fail = [];
if (results.worstAmplitudeErrPct > 8) fail.push(`amplitude error ${results.worstAmplitudeErrPct.toFixed(2)}% exceeds 8%`);
for (const r of results.flatness) if (r.ratio < 0.93) fail.push(`flatness ${r.ratio.toFixed(3)} at ${r.f0} Hz: an envelope has returned`);
for (const r of results.frequency) if (Math.abs(r.errHz) > 0.25) fail.push(`frequency error ${r.errHz.toFixed(3)} Hz at ${r.f0} Hz`);
for (const r of results.rotation) if (r.rejection < 4) fail.push(`rotation rejection only ${r.rejection.toFixed(1)}x at ${r.deg} deg`);

if (fail.length) { console.error('\nVALIDATION FAILED:\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('\nvalidation passed');
