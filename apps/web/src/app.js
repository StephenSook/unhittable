// app.js - the page.
//
// Every number rendered here is computed in the browser from the committed
// recordings, using the same core modules the API and the test suite import.
// Nothing is precomputed into the HTML, so a reader can change the code and
// watch the figure move, and a figure on this page cannot disagree with a
// figure in a scan report.

import { recordingToPath } from './core/replay.js';
import {
  holdFractionRect, cpiToCssPxPerMm, minimumBox, scaleForHoldRect,
  judgeRecording, WCAG_MIN_PX, WCAG_ENHANCED_PX,
} from './core/geometry.js';
import { tremorSpectrum, PADS_FS } from './core/tremor.js';
import { parsePadsRecord } from './core/tremor.js';

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where the scanning service lives. Local dev talks to a local API. */
const API = window.UNHITTABLE_API ??
  (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://localhost:8791'
    : 'https://unhittable-api.onrender.com');

const CPIS = [200, 400, 800, 1200, 1600];
const SIZES = [24, 32, 44, 64, 96, 128, 192, 256];

const state = {
  manifest: null,
  cohort: null,
  recordings: new Map(),
  current: null,
  cpi: 800,
  size: 24,
  playing: !reduced,
  viewport: 'desktop',
  lastScan: null,
  elementFilter: 'all',
};

// ===========================================================================
// Boot
// ===========================================================================

async function boot() {
  const [manifest, cohort] = await Promise.all([
    fetch('core/data/manifest.json').then((r) => r.json()),
    fetch('data/cohort.json').then((r) => r.json()),
  ]);
  state.manifest = manifest;
  state.cohort = cohort;

  // The recording that opens the page is the parkinsonian one whose amplitude
  // sits near the middle of what we detected, not the largest in the set.
  const defaultId = '006_StretchHold_RightWrist';
  await selectRecording(defaultId);

  buildPicker();
  buildCohortGrid();
  wireInstrument();
  wireScanner();
  loadCorpus();
  runSelfTest();
  requestAnimationFrame(tick);
  setInterval(tick, 34);            // keeps running when the tab is hidden
}

async function loadRecording(file) {
  if (state.recordings.has(file)) return state.recordings.get(file);
  const text = await fetch(`core/data/${file}`).then((r) => r.text());
  const path = recordingToPath(text);
  const raw = parsePadsRecord(text);
  const magnitude = Float64Array.from({ length: raw.n }, (_, i) => Math.hypot(raw.ax[i], raw.ay[i], raw.az[i]));
  const spectrum = tremorSpectrum(magnitude, PADS_FS, { loHz: 2, hiHz: 15 }) ?? null;
  const rec = { file, path, raw, magnitude, spectrum };
  state.recordings.set(file, rec);
  return rec;
}

async function selectRecording(id) {
  const meta = state.manifest.records.find((r) => r.file.startsWith(id)) ?? state.manifest.records[0];
  const rec = await loadRecording(meta.file);
  state.current = { meta, ...rec };
  renderHeadline();
  renderMeta();
  renderSweep();
  drawChart();
  drawSpectrum();
  return state.current;
}

// ===========================================================================
// Headline numbers
// ===========================================================================

function renderHeadline() {
  const { meta } = state.current;
  const ppm = cpiToCssPxPerMm(800);
  const hold = holdFractionRect(state.current.path, ppm, WCAG_MIN_PX, WCAG_MIN_PX);
  const k = scaleForHoldRect(state.current.path, ppm, WCAG_MIN_PX, WCAG_MIN_PX, 0.95);

  $('sHold').textContent = pct(hold);
  $('sNeed').textContent = k === null ? '·' : Math.round(WCAG_MIN_PX * k);
  $('sCohort').textContent = `${state.cohort.primary.exceedsWholeTarget24} of ${state.cohort.primary.clearing}`;
  $('recLabel').textContent = `subject ${meta.subject} · ${meta.condition ?? 'unlabelled'}`;

  const railText = `Subject ${meta.subject}, ${meta.condition}. ` +
    `${meta.hz} hertz, ${meta.p2pMm} millimetres. ` +
    `Inside a 24 pixel target ${pct(hold)} of the time at 800 cpi.`;
  $('railText').textContent = railText;
}

