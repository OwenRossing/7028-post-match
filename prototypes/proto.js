/* Shared helpers for the design prototypes (not used by the app). */
const S = window.SAMPLE;

/** Match clock: seconds from the start of auto -> "2:11" (negative before the match). */
function clock(t) {
  if (t == null || !Number.isFinite(t)) return '–';
  const neg = t < 0;
  const a = Math.abs(t);
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
}

/**
 * Which part of the robot each finding belongs to, and how bad that part is.
 * One word per system so the UI can stay picture-first.
 */
const SYSTEMS = {
  battery: { name: 'Battery', ids: ['brownout', 'brownout-counter', 'volt-low', 'volt-sag', 'volt-start'] },
  radio: { name: 'Radio', ids: ['comms-enabled', 'comms', 'network', 'radio-fw'] },
  rio: { name: 'roboRIO', ids: ['rail-v12', 'rail-v5', 'rail-v3_3', 'rio-mem', 'cpu'] },
  code: { name: 'Code', ids: ['code-stall', 'loop', 'crash', 'watchdog', 'errors'] },
  can: { name: 'CAN', ids: ['can-devices', 'can-util'] },
  power: { name: 'Power', ids: [] },
};
function systemOf(problemId) {
  return Object.keys(SYSTEMS).find((k) => SYSTEMS[k].ids.includes(problemId)) || 'code';
}
function statusOf(sys) {
  const ps = S.problems.filter((p) => p.severity !== 'info' && systemOf(p.id) === sys);
  if (ps.some((p) => p.severity === 'bad')) return 'bad';
  if (ps.length) return 'warn';
  return 'ok';
}
function problemsOf(sys) {
  return S.problems.filter((p) => p.severity !== 'info' && systemOf(p.id) === sys);
}
function overall() {
  if (S.problems.some((p) => p.severity === 'bad')) return 'bad';
  if (S.problems.some((p) => p.severity === 'warn')) return 'warn';
  return 'ok';
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/**
 * Tiny SVG line/area chart over the match.
 * opts: {w, h, min, max, color, fill, spans:[{start,end,color}], marks:[{t,color}], cursor, threshold:{v,color}}
 */
function spark(values, opts) {
  const { w, h } = opts;
  const t = S.series.t;
  const t0 = opts.t0 ?? t[0], t1 = opts.t1 ?? t[t.length - 1];
  const vals = values.map((v) => (v == null ? NaN : v));
  const finite = vals.filter(Number.isFinite);
  const min = opts.min ?? Math.min(...finite), max = opts.max ?? Math.max(...finite);
  const X = (x) => ((x - t0) / (t1 - t0)) * w;
  const Y = (y) => h - ((y - min) / (max - min || 1)) * h;
  let d = '', started = false;
  vals.forEach((v, i) => {
    if (t[i] < t0 || t[i] > t1) return;
    if (!Number.isFinite(v)) { started = false; return; }
    d += `${started ? 'L' : 'M'}${X(t[i]).toFixed(1)},${Y(Math.max(min, Math.min(max, v))).toFixed(1)}`;
    started = true;
  });
  let out = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark">`;
  for (const s of opts.spans || []) {
    const a = Math.max(X(s.start), 0), b = Math.min(X(s.end), w);
    if (b > a) out += `<rect x="${a}" y="0" width="${Math.max(b - a, 2)}" height="${h}" fill="${s.color}" />`;
  }
  if (opts.threshold) {
    out += `<line x1="0" x2="${w}" y1="${Y(opts.threshold.v)}" y2="${Y(opts.threshold.v)}" stroke="${opts.threshold.color}" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />`;
  }
  if (opts.fill) out += `<path d="${d}L${w},${h}L0,${h}Z" fill="${opts.fill}" />`;
  out += `<path d="${d}" fill="none" stroke="${opts.color}" stroke-width="${opts.width || 1.5}" vector-effect="non-scaling-stroke" stroke-linejoin="round" />`;
  for (const m of opts.marks || []) {
    const x = X(m.t);
    if (x >= 0 && x <= w) out += `<line x1="${x}" x2="${x}" y1="0" y2="${h}" stroke="${m.color}" stroke-width="2" vector-effect="non-scaling-stroke" />`;
  }
  if (opts.cursor != null) {
    const x = X(opts.cursor);
    out += `<line x1="${x}" x2="${x}" y1="0" y2="${h}" stroke="var(--text)" stroke-width="1.5" vector-effect="non-scaling-stroke" />`;
  }
  return out + '</svg>';
}

/** Value of a series at match time t. */
function at(series, t) {
  const ts = S.series.t;
  let i = Math.round((t - ts[0]) / (ts[1] - ts[0]));
  i = Math.max(0, Math.min(ts.length - 1, i));
  return series[i];
}

/** Key bar at the bottom: [[keys, label], ...] */
function keybar(items) {
  const el = document.createElement('div');
  el.className = 'keybar';
  el.innerHTML = items.map(([k, label]) => `<span>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')} ${label}</span>`).join('');
  document.body.appendChild(el);
}

/** Header with the match name, overall light and prototype switcher (keys 1-3). */
function header(active) {
  const el = document.createElement('div');
  el.className = 'head';
  const v = overall();
  el.innerHTML = `
    <span class="light big-light ${v}"></span>
    <h1>${S.title}</h1>
    <span class="sub">${[S.event, S.team && 'Team ' + S.team].filter(Boolean).join(' · ')}</span>
    <span class="grow"></span>
    <nav class="switcher">
      ${['Robot map', 'Flight recorder', 'Instruments'].map((n, i) => `<a href="${['robot', 'recorder', 'instruments'][i]}.html" class="${i + 1 === active ? 'on' : ''}"><kbd>${i + 1}</kbd> ${n}</a>`).join('')}
    </nav>`;
  document.body.prepend(el);
  window.addEventListener('keydown', (e) => {
    if (['1', '2', '3'].includes(e.key)) location.href = ['robot', 'recorder', 'instruments'][+e.key - 1] + '.html';
  });
}

/** Checked systems, remembered per prototype for the demo. */
const checked = new Set(JSON.parse(sessionStorage.getItem('proto.checked') || '[]'));
function toggleChecked(k) {
  if (checked.has(k)) checked.delete(k); else checked.add(k);
  sessionStorage.setItem('proto.checked', JSON.stringify([...checked]));
}
