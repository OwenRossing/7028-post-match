import { useEffect, useMemo, useRef } from 'react';
import type { Span } from '../../lib/analysis';
import { MIN_HISTORY, type Judgement } from '../../lib/baseline';
import type { Instance, Row, SpanKind, Trace } from '../../lib/board';
import type { DSLog } from '../../lib/dslog';
import { deltaText, fmtNumber, rowLabel, type Cell } from './Board';
import type { ViewCtx } from './types';

interface Props {
  ctx: ViewCtx;
  cell: Cell;
  column: string;
  range: Span;
  instance: number;
  setInstance: (i: number) => void;
  side: 'left' | 'right';
  onClose: () => void;
  onGraphs: () => void;
  onMessages: () => void;
}

const val = (r: Row, v: number) => `${fmtNumber(v, r.digits)}${r.unit ? ` ${r.unit}` : ''}`;

/** The detail behind one board row: how it compares, when it happened, and what was said about it. */
export function Inspector({ ctx, cell, column, range, instance, setInstance, side, onClose, onGraphs, onMessages }: Props) {
  const { row: r, j, tone } = cell;
  const problems = ctx.problems.filter((p) => p.severity !== 'info' && r.problems?.includes(p.id));
  const list: Instance[] = r.instances ?? (r.at != null ? [{ t: r.at }] : []);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the list, not the panel around it.
    const box = listRef.current;
    const on = box?.querySelector<HTMLElement>('.on');
    if (!box || !on) return;
    if (on.offsetTop < box.scrollTop) box.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = on.offsetTop + on.offsetHeight - box.clientHeight;
  }, [instance, r.id]);

  const messages = useMemo(() => {
    const evs = ctx.parsed.events?.events ?? [];
    const groups = new Map<string, { text: string; n: number; t: number; level: string }>();
    for (const id of r.eventIds ?? []) {
      const e = evs[id];
      if (!e) continue;
      const g = groups.get(e.sig) ?? { text: e.text.split('\n')[0], n: 0, t: e.t, level: e.level };
      g.n++;
      groups.set(e.sig, g);
    }
    return [...groups.values()].sort((a, b) => b.n - a.n);
  }, [r, ctx.parsed.events]);

  return (
    <aside className={`insp insp-${side}`} role="dialog" aria-label={`${rowLabel(r, ctx)} details`}>
      <div className="insp-scroll">
        <div className="insp-head">
          <div className="insp-crumb">
            {[column, ...cell.path.map((p) => rowLabel(p, ctx))].map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
          <button className="insp-close" onClick={onClose} aria-label="Close">
            <kbd>Esc</kbd>
          </button>
        </div>

        <div className="insp-hero">
          <div className="insp-title">
            <h2>{rowLabel(r, ctx)}</h2>
            {r.sub && <span className="insp-sub">{r.sub}</span>}
          </div>
          {Number.isFinite(r.value) && (
            <div className={`insp-value ${tone ?? ''}`}>
              {fmtNumber(r.value, r.digits)}
              {r.unit && <small>{r.unit}</small>}
            </div>
          )}
          <Verdict row={r} j={j} failsCheck={problems.length > 0} />
          {r.hint && <p className="insp-hint">{r.hint}</p>}
        </div>

        {j && j.enough && (
          <section className="insp-sec">
            <h3>Last {j.n} matches</h3>
            <HistoryChart row={r} j={j} tone={tone} />
          </section>
        )}

        {r.trace && (
          <section className="insp-sec">
            <h3>
              This match
              <span>
                <kbd>G</kbd> open in graphs
              </span>
            </h3>
            <TraceChart ctx={ctx} row={r} trace={r.trace} range={range} marks={list} active={instance} />
          </section>
        )}

        {list.length > 1 && (
          <section className="insp-sec">
            <h3>
              {list.length} times
              <span>
                <kbd>←</kbd>
                <kbd>→</kbd> step through
              </span>
            </h3>
            <div className="insp-list" ref={listRef}>
              {list.map((x, i) => (
                <button
                  key={i}
                  className={`insp-item ${i === instance ? 'on' : ''}`}
                  onClick={() => setInstance(i)}
                  onDoubleClick={onGraphs}
                >
                  <span className="t">{ctx.tf.fmt(x.t)}</span>
                  <span className="l">{x.label ?? ''}</span>
                  <span className="v">
                    {x.value != null ? (x.end != null ? `${fmtNumber(x.value, x.value < 10 ? 2 : 1)} s` : val(r, x.value)) : ''}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {problems.map((p) => (
          <section key={p.id} className={`insp-finding ${p.severity}`}>
            <b>{p.title}</b>
            <p>{p.detail}</p>
            {p.fix && <p className="insp-fix">{p.fix}</p>}
          </section>
        ))}

        {messages.length > 0 && (
          <section className="insp-sec">
            <h3>
              Messages
              <span>
                <kbd>M</kbd> open all
              </span>
            </h3>
            <div className="insp-msgs">
              {messages.slice(0, 8).map((m, i) => (
                <button key={i} className={`insp-msg ${m.level}`} onClick={onMessages}>
                  <span className="n">×{m.n}</span>
                  <span className="txt">{m.text}</span>
                  <span className="t">{ctx.tf.fmt(m.t)}</span>
                </button>
              ))}
              {messages.length > 8 && <div className="muted insp-more">{messages.length - 8} more kinds of message</div>}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function Verdict({ row: r, j, failsCheck }: { row: Row; j?: Judgement; failsCheck: boolean }) {
  if (!r.better) return null;
  if (!j) return null;
  if (!j.enough)
    return (
      <p className="insp-verdict muted">
        Not compared yet: {j.n} of {MIN_HISTORY} earlier matches have this.
      </p>
    );
  const lo = Math.max(0, j.mean - 2 * j.spread);
  const hi = j.mean + 2 * j.spread;
  const usual = `${fmtNumber(lo, r.digits)}–${fmtNumber(hi, r.digits)}${r.unit ? ` ${r.unit}` : ''}`;
  if (j.flagged)
    return (
      <p className="insp-verdict bad">
        <b>{deltaText(r, j)}</b> · usually {usual}
      </p>
    );
  // Usual for this robot can still be bad (every match dipping under 7 V), so don't sound like an all-clear then.
  if (failsCheck)
    return (
      <p className="insp-verdict">
        <b>Usual for this robot</b> ({usual}), but still a problem
      </p>
    );
  return (
    <p className="insp-verdict ok">
      <b>Normal</b> · usually {usual}
    </p>
  );
}

// ---------- Charts ----------

const W = 1000;

function HistoryChart({ row: r, j, tone }: { row: Row; j: Judgement; tone: Cell['tone'] }) {
  const H = 150;
  const vals = [...j.history.map((h) => h.value), j.value];
  const lo2 = j.mean - 2 * j.spread;
  const hi2 = j.mean + 2 * j.spread;
  const allPos = vals.every((v) => v >= 0);
  // Bars from zero, except for numbers that never get near it (battery voltage).
  const floorAtZero = allPos && Math.min(...vals, lo2) < Math.max(...vals, hi2) * 0.6;
  let lo = floorAtZero ? 0 : Math.min(...vals, lo2);
  let hi = Math.max(...vals, hi2, lo + 1e-6);
  const pad = (hi - lo) * 0.08;
  if (!floorAtZero) lo -= pad;
  hi += pad;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const n = vals.length;
  const slot = W / n;
  const bw = Math.min(slot * 0.62, 60);
  const labels = [...j.history.map((h) => h.label), 'This'];
  return (
    <div className="hchart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="hchart-svg">
        <rect x={0} y={y(Math.min(hi2, hi))} width={W} height={Math.max(0, y(Math.max(lo2, lo)) - y(Math.min(hi2, hi)))} className="band" />
        <line x1={0} x2={W} y1={y(j.mean)} y2={y(j.mean)} className="mean" vectorEffect="non-scaling-stroke" />
        {vals.map((v, i) => {
          const x = i * slot + (slot - bw) / 2;
          const base = floorAtZero ? y(0) : H;
          const top = Math.min(y(v), base - 2);
          const cur = i === n - 1;
          return (
            <rect key={i} x={x} y={top} width={bw} height={Math.max(2, base - top)} rx={3} className={cur ? `cur ${tone ?? ''}` : 'past'} />
          );
        })}
      </svg>
      <div className="hchart-labels">
        {labels.map((l, i) => (
          <span key={i} className={i === n - 1 ? 'cur' : ''} title={`${l}: ${val(r, vals[i])}`}>
            {l}
          </span>
        ))}
      </div>
      <div className="hchart-legend">
        <span>
          <i className="lg-band" /> usual range
        </span>
        <span>
          <i className="lg-mean" /> average
        </span>
      </div>
    </div>
  );
}

function signalOf(log: DSLog, t: Extract<Trace, { kind: 'series' }>) {
  switch (t.signal) {
    case 'voltage':
      return log.voltage;
    case 'total':
      return log.totalCurrent;
    case 'channel':
      return log.currents[t.ch ?? 0];
    case 'loss':
      return log.packetLoss;
    case 'trip':
      return log.tripMs;
    case 'cpu':
      return log.cpu;
    case 'can':
      return log.can;
  }
}

const SIGNAL_UNIT: Record<string, string> = { voltage: 'V', total: 'A', channel: 'A', loss: '%', trip: 'ms', cpu: '%', can: '%' };

function TraceChart({
  ctx,
  row: r,
  trace,
  range,
  marks,
  active,
}: {
  ctx: ViewCtx;
  row: Row;
  trace: Trace;
  range: Span;
  marks: Instance[];
  active: number;
}) {
  const H = 170;
  const { log, analysis } = ctx.parsed;
  const span = Math.max(range.end - range.start, 1e-6);
  const x = (t: number) => ((t - range.start) / span) * W;
  const inRange = (s: Span) => s.end > range.start && s.start < range.end;
  const spansOf = (k?: SpanKind) =>
    k === 'brownouts' ? analysis.brownouts : k === 'noComms' ? analysis.noComms : k === 'stalls' ? analysis.codeStalls : [];

  const plot = useMemo(() => {
    if (trace.kind === 'series' && log) {
      const arr = signalOf(log, trace);
      const bins = 500;
      const i0 = Math.max(0, Math.floor(range.start / log.period));
      const i1 = Math.min(log.count - 1, Math.ceil(range.end / log.period));
      const useMin = trace.signal === 'voltage';
      const pts: [number, number][] = [];
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = 0; b < bins; b++) {
        const a = i0 + Math.floor(((i1 - i0) * b) / bins);
        const z = Math.max(a + 1, i0 + Math.floor(((i1 - i0) * (b + 1)) / bins));
        let v = useMin ? Infinity : -Infinity;
        for (let i = a; i < z; i++) {
          const s = arr[i];
          if (Number.isNaN(s)) continue;
          v = useMin ? Math.min(v, s) : Math.max(v, s);
        }
        if (!Number.isFinite(v)) continue;
        pts.push([range.start + ((b + 0.5) / bins) * span, v]);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (trace.threshold != null) {
        lo = Math.min(lo, trace.threshold);
        hi = Math.max(hi, trace.threshold);
      }
      if (!pts.length) return null;
      if (!useMin) lo = Math.min(0, lo);
      else lo -= 0.4;
      hi += (hi - lo) * 0.1 || 1;
      return { kind: 'series' as const, pts, lo, hi, unit: SIGNAL_UNIT[trace.signal] };
    }
    if (trace.kind === 'points') {
      const pts = marks.filter((m) => m.value != null).map((m) => [m.t, m.value!] as [number, number]);
      if (!pts.length) return null;
      let lo = Math.min(...pts.map((p) => p[1]));
      let hi = Math.max(...pts.map((p) => p[1]));
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.2 || 1;
      lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
      hi += pad;
      return { kind: 'points' as const, pts, lo, hi, unit: r.unit };
    }
    // Events: how many per slice of the match.
    const bins = 60;
    const counts = new Array(bins).fill(0);
    for (const m of marks) {
      const b = Math.floor(((m.t - range.start) / span) * bins);
      if (b >= 0 && b < bins) counts[b]++;
    }
    return { kind: 'events' as const, counts, lo: 0, hi: Math.max(1, ...counts) * 1.15, unit: '' };
  }, [trace, log, range, marks, span, r.unit]);

  if (!plot) return <div className="tchart-empty muted">No data for this in the log.</div>;
  const y = (v: number) => H - ((v - plot.lo) / (plot.hi - plot.lo)) * H;
  const cur = marks[active];

  let path = '';
  let area = '';
  if (plot.kind === 'series') {
    path = plot.pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    area = `${path}L${x(plot.pts[plot.pts.length - 1][0]).toFixed(1)},${H}L${x(plot.pts[0][0]).toFixed(1)},${H}Z`;
  }
  const spans = trace.kind === 'series' ? spansOf(trace.spans).filter(inRange) : [];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => range.start + f * span);

  return (
    <div className="tchart">
      <div className="tchart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {analysis.modes
            .filter((m) => (m.mode === 'auto' || m.mode === 'teleop') && inRange(m))
            .map((m, i) => (
              <rect
                key={`m${i}`}
                x={x(Math.max(m.start, range.start))}
                width={Math.max(1, x(Math.min(m.end, range.end)) - x(Math.max(m.start, range.start)))}
                y={0}
                height={H}
                className={`mode ${m.mode}`}
              />
            ))}
          {spans.map((s, i) => (
            <rect
              key={`s${i}`}
              x={x(Math.max(s.start, range.start))}
              width={Math.max(2, x(Math.min(s.end, range.end)) - x(Math.max(s.start, range.start)))}
              y={0}
              height={H}
              className={`span ${trace.kind === 'series' ? trace.spans : ''}`}
            />
          ))}
          {trace.kind === 'series' && trace.threshold != null && (
            <line x1={0} x2={W} y1={y(trace.threshold)} y2={y(trace.threshold)} className="thresh" vectorEffect="non-scaling-stroke" />
          )}
          {plot.kind === 'series' && (
            <>
              <path d={area} className="area" />
              <path d={path} className="line" vectorEffect="non-scaling-stroke" />
            </>
          )}
          {plot.kind === 'events' &&
            plot.counts.map((c, i) =>
              c ? (
                <rect
                  key={i}
                  x={(i / plot.counts.length) * W + 1.5}
                  width={W / plot.counts.length - 3}
                  y={y(c)}
                  height={H - y(c)}
                  rx={2}
                  className="tc-bar"
                />
              ) : null,
            )}
          {plot.kind === 'points' && plot.pts.length > 1 && (
            <path
              d={plot.pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t)},${y(v)}`).join('')}
              className="line faint"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {marks.length <= 300 &&
            marks.map((m, i) =>
              plot.kind === 'series' || plot.kind === 'events' ? (
                <line
                  key={`k${i}`}
                  x1={x(m.t)}
                  x2={x(m.t)}
                  y1={0}
                  y2={H}
                  className={`tick ${i === active ? 'on' : ''}`}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
        </svg>
        {plot.kind === 'points' &&
          plot.pts.map(([t, v], i) => (
            <i
              key={i}
              className={`tc-dot ${i === active ? 'on' : ''}`}
              style={{ left: `${(x(t) / W) * 100}%`, top: `${(y(v) / H) * 100}%` }}
            />
          ))}
        {cur && plot.kind === 'series' && <i className="cursor" style={{ left: `${(x(cur.t) / W) * 100}%` }} />}
        <span className="tchart-y top">
          {fmtNumber(plot.hi, plot.hi < 10 ? 1 : 0)} {plot.unit}
        </span>
        <span className="tchart-y bottom">{fmtNumber(plot.lo, plot.lo !== 0 && Math.abs(plot.lo) < 10 ? 1 : 0)}</span>
      </div>
      <div className="tchart-x">
        {ticks.map((t, i) => (
          <span key={i} style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}>
            {ctx.tf.fmt(t).replace(/\.\d+$/, '')}
          </span>
        ))}
      </div>
    </div>
  );
}