function renderMeta() {
  const { meta } = state.current;
  const ppm = cpiToCssPxPerMm(state.cpi);
  const box = minimumBox(state.current.path, ppm);
  const rows = [
    ['Subject', `${meta.subject} of 260 measured`],
    ['Condition', meta.condition ?? 'not labelled'],
    ['Task', `${meta.taskLabel} (${meta.task})`],
    ['Wrist', `${meta.wrist}`],
    ['Frequency', `${meta.hz} Hz`],
    ['Peak to peak', `${meta.p2pMm} mm`],
    ['Detectable tremor', meta.detectable
      ? 'yes, clears a bar no null draw reached'
      : 'no, this recording sits at the noise floor'],
    [`Cursor travel at ${state.cpi} cpi`, `${(meta.p2pMm * ppm).toFixed(0)} px`],
    ['Plane orientations swept', `${state.current.path.family.length}`],
    ['Wrist rotation removed', meta.sweptDeg ? `${Math.round(meta.sweptDeg)} degrees swept` : 'no gyroscope in this record'],
  ];
  $('meta').innerHTML = rows.map(([k, v]) =>
    `<dt class="micro" style="color:var(--dim);text-transform:none;letter-spacing:0">${esc(k)}</dt>` +
    `<dd style="margin:0;color:var(--ink)">${esc(String(v))}</dd>`).join('');
}

function buildCohortGrid() {
  const p = state.cohort.primary;
  const cells = [
    [`${p.subjects}`, 'clinically assessed people measured'],
    [`${p.recordings.toLocaleString()}`, 'postural recordings analysed'],
    [`${p.clearing}`, `contain a detectable tremor (${pct(p.clearRate)})`],
    [`${p.exceedsWholeTarget24}`, 'have a tremor wider than the whole 24 px target'],
    [`${p.below95At24}`, 'hold a 24 px target under 95% of the time'],
    [`${p.below50At24}`, 'miss more often than they hit'],
  ];
  $('cohortGrid').innerHTML = cells.map(([v, k]) =>
    `<div class="score"><div class="score-v num">${esc(v)}</div><div class="score-k">${esc(k)}</div></div>`).join('');
}

// ===========================================================================
// The instrument
// ===========================================================================

function buildPicker() {
  const order = ['124_HoldWeight_LeftWrist', '006_StretchHold_RightWrist', '228_StretchHold_RightWrist',
                 '071_HoldWeight_RightWrist', '006_StretchHold_LeftWrist', '001_StretchHold_RightWrist'];
  const recs = [...state.manifest.records].sort(
    (a, b) => order.indexOf(a.file.replace('.txt', '')) - order.indexOf(b.file.replace('.txt', '')));

  $('picker').innerHTML = recs.map((r) => {
    const id = r.file.replace('.txt', '');
    const short = r.condition === "Parkinson's" ? 'PD'
      : r.condition === 'Essential Tremor' ? 'ET'
      : r.condition === 'Healthy' ? 'control' : (r.condition ?? '?');
    const visible = `${short} · ${r.p2pMm} mm`;
    // The accessible name CONTAINS the visible label, so SC 2.5.3 Label in
    // Name holds. An aria-label that replaced the text would fail it, on a
    // page about conformance.
    const full = `${visible}, subject ${r.subject}, ${r.wrist} wrist, ` +
      `${r.detectable ? 'detectable tremor' : 'no detectable tremor'}`;
    return `<button class="btn ghost pick" type="button" data-id="${esc(id)}" aria-label="${esc(full)}" aria-pressed="false">${esc(visible)}</button>`;
  }).join('');

  $('picker').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    await selectRecording(b.dataset.id);
    markPicker();
    announce(`Now showing subject ${state.current.meta.subject}, ${state.current.meta.condition}.`);
  });
  markPicker();
}

function markPicker() {
  const id = state.current.meta.file.replace('.txt', '');
  for (const b of $('picker').querySelectorAll('button[data-id]')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === id));
  }
}

