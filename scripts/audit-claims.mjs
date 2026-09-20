// audit-claims.mjs - the judge-facing surfaces must agree with one another.
//
// An adversarial review found four live contradictions at once: the prose said
// 48 plane projections while the code used 24, the README said 121 tests while
// the deck said 149, the cohort file described two different methods in
// adjacent fields, and a historical section read as current behaviour.
//
// The previous guard searched for a handful of substrings, which passes
// happily on a document that contradicts itself, because the number it looks
// for is present somewhere. This compares LABELLED values and, for figures
// that appear as bare numbers, asserts that no superseded value survives
// anywhere.
//
// Run: node scripts/audit-claims.mjs

import fs from 'node:fs';

const facts = JSON.parse(fs.readFileSync('docs/facts.json', 'utf8'));
const SURFACES = [
  'README.md',
  'docs/METHOD.md',
  'docs/FACTS.md',
  'docs/FALSE-GREENS.md',
  'docs/PRIOR-ART.md',
  'docs/deck/slides.html',
  'apps/web/src/index.html',
];

const text = Object.fromEntries(
  SURFACES.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]));

const problems = [];
const note = (f, msg) => problems.push(`${f}: ${msg}`);

/** A figure that must appear, in at least one surface, in its current form. */
function mustAppear(label, forms, where) {
  const found = where.filter((f) => text[f] && forms.some((v) => text[f].includes(v)));
  if (found.length === 0) note(where.join(', '), `no current value for ${label} (expected one of ${forms.join(' / ')})`);
}

/** A superseded figure that must appear NOWHERE. */
function mustNotAppear(label, forms) {
  for (const [f, s] of Object.entries(text)) {
    // FALSE-GREENS is a record of past errors: quoting a superseded figure is
    // the point there, and the file says so at the top.
    if (f === 'docs/FALSE-GREENS.md') continue;
    for (const v of forms) {
      if (s.includes(v)) note(f, `superseded ${label}: "${v}"`);
    }
  }
}

const c = facts.corpus, k = facts.cohort;
const comma = (n) => n.toLocaleString('en-US');

if (c) {
  mustAppear('corpus control count', [comma(c.controls), String(c.controls)],
    ['README.md', 'docs/FACTS.md', 'docs/deck/slides.html', 'apps/web/src/index.html']);
  mustAppear('unhittable percentage', [`${c.unhittablePct}%`, `${c.unhittablePct} percent`],
    ['README.md', 'docs/FACTS.md', 'docs/deck/slides.html', 'apps/web/src/index.html']);
  mustAppear('median control size', [`${c.medianW} × ${c.medianH}`, `${c.medianW} by ${c.medianH}`, `${c.medianW}&times;${c.medianH}`],
    ['README.md', 'docs/FACTS.md', 'docs/deck/slides.html']);
  mustAppear('bound-by-height count', [comma(c.boundByHeight), String(c.boundByHeight)],
    ['README.md', 'docs/FACTS.md', 'docs/deck/slides.html']);
}

mustAppear('plane count', [`${facts.planes} plane`, `${facts.planes} projections`, `across ${facts.planes}`],
  ['README.md', 'docs/METHOD.md', 'apps/web/src/index.html']);
mustAppear('cohort wider-than-target', [`${k.widerThanTarget} of 52`, `${k.widerThanTarget}</div>`],
  ['README.md', 'docs/deck/slides.html']);
mustAppear('cohort median amplitude', [`${k.medianAmplitudeMm} mm`, `${k.medianAmplitudeMm}<`],
  ['README.md', 'docs/FACTS.md', 'docs/deck/slides.html']);

// Values that were once published and must not survive anywhere.
mustNotAppear('plane count', ['48 plane projections', 'across 48 plane', 'floor across 12 azimuths', '12 azimuths']);
mustNotAppear('test count', ['121 tests', '138 tests', '146 tests', '149 tests']);
mustNotAppear('corpus size', ['3,881 ', '3,842 ', '3,918 ', '3,921 ', '7,723']);
mustNotAppear('unhittable pct', ['74.1%', '73.9%', '72.1%', '71.7%', '78.8%']);

// The test count has one true value: whatever the suite reports.
const suiteFiles = ['packages/core/test', 'apps/api/test', 'apps/mobile/test'];
const testCount = suiteFiles.reduce((a, d) => a + (fs.existsSync(d)
  ? fs.readdirSync(d).filter((f) => f.endsWith('.mjs')).length : 0), 0);
if (testCount === 0) problems.push('no test files found, which cannot be right');

if (problems.length) {
  console.error('CLAIM AUDIT FAILED:\n  ' + problems.join('\n  '));
  console.error('\nRegenerate with: node --env-file=.env scripts/facts.mjs, then update the surfaces.');
  process.exit(1);
}
console.log(`claim audit passed across ${Object.keys(text).length} judge-facing surfaces`);
