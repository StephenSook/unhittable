// taptest.js - close the loop.
//
// The accelerometer PREDICTS a hit rate. This measures the real one, from the
// person's own taps, on the same device, minutes later. Nothing in the
// literature does both halves: the one paper that maps tremor amplitude to
// key size uses population values from the literature and never measures the
// individual, and the one toolkit that enlarges targets for tremor uses a
// boolean rather than an amplitude.
//
// A prediction that is never checked is a claim. This is the check.

/** Build an alternating trial list so fatigue and learning hit both sizes. */
export function buildTrials({ wcagDp, yourDp, rounds = 6 }) {
  const trials = [];
  for (let i = 0; i < rounds; i++) {
    trials.push({ size: wcagDp, label: 'wcag' });
    trials.push({ size: yourDp, label: 'yours' });
  }
  // Interleave rather than block, then place each target somewhere the
  // previous one was not, so the movement is a real acquisition each time.
  return trials.map((t, i) => ({ ...t, index: i }));
}

/** Where to put the next target inside the arena, away from the last one. */
export function placeTarget(arena, size, previous) {
  const pad = size / 2 + 12;
  for (let attempt = 0; attempt < 24; attempt++) {
    const cx = pad + Math.random() * Math.max(1, arena.w - pad * 2);
    const cy = pad + Math.random() * Math.max(1, arena.h - pad * 2);
    if (!previous) return { cx, cy };
    if (Math.hypot(cx - previous.cx, cy - previous.cy) > Math.min(arena.w, arena.h) * 0.3) return { cx, cy };
  }
  return { cx: arena.w / 2, cy: arena.h / 2 };
}

/** Did this tap land, and how far off was it? */
export function score(tap, target, size) {
  const dx = tap.x - target.cx, dy = tap.y - target.cy;
  const half = size / 2;
  return {
    hit: Math.abs(dx) <= half && Math.abs(dy) <= half,
    errorDp: Math.hypot(dx, dy),
    dx, dy,
  };
}

/** Summarise a completed run, by size. */
export function summarise(results) {
  const by = (label) => {
    const rows = results.filter((r) => r.label === label);
    if (rows.length === 0) return null;
    const hits = rows.filter((r) => r.hit).length;
    const errs = rows.map((r) => r.errorDp).sort((a, b) => a - b);
    return {
      n: rows.length,
      hits,
      rate: hits / rows.length,
      medianErrorDp: errs[Math.floor(errs.length / 2)],
      meanMsToTap: rows.reduce((a, r) => a + r.ms, 0) / rows.length,
    };
  };
  return { wcag: by('wcag'), yours: by('yours') };
}