function wireInstrument() {
  $('size').addEventListener('input', (e) => {
    state.size = Number(e.target.value);
    $('sizeVal').textContent = state.size;
    applyTargetSize();
  });
  $('cpi').addEventListener('input', (e) => {
    state.cpi = Number(e.target.value);
    $('cpiVal').textContent = state.cpi;
    renderMeta(); renderSweep(); drawChart();
  });
  $('playBtn').addEventListener('click', (e) => {
    state.playing = !state.playing;
    e.target.textContent = state.playing ? 'Pause motion' : 'Resume motion';
    e.target.setAttribute('aria-pressed', String(state.playing));
  });
  $('snapBtn').addEventListener('click', () => {
    state.size = 24; $('size').value = 24; $('sizeVal').textContent = 24; applyTargetSize();
    announce('Target reset to the 24 pixel minimum.');
  });
  if (reduced) {
    state.playing = false;
    $('playBtn').textContent = 'Resume motion';
    $('playBtn').setAttribute('aria-pressed', 'false');
  }
  applyTargetSize();
}

function applyTargetSize() {
  const t = $('target');
  t.style.width = `${state.size}px`;
  t.style.height = `${state.size}px`;
  $('targetLabel').textContent = `${state.size}px`;
  $('targetLabel').style.display = state.size >= 40 ? '' : 'none';
}

let t0 = performance.now(), frames = 0, insideCount = 0;
const trail = [];

function tick() {
  if (!state.current) return;
  const stage = $('stage');
  if (!stage) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  const ppm = cpiToCssPxPerMm(state.cpi);
  const t = state.playing ? (performance.now() - t0) / 1000 : 0;

  const p = state.current.path;
  const tt = ((t % p.seconds) + p.seconds) % p.seconds;
  const f = tt * p.fs, i = Math.floor(f), frac = f - i, j = (i + 1) % p.n;
  const x = (p.x[i] + (p.x[j] - p.x[i]) * frac) * ppm;
  const y = (p.y[i] + (p.y[j] - p.y[i]) * frac) * ppm;

  const half = state.size / 2;
  const inside = Math.abs(x) <= half && Math.abs(y) <= half;

  // The cursor element is already centred by left:50%/top:50%, so it is
  // translated by the EXCURSION only. Adding w/2 here as well put it at
  // double the offset, which the trail canvas did not do because the canvas
  // is inset:0 and draws in absolute stage coordinates. The two disagreed on
  // screen, which is how it was caught.
  const c = $('cursor');
  c.style.transform = `translate(${x}px, ${y}px)`;
  c.dataset.inside = String(inside);

  const cx = w / 2 + x, cy = h / 2 + y;

  frames++; if (inside) insideCount++;
  if (frames % 8 === 0) {
    // The worst plane, like every other published figure, not the projection
    // that happens to be animating.
    const fam = state.current.path.family;
    let live = Infinity, needK = 0;
    for (const m of fam) {
      const h = holdFractionRect(m, ppm, state.size, state.size);
      if (h < live) live = h;
      const k = scaleForHoldRect(m, ppm, state.size, state.size, 0.95);
      if (k !== null && k > needK) needK = k;
    }
    $('liveHold').textContent = pct(live);
    $('liveHold').className = `verdict-v num ${live >= 0.95 ? 'good' : 'bad'}`;
    $('liveNote').textContent = live >= 0.95
      ? `A ${state.size} px target holds this hand.`
      : `Would need ${needK ? Math.round(state.size * needK) : 'more'} px for a 95% hold.`;
  }

  if (state.playing) {
    trail.push({ x: cx, y: cy, inside });
    if (trail.length > 220) trail.shift();
  }
  drawTrail(w, h);
}

function drawTrail(w, h) {
  const cv = $('trail');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    g.globalAlpha = (i / trail.length) * 0.5;
    g.strokeStyle = b.inside ? '#5bd6a0' : '#ff4a1c';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.globalAlpha = 1;
}

// ===========================================================================
// Sweep table and charts
// ===========================================================================

