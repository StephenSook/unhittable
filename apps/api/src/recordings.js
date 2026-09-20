// recordings.js - the tremor recordings, loaded once and reused.
//
// Parsing and integrating a recording costs a few milliseconds and the result
// never changes, so it is done at startup. A request that has to wait for
// signal processing before it can even open a browser is a request that times
// out on a cold free-tier instance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordingToPath } from '@unhittable/core/replay.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/core/data');

let cache = null;

export function loadRecordings() {
  if (cache) return cache;
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  const byId = new Map();
  for (const r of manifest.records) {
    const id = r.file.replace(/\.txt$/, '');
    byId.set(id, {
      id,
      meta: r,
      path: recordingToPath(fs.readFileSync(path.join(DATA, r.file), 'utf8')),
    });
  }
  cache = { manifest, byId, ids: [...byId.keys()] };
  return cache;
}

/**
 * The recording a scan uses when the caller does not choose one.
 *
 * Subject 071 is the MEDIAN of the 52 detected tremors by amplitude, rank 26
 * of 52 at 2.640 mm against a cohort median of 3.053 mm.
 *
 * The obvious default was subject 006, the second cleanest tremor in the
 * whole 1,560-recording set, and publishing the corpus figure on it would
 * have described the strongest hand we found as though it were the typical
 * one. This has been re-pinned once already: when the measurement pipeline
 * changed, the previous median stopped being the median, and a default that
 * is only approximately the median makes the word "median" a lie. It is
 * checked against the regenerated cohort rather than assumed to have held.
 */
export const DEFAULT_RECORDING = '071_HoldWeight_RightWrist';

export function getRecording(id) {
  const { byId } = loadRecordings();
  return byId.get(id ?? DEFAULT_RECORDING) ?? null;
}
