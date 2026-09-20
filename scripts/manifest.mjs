// manifest.mjs - describe the shipped recordings using MEASURED values.
//
// The manifest is generated rather than typed, so a label on the page cannot
// disagree with what the analysis actually found. Every number below comes
// from cohort.json, which comes from scripts/cohort.mjs, which reads the same
// committed .txt files the browser downloads.

import fs from 'node:fs';
import path from 'node:path';
import { recordingToPath } from '../packages/core/src/replay.js';
import { cpiToCssPxPerMm, holdFractionRect, scaleForHoldRect, WCAG_MIN_PX } from '../packages/core/src/geometry.js';

const DATA = 'packages/core/data';
const COHORT = JSON.parse(fs.readFileSync('apps/web/data/cohort.json', 'utf8'));
const byKey = new Map(COHORT.primary.records.map((r) => [`${r.subject}_${r.task}_${r.wrist}`, r]));

// Read the condition for every subject straight out of the dataset's own
// patient files, so a label is never something we decided.
const CONDITIONS = (() => {
  const dir = '/tmp/pads_wide/patients';
  const m = new Map();
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) {
    const mm = /^patient_(\d+)\.json$/.exec(f);
    if (mm) m.set(mm[1], JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).condition);
  }
  return m;
})();

const TASK_LABEL = {
  StretchHold: 'arms outstretched, held',
  LiftHold: 'forearms raised, held',
  HoldWeight: 'holding a weight, arms out',
};

const ppm = cpiToCssPxPerMm(800);
const records = [];

for (const file of fs.readdirSync(DATA).filter((f) => f.endsWith('.txt') && f !== 'LICENSE-DATA.txt').sort()) {
  const [subject, task, wrist] = file.replace('.txt', '').split('_');
  const p = recordingToPath(fs.readFileSync(path.join(DATA, file), 'utf8'));
  const measured = byKey.get(`${subject}_${task}_${wrist}`) || null;
  const clears = !!measured;
  const hold24 = holdFractionRect(p, ppm, WCAG_MIN_PX, WCAG_MIN_PX);
  const k = scaleForHoldRect(p, ppm, WCAG_MIN_PX, WCAG_MIN_PX, 0.95);

  records.push({
    file,
    subject,
    task,
    taskLabel: TASK_LABEL[task] ?? task,
    wrist: wrist === 'LeftWrist' ? 'left' : 'right',
    condition: CONDITIONS.get(subject) ?? null,
    samplingRateHz: 100,
    hz: +p.hz.toFixed(2),
    prominence: +p.prominence.toFixed(1),
    // Does this recording contain an oscillation a null draw could not fake?
    // Reported for every recording, including the ones where the answer is
    // no, because "most recordings contain no detectable tremor" is a finding
    // and hiding it would make the shipped set look like the whole dataset.
    detectable: clears,
    p2pMm: +p.p2pMm.toFixed(3),
    rmsMm: +p.rmsMm.toFixed(3),
    cursorPxAt800: +(p.p2pMm * ppm).toFixed(1),
    hold24At800: +hold24.toFixed(4),
    need95PxAt800: k === null ? null : Math.round(WCAG_MIN_PX * k),
  });
}

const manifest = {
  generatedBy: 'scripts/manifest.mjs',
  generatedAt: new Date().toISOString().slice(0, 10),
  dataset: 'PADS: Parkinson\'s Disease Smartwatch dataset',
  citation: 'Varghese et al., npj Parkinson\'s Disease, 2024',
  url: 'https://physionet.org/content/parkinsons-disease-smartwatch/1.0.0/',
  license: 'CC BY-NC-SA 4.0',
  device: 'Apple Watch Series 4, bilateral, 100 Hz',
  note: 'Rest-tremor tasks are excluded on purpose. Holding a mouse is a postural act and rest tremor is suppressed by it, so including those recordings would raise every number here while measuring the wrong thing.',
  records,
};

fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${records.length} recordings`);
for (const r of records) {
  console.log(`  ${r.file.padEnd(34)} ${String(r.condition).padEnd(18)} ${r.hz.toFixed(2)}Hz prom ${String(r.prominence).padStart(5)} ${r.detectable ? 'DETECTABLE' : 'below bar '} ${r.p2pMm.toFixed(3)}mm  ${r.cursorPxAt800.toFixed(0).padStart(4)}px  hold24 ${(r.hold24At800 * 100).toFixed(0).padStart(3)}%  need ${r.need95PxAt800}px`);
}