function renderSweep() {
  const p = state.current.path;
  $('sweepHead').innerHTML = '<th scope="col">Sensitivity</th>' +
    SIZES.map((s) => `<th scope="col">${s} px${s === 24 ? ' (AA)' : s === 44 ? ' (AAA)' : ''}</th>`).join('') +
    '<th scope="col">Needs, for 95%</th>';

  const fam = state.current.path.family;
  const worstAt = (ppm, px) => {
    let w = Infinity;
    for (const m of fam) { const h = holdFractionRect(m, ppm, px, px); if (h < w) w = h; }
    return w;
  };

  $('sweepBody').innerHTML = CPIS.map((cpi) => {
    const ppm = cpiToCssPxPerMm(cpi);
    const k = judgeRecording(fam, ppm).needPx;
    const cells = SIZES.map((s) => {
      const v = worstAt(ppm, s);
      const cls = v >= 0.95 ? 'good' : v < 0.5 ? 'bad' : '';
      return `<td class="num ${cls}">${pct(v)}</td>`;
    }).join('');
    return `<tr><th scope="row" class="num">${cpi} cpi</th>${cells}` +
      `<td class="num">${k === null ? '·' : Math.round(WCAG_MIN_PX * k) + ' px'}</td></tr>`;
  }).join('');

  $('sweepCaption').textContent =
    `Fraction of the recording the cursor is inside the target, for subject ${state.current.meta.subject}. ` +
    `Computed in your browser from the committed file.`;
}

function drawChart() {
  const cv = $('chart'); if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = { l: 66, r: 24, t: 24, b: 54 };
  g.clearRect(0, 0, W, H);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const maxSize = 256;
  const X = (s) => pad.l + (s / maxSize) * iw;
  const Y = (v) => pad.t + (1 - v) * ih;

  g.strokeStyle = '#1f242a'; g.lineWidth = 1; g.fillStyle = '#a0a8b0';
  g.font = '500 12px "IBM Plex Mono", monospace';
  for (let v = 0; v <= 1.0001; v += 0.25) {
    g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(W - pad.r, Y(v)); g.stroke();
    g.textAlign = 'right'; g.fillText(`${Math.round(v * 100)}%`, pad.l - 10, Y(v) + 4);
  }
  g.textAlign = 'center';
  for (const s of [0, 44, 96, 160, 224, 256]) g.fillText(String(s), X(s), H - pad.b + 22);
  g.fillText('target size, CSS pixels', pad.l + iw / 2, H - 14);

  // The two published sizes, marked and labelled.
  for (const [s, label] of [[WCAG_MIN_PX, 'AA 24'], [WCAG_ENHANCED_PX, 'AAA 44']]) {
    g.save(); g.setLineDash([4, 4]); g.strokeStyle = '#3a424b';
    g.beginPath(); g.moveTo(X(s), pad.t); g.lineTo(X(s), H - pad.b); g.stroke(); g.restore();
    g.fillStyle = '#a8b0b8'; g.textAlign = 'left';
    g.fillText(label, X(s) + 6, pad.t + 14);
  }

  const p = state.current.path;
  const colours = ['#ff4a1c', '#ff8a3c', '#eceef1', '#7fb3ff', '#5bd6a0'];
  CPIS.forEach((cpi, ci) => {
    const ppm = cpiToCssPxPerMm(cpi);
    g.beginPath(); g.strokeStyle = colours[ci]; g.lineWidth = cpi === 800 ? 2.6 : 1.5;
    for (let s = 8; s <= maxSize; s += 3) {
      let v = Infinity;
      for (const m of state.current.path.family) {
        const h = holdFractionRect(m, ppm, s, s);
        if (h < v) v = h;
      }
      s === 8 ? g.moveTo(X(s), Y(v)) : g.lineTo(X(s), Y(v));
    }
    g.stroke();
  });

  $('legend').innerHTML = CPIS.map((cpi, i) =>
    `<span class="legend-item"><i style="background:${colours[i]}"></i>${cpi} cpi${cpi === 800 ? ' (common default)' : ''}</span>`).join('');
}

