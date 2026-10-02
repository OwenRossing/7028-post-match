// Shared behaviour for the board prototypes (board-a.html, board-b.html): fold state, keyboard, check-off, helpers.
// Data comes from board-data.js (the real sample match). Each prototype only supplies its own markup and styles.
(function () {
  const D = window.BOARD;
  const S = { open: new Set(), sel: null, checked: new Set(), inspect: false, first: true, last: null };
  let cfg = null;
  let root = null;

  const fmt = (v, d = 0) => (v == null ? '' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const t = (sec) => {
    const s = sec - D.matchStart;
    const a = Math.abs(s);
    return `${s < 0 ? '-' : ''}${Math.floor(a / 60)}:${(a % 60).toFixed(1).padStart(4, '0')}`;
  };
  const delta = (r) => {
    const j = r.j;
    if (!j || !j.flagged) return '';
    if (j.mean === 0) return 'usually 0';
    if (['V', '%', 'ms', 's', 'MB'].includes(r.unit)) return `${r.value > j.mean ? '+' : '−'}${fmt(Math.abs(r.value - j.mean), r.digits)} ${r.unit} vs usual`;
    const ratio = r.value / j.mean;
    return ratio >= 1.15 ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× usual` : `${Math.round((1 - ratio) * 100)}% under usual`;
  };

  /** Tiny history chart: the last matches as a line, this match as the end dot. */
  function spark(r, w = 64, h = 16) {
    const j = r.j;
    if (!j || !j.enough) return '';
    const vals = [...j.history, r.value];
    const lo = Math.min(...vals, j.mean - 2 * j.spread);
    const hi = Math.max(...vals, j.mean + 2 * j.spread);
    const x = (i) => 2 + (i / (vals.length - 1)) * (w - 4);
    const y = (v) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
    const pts = vals.slice(0, -1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const band = `<rect x="0" y="${y(j.mean + 2 * j.spread).toFixed(1)}" width="${w}" height="${Math.max(1, y(j.mean - 2 * j.spread) - y(j.mean + 2 * j.spread)).toFixed(1)}" class="sp-band"/>`;
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${band}<polyline points="${pts}" class="sp-line"/><circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(r.value).toFixed(1)}" r="2.2" class="sp-dot ${j.flagged ? 'bad' : 'ok'}"/></svg>`;
  }

  /** Bullet gauge: the usual range shaded, the average as a tick, this match as a marker. */
  function gauge(r, w = 90) {
    const j = r.j;
    if (!j || !j.enough) return '';
    const lo = Math.min(r.value, j.mean - 3 * j.spread);
    const hi = Math.max(r.value, j.mean + 3 * j.spread);
    const p = (v) => (((v - lo) / (hi - lo || 1)) * 100).toFixed(1);
    return `<span class="gauge" style="width:${w}px"><i class="g-band" style="left:${p(j.mean - 2 * j.spread)}%;width:${(p(j.mean + 2 * j.spread) - p(j.mean - 2 * j.spread)).toFixed(1)}%"></i><i class="g-mean" style="left:${p(j.mean)}%"></i><i class="g-now ${j.flagged ? 'bad' : 'ok'}" style="left:${p(r.value)}%"></i></span>`;
  }

  /** A line chart of one of the match's signals. */
  function chart(signal, w, h, marks = []) {
    const a = D.series[signal];
    if (!a) return '';
    const vals = a.filter((v) => v != null);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (signal !== 'voltage') lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.08 || 1;
    hi += pad;
    if (signal === 'voltage') lo -= pad;
    const y = (v) => h - ((v - lo) / (hi - lo)) * h;
    const x = (i) => (i / (a.length - 1)) * w;
    const d = a.map((v, i) => (v == null ? '' : `${i && a[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
    const span = D.range[1] - D.range[0];
    const ticks = marks
      .filter((m) => m >= D.range[0] && m <= D.range[1])
      .map((m) => `<line x1="${(((m - D.range[0]) / span) * w).toFixed(1)}" x2="${(((m - D.range[0]) / span) * w).toFixed(1)}" y1="0" y2="${h}" class="ch-mark"/>`)
      .join('');
    const modes = D.modes.map((m) => `<rect x="${(((m.start - D.range[0]) / span) * w).toFixed(1)}" width="${(((m.end - m.start) / span) * w).toFixed(1)}" y="0" height="${h}" class="ch-${m.mode}"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${modes}<path d="${d}" class="ch-line"/>${ticks}</svg>`;
  }

  function build() {
    const flags = [];
    const where = new Map();
    const columns = D.columns.map((col, ci) => {
      const cells = [];
      const walk = (rows, depth, path, shown) => {
        let reds = 0;
        for (const r of rows) {
          const kids = r.children || [];
          const open = S.open.has(r.id);
          const checked = S.checked.has(r.id);
          const red = !!(r.j && r.j.flagged) && !checked;
          where.set(r.id, { col: ci, path });
          if (red) flags.push(r.id);
          const cell = { row: r, col: ci, depth, kids: kids.length, open, red, checked, hidden: 0, sel: false };
          if (shown) cells.push(cell);
          const inner = kids.length ? walk(kids, depth + 1, [...path, r.id], shown && open) : 0;
          if (!open) cell.hidden = inner;
          reds += inner + (red ? 1 : 0);
        }
        return reds;
      };
      const reds = walk(col.rows, 0, [], true);
      return { id: col.id, title: col.title, cells, reds };
    });
    // the cursor starts on the first red row (or the row holding it)
    const visible = (id) => columns.some((c) => c.cells.some((x) => x.row.id === id));
    if (!S.sel || !visible(S.sel)) {
      const w = S.sel && where.get(S.sel);
      const anc = w && [...w.path].reverse().find(visible);
      let pick = anc;
      for (const c of columns) if (!pick) pick = c.cells.find((x) => x.red || x.hidden)?.row.id;
      S.sel = pick || columns.find((c) => c.cells.length)?.cells[0].row.id;
    }
    columns.forEach((c) => c.cells.forEach((x) => (x.sel = x.row.id === S.sel)));
    const all = columns.flatMap((c) => c.cells);
    const cur = all.find((x) => x.sel);
    return { columns, flags, where, cur, total: D.columns.reduce((n, c) => n + countFlags(c.rows), 0), checked: S.checked.size, inspect: S.inspect, first: S.first };
  }
  const countFlags = (rows) => rows.reduce((n, r) => n + (r.j && r.j.flagged ? 1 : 0) + countFlags(r.children || []), 0);

  function render() {
    const scrolls = [...root.querySelectorAll('[data-scroll]')].map((e) => e.scrollTop);
    const model = build();
    cfg.render(model, root);
    root.querySelectorAll('[data-scroll]').forEach((e, i) => (e.scrollTop = scrolls[i] || 0));
    root.querySelector('[data-cell].sel')?.scrollIntoView({ block: 'nearest' });
    S.first = false;
    cfg.after?.(model, S.last, root);
    S.last = { reds: model.flags.length, sel: S.sel };
  }

  const toggle = (id, force) => {
    if (force ?? !S.open.has(id)) S.open.add(id);
    else S.open.delete(id);
  };
  const find = (model, id) => {
    for (const c of model.columns) {
      const i = c.cells.findIndex((x) => x.row.id === id);
      if (i >= 0) return { c, i, cell: c.cells[i] };
    }
  };

  function key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const m = build();
    const at = find(m, S.sel);
    if (!at) return;
    const ci = m.columns.indexOf(at.c);
    let h = true;
    switch (e.key) {
      case 'ArrowDown': S.sel = at.c.cells[Math.min(at.c.cells.length - 1, at.i + 1)].row.id; break;
      case 'ArrowUp': S.sel = at.c.cells[Math.max(0, at.i - 1)].row.id; break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const d = e.key === 'ArrowRight' ? 1 : -1;
        for (let k = ci + d; k >= 0 && k < m.columns.length; k += d) {
          const col = m.columns[k];
          if (col.cells.length) { S.sel = col.cells[Math.min(col.cells.length - 1, at.i)].row.id; break; }
        }
        break;
      }
      case ' ': if (at.cell.kids) toggle(S.sel); break;
      case 'Enter': S.inspect = !S.inspect; break;
      case 'Escape': if (S.inspect) S.inspect = false; else h = false; break;
      case 'x': if (at.cell.red || at.cell.checked) { S.checked.has(S.sel) ? S.checked.delete(S.sel) : S.checked.add(S.sel); cfg.onCheck?.(S.checked.has(S.sel)); } break;
      case 'j':
      case 'k': {
        if (!m.flags.length) break;
        const i = m.flags.indexOf(S.sel);
        const n = m.flags[(i < 0 ? (e.key === 'j' ? 0 : m.flags.length - 1) : i + (e.key === 'j' ? 1 : -1) + m.flags.length) % m.flags.length];
        (m.where.get(n)?.path || []).forEach((p) => toggle(p, true));
        S.sel = n;
        break;
      }
      case 'e': {
        const tops = D.columns[ci].rows.filter((r) => r.children && r.children.length);
        const anyClosed = tops.some((r) => !S.open.has(r.id));
        tops.forEach((r) => toggle(r.id, anyClosed));
        break;
      }
      default: h = false;
    }
    if (h) { e.preventDefault(); render(); }
  }

  function click(e) {
    const el = e.target.closest('[data-cell]');
    if (!el) return;
    const id = el.dataset.cell;
    const m = build();
    const at = find(m, id);
    if (!at) return;
    if (e.target.closest('[data-check]')) { S.checked.has(id) ? S.checked.delete(id) : S.checked.add(id); cfg.onCheck?.(S.checked.has(id)); render(); return; }
    S.sel = id;
    if (at.cell.kids) { toggle(id); S.inspect = false; } else S.inspect = true;
    render();
  }

  function start(config) {
    cfg = config;
    root = document.getElementById('app');
    root.addEventListener('click', click);
    root.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-cell]');
      if (el) { S.sel = el.dataset.cell; S.inspect = true; render(); }
    });
    document.addEventListener('mousedown', (e) => {
      if (S.inspect && !e.target.closest('[data-keep], [data-cell]')) { S.inspect = false; render(); }
    });
    window.addEventListener('keydown', key);
    render();
  }

  /** Counts a number up from 0 (used once, on load). */
  function countUp(el, to, digits = 0, ms = 700) {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)), digits);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => (el.textContent = fmt(to, digits)), ms + 80); // in case the tab is hidden and frames are paused
  }

  window.PV = { D, S, start, render, fmt, t, delta, spark, gauge, chart, countUp, build };
})();
