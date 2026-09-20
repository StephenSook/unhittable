// build-web.mjs - assemble the publishable site.
//
// There is no bundler and no transpiler. This copies files. The reason it
// exists at all is that the core lives in one place in the repository and is
// imported by the browser, the API and the tests from that one place, so the
// published site needs a copy of it laid out where the page's import
// specifiers point. Assembling rather than duplicating in git means a change
// to the core cannot leave a stale copy behind on the site.

import fs from 'node:fs';
import path from 'node:path';

const OUT = '_site';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'core', 'data'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

let count = 0;
const copy = (from, to) => { fs.copyFileSync(from, to); count++; };

for (const f of fs.readdirSync('apps/web/src')) copy(path.join('apps/web/src', f), path.join(OUT, f));
for (const f of fs.readdirSync('packages/core/src')) {
  if (f.endsWith('.js')) copy(path.join('packages/core/src', f), path.join(OUT, 'core', f));
}
for (const f of fs.readdirSync('packages/core/data')) copy(path.join('packages/core/data', f), path.join(OUT, 'core/data', f));
for (const f of fs.readdirSync('apps/web/data')) copy(path.join('apps/web/data', f), path.join(OUT, 'data', f));

// GitHub Pages runs Jekyll by default, which silently drops files and
// directories beginning with an underscore.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Fail loudly rather than publishing a site missing the thing it imports.
const required = [
  'index.html', 'app.css', 'app.js',
  'core/replay.js', 'core/geometry.js', 'core/tremor.js', 'core/dsp.js',
  'core/data/manifest.json', 'data/cohort.json',
];
const missing = required.filter((r) => !fs.existsSync(path.join(OUT, r)));
if (missing.length) {
  console.error(`build-web: these files are missing from ${OUT}:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// Every module the page imports must exist. A typo in an import specifier is
// otherwise a blank page that the build reports as a success.
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const entries = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel) || /^https?:/.test(rel)) continue;
  seen.add(rel);
  const file = path.join(OUT, rel);
  if (!fs.existsSync(file)) { console.error(`build-web: ${rel} is imported but not published`); process.exit(1); }
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
}

const bytes = fs.readdirSync(OUT, { recursive: true })
  .map((f) => path.join(OUT, f))
  .filter((f) => fs.statSync(f).isFile())
  .reduce((a, f) => a + fs.statSync(f).size, 0);

console.log(`${OUT}: ${count} files, ${(bytes / 1024).toFixed(0)} KB, ${seen.size} modules resolved`);