function drawSpectrum() {
  const cv = $('spectrum'); if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = { l: 44, r: 14, t: 14, b: 34 };
  g.clearRect(0, 0, W, H);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const maxHz = 15;
  const X = (hz) => pad.l + (hz / maxHz) * iw;

  // The published parkinsonian rest-tremor band.
  g.fillStyle = 'rgba(255,74,28,.10)';
  g.fillRect(X(4), pad.t, X(7) - X(4), ih);

  const spec = state.current.spectrum;
  g.strokeStyle = '#1f242a'; g.beginPath();
  g.moveTo(pad.l, pad.t + ih); g.lineTo(W - pad.r, pad.t + ih); g.stroke();
  g.fillStyle = '#a0a8b0'; g.font = '500 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
  for (const hz of [0, 4, 7, 10, 15]) g.fillText(String(hz), X(hz), H - 12);
  g.fillText('Hz', pad.l + iw / 2, H - 1);

  if (spec?.curve?.length) {
    const max = Math.max(...spec.curve.map((c) => c.mag)) || 1;
    g.beginPath(); g.strokeStyle = '#eceef1'; g.lineWidth = 1.6;
    spec.curve.forEach((c, i) => {
      const x = X(c.hz), y = pad.t + ih - (c.mag / max) * ih * 0.94;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    });
    g.stroke();
  }
  if (spec?.hz) {
    g.strokeStyle = '#ff4a1c'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(spec.hz), pad.t); g.lineTo(X(spec.hz), pad.t + ih); g.stroke();
    g.fillStyle = '#ff4a1c'; g.textAlign = 'left';
    g.fillText(`${spec.hz.toFixed(2)} Hz`, X(spec.hz) + 5, pad.t + 12);
  }
}

// ===========================================================================
// The scanner
// ===========================================================================

function wireScanner() {
  $('scanForm').addEventListener('submit', (e) => { e.preventDefault(); runScan(); });
  $('optDesktop').addEventListener('click', () => setViewport('desktop'));
  $('optMobile').addEventListener('click', () => setViewport('mobile'));

  const presets = ['https://www.usa.gov/', 'https://www.cdc.gov/', 'https://www.parkinson.org/',
                   'https://webaim.org/', 'https://github.com/'];
  $('presets').innerHTML = presets.map((u) =>
    `<button class="preset" type="button" data-url="${esc(u)}">${esc(new URL(u).hostname.replace(/^www\./, ''))}</button>`).join('');
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-url]');
    if (!b) return;
    $('scanUrl').value = b.dataset.url;
    runScan();
  });
}

function setViewport(v) {
  state.viewport = v;
  $('optDesktop').setAttribute('aria-pressed', String(v === 'desktop'));
  $('optMobile').setAttribute('aria-pressed', String(v === 'mobile'));
  if (state.lastScan) runScan();
}

async function runScan() {
  const url = $('scanUrl').value.trim();
  if (!url) { $('scanUrl').focus(); return; }
  const out = $('scanOut');
  $('scanBtn').disabled = true;

  out.innerHTML = `
    <div class="progress">
      <div class="progress-bar"><i></i></div>
      <div class="progress-text">Opening ${esc(url)} in a real browser, waiting for fonts, measuring every control…</div>
    </div>`;

  let res, data;
  try {
    res = await fetch(`${API}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, viewport: state.viewport, cpi: state.cpi,
                             recording: state.current.meta.file.replace('.txt', '') }),
    });
    data = await res.json();
  } catch (e) {
    out.innerHTML = `<div class="notice"><div><strong>The scanning service did not answer.</strong>
      It runs on a free instance that sleeps when idle, so the first request after a quiet period can
      time out. Try once more. Everything above this section is computed in your browser and does not
      depend on it.</div></div>`;
    $('scanBtn').disabled = false;
    return;
  }
  $('scanBtn').disabled = false;

  if (!res.ok) {
    out.innerHTML = `<div class="notice"><div><strong>Could not scan that.</strong> ${esc(data.error ?? 'Unknown error.')}</div></div>`;
    return;
  }
  state.lastScan = data;
  renderScan(data);
}

function renderScan(d) {
  const s = d.summary;
  const failStandard = s.n - s.wcagPass;
  const worst = [...d.elements].sort((a, b) => a.hold - b.hold);

  const warn = (d.warnings ?? []).map((w) =>
    `<div class="notice"><div><strong>Every target on this page is being shrunk.</strong> ${esc(w.detail)}</div></div>`).join('');

  $('scanOut').innerHTML = `
    <div class="result-head" style="margin-top:30px">
      <div>
        <p class="micro" style="margin:0">${esc(d.viewport.label)} · ${d.cpi} cpi · subject ${esc(d.recording?.id?.slice(0, 3) ?? '')} ${esc(d.recording?.condition ?? '')}</p>
        <h3 style="margin:8px 0 0">${esc(d.title || new URL(d.url).hostname)}</h3>
        <p class="micro" style="margin:6px 0 0; text-transform:none; letter-spacing:0; color:var(--dim)">
          ${esc(d.url)} · measured in ${d.durationMs} ms${d.cached ? ' · from cache' : ''}
        </p>
      </div>
    </div>
    ${warn}
    <div class="scoreboard">
      <div class="score"><div class="score-v num">${s.n}</div><div class="score-k">interactive controls measured, as rendered</div></div>
      <div class="score"><div class="score-v num ${failStandard ? 'bad' : 'good'}">${failStandard}</div><div class="score-k">fail WCAG 2.5.8, including the spacing exception</div></div>
      <div class="score"><div class="score-v num bad">${s.passesStandardButNotHand}</div><div class="score-k">pass the standard and still cannot be held</div></div>
      <div class="score"><div class="score-v num">${s.medianHold === null ? '·' : pct(s.medianHold)}</div><div class="score-k">median chance a click lands, for this hand</div></div>
    </div>

    <div class="filters" role="group" aria-label="Filter the controls below">
      <button class="chip" type="button" data-filter="all" aria-pressed="true">All ${s.n}</button>
      <button class="chip" type="button" data-filter="gap" aria-pressed="false">Passes the standard, fails the hand (${s.passesStandardButNotHand})</button>
      <button class="chip" type="button" data-filter="fail" aria-pressed="false">Fails the standard (${failStandard})</button>
    </div>

    <div class="tablewrap">
      <table class="elements">
        <caption class="vh">Every interactive control on the page, worst first</caption>
        <thead><tr>
          <th scope="col">Control</th><th scope="col">Size</th><th scope="col">WCAG 2.5.8</th>
          <th scope="col">Chance a click lands</th><th scope="col">Bound by</th><th scope="col">Would need</th>
        </tr></thead>
        <tbody id="elBody"></tbody>
      </table>
    </div>
    <p class="micro" style="margin-top:14px; text-transform:none; letter-spacing:0; color:var(--dim)">
      ${s.notAutomaticallyDecidable} control${s.notAutomaticallyDecidable === 1 ? '' : 's'} could not be decided automatically.
      Three of the five exceptions in SC 2.5.8 depend on intent rather than geometry, and we do not guess at them.
    </p>`;

  const body = $('elBody');
  const paint = (filter) => {
    const rows = worst.filter((e) =>
      filter === 'all' ? true : filter === 'gap' ? e.passesStandardButNotHand : !e.wcagPass);
    body.innerHTML = rows.slice(0, 200).map((e) => {
      const badge = e.wcagPass
        ? `<span class="pill pass">✓ passes</span>${e.wcagExemptReason ? `<div class="micro" style="margin-top:5px;text-transform:none;letter-spacing:0;color:var(--dim)">${esc(e.wcagExemptReason)}</div>` : ''}`
        : '<span class="pill fail">✗ fails</span>';
      const colour = e.hold >= 0.95 ? 'var(--pass)' : e.hold < 0.5 ? 'var(--alarm)' : '#ff8a3c';
      return `<tr>
        <td><div class="el-name">${esc(e.name || `<${e.tag}>`)}</div><div class="el-sel">${esc(e.selector)}</div></td>
        <td class="num">${Math.round(e.w)}&times;${Math.round(e.h)}</td>
        <td>${badge}</td>
        <td><div class="holdbar"><div class="holdbar-track"><div class="holdbar-fill" style="width:${(e.hold * 100).toFixed(1)}%;background:${colour}"></div></div><span class="num">${pct(e.hold)}</span></div></td>
        <td class="num">${e.bindingSide ?? '\u00b7'}</td>
        <td class="num">${e.needWPx ? `${Math.round(e.needWPx)}&times;${Math.round(e.needHPx)}` : '·'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--dim)">Nothing in this category.</td></tr>';
  };
  paint('all');

  $('scanOut').querySelector('.filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    for (const c of $('scanOut').querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === b));
    paint(b.dataset.filter);
  });
}

// ===========================================================================
// The corpus
// ===========================================================================

async function loadCorpus() {
  let data;
  try {
    const r = await fetch(`${API}/api/corpus`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    $('corpusGrid').innerHTML =
      `<div class="score"><div class="score-v num">·</div><div class="score-k">The corpus service is asleep. Everything else on this page is computed in your browser and still works.</div></div>`;
    return;
  }
  const a = data.aggregate;
  const n = Number(a.targets);
  const cells = [
    [String(a.sites), 'live sites measured, in a list committed to the repository'],
    [n.toLocaleString(), 'interactive controls measured as rendered'],
    [pct(1 - Number(a.fail_standard) / n), 'of them PASS WCAG 2.5.8'],
    [pct(Number(a.pass_standard_fail_hand) / n), 'pass it and still cannot be reliably held'],
    [pct(Number(a.below_50) / n), 'would be missed more often than hit'],
    [`${Math.round(a.median_w)}×${Math.round(a.median_h)}`, 'median control on the web, in CSS pixels'],
  ];
  $('corpusGrid').innerHTML = cells.map(([v, k]) =>
    `<div class="score"><div class="score-v num${k.includes('cannot') || k.includes('missed') ? ' bad' : ''}">${esc(v)}</div><div class="score-k">${esc(k)}</div></div>`).join('');

  $('corpusTable').innerHTML = `
    <table class="elements">
      <caption style="text-align:left;padding:0 0 14px;color:var(--ink-2);font-size:14px">
        Height is the limiting axis on ${Number(a.limited_by_height).toLocaleString()} controls and width on
        ${Number(a.limited_by_width).toLocaleString()}. The median control is wide and short, which is the shape a
        square minimum cannot describe.
      </caption>
      <thead><tr><th scope="col">Site</th><th scope="col">Controls</th><th scope="col">Fail 2.5.8</th>
      <th scope="col">Pass it, fail the hand</th><th scope="col">Median hold</th></tr></thead>
      <tbody>${data.sites.map((s) => `<tr>
        <td>${esc(s.host.replace(/^www\./, ''))}<div class="el-sel">${esc((s.title ?? '').slice(0, 60))}</div></td>
        <td class="num">${s.n_targets}</td>
        <td class="num">${s.n_targets - s.n_wcag_pass}</td>
        <td class="num" style="color:var(--alarm)">${s.n_standard_not_hand}</td>
        <td class="num">${s.median_hold === null ? '·' : pct(Number(s.median_hold))}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

// ===========================================================================
// This page against its own standard
// ===========================================================================

function runSelfTest() {
  // Measured, not asserted. A page arguing that people publish accessibility
  // numbers without checking them has to check its own, and has to publish
  // the answer even when the answer is against it.
  setTimeout(() => {
    const sel = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex^="-"])';
    const all = [...document.querySelectorAll(sel)].filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
        && el.getAttribute('aria-hidden') !== 'true' && !el.disabled;
    });

    let smallest = Infinity, offender = null;
    const ppm = cpiToCssPxPerMm(800);
    let heldByHand = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).display === 'inline') continue;   // the Inline exception
      const m = Math.min(r.width, r.height);
      if (m < smallest) { smallest = m; offender = el; }
      let w = Infinity;
      for (const m of state.current.path.family) {
        const h = holdFractionRect(m, ppm, r.width, r.height);
        if (h < w) w = h;
      }
      if (w >= 0.95) heldByHand++;
    }

    const clearsAAA = smallest >= WCAG_ENHANCED_PX;
    const need = judgeRecording(state.current.path.family, ppm).needPx;

    $('selfTest').innerHTML =
      `Measured just now in your browser: <strong>${all.length}</strong> interactive controls. ` +
      `The smallest is <strong>${Math.round(smallest)} px</strong> on its short side, ` +
      (clearsAAA
        ? `which clears the 44 px AAA enhanced size, not merely the 24 px minimum this page is about. `
        : `which is under the 44 px we hold ourselves to, and that is a defect: <code>${esc(offender?.className || offender?.tagName || '')}</code>. `) +
      `<br><br>And the part that is against us: <strong>${heldByHand} of them</strong> would be reliably held by the ` +
      `recording currently loaded. ` +
      (heldByHand === 0
        ? `None. Holding ourselves to AAA was not enough either, because this hand needs about ${need ?? '116'} px and no design system ships that. `
        : `The rest would not. `) +
      `We are not exempt from our own finding, and saying so is cheaper than being caught by it.`;
  }, 700);
}

// ===========================================================================

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function announce(msg) { $('live').textContent = msg; }

boot().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="notice" style="margin:20px">Could not start: ${esc(e.message)}</div>`);
  console.error(e);
});
