import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { computeStats, findProblems, type ChartId, type Problem, type Severity } from '../../lib/analysis';
import { Icon } from '../Icon';
import { useChecked } from './Overview';
import type { ViewCtx } from './types';

/**
 * Summary screen: the robot's systems as a map of widgets. Parts with trouble
 * light up; arrow keys move, Space ticks a part off, Enter shows it on the graphs.
 */
type Part = 'battery' | 'power' | 'rio' | 'radio' | 'motors' | 'code' | 'can';
type Status = 'ok' | 'warn' | 'bad';

const FINDINGS: Record<Part, string[]> = {
  battery: ['brownout', 'brownout-counter', 'volt-low', 'volt-sag', 'volt-start'],
  power: [],
  rio: ['rail-v12', 'rail-v5', 'rail-v3_3', 'rio-mem', 'cpu', 'laptop-batt'],
  radio: ['comms-enabled', 'comms', 'network', 'radio-fw'],
  motors: [],
  code: ['code-stall', 'loop', 'crash', 'watchdog', 'errors'],
  can: ['can-devices', 'can-util'],
};
const LABEL: Record<Part, string> = { battery: 'Battery', power: 'Power', rio: 'roboRIO', radio: 'Radio', motors: 'Motors', code: 'Code', can: 'CAN' };
const CHART: Record<Part, ChartId> = { battery: 'voltage', power: 'current', rio: 'cpu', radio: 'comms', motors: 'channels', code: 'cpu', can: 'cpu' };
const TAG: Partial<Record<Part, string>> = { radio: 'comms', code: 'loop', can: 'can', rio: 'rail' };
// grid position (column, row) and arrow-key neighbours
const POS: Record<Part, [number, number]> = { battery: [1, 1], power: [2, 1], rio: [3, 1], radio: [4, 1], motors: [2, 2], code: [3, 2], can: [4, 2] };
const WIRES: [Part, Part][] = [['battery', 'power'], ['power', 'rio'], ['rio', 'radio'], ['power', 'motors'], ['rio', 'code'], ['rio', 'can']];
const ORDER: Part[] = ['radio', 'rio', 'battery', 'code', 'can', 'power', 'motors'];

function neighbour(p: Part, key: string): Part | undefined {
  const [c, r] = POS[p];
  const dc = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  const dr = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!dc && !dr) return undefined;
  const all = (Object.keys(POS) as Part[]).filter((q) => q !== p);
  // nearest part in that direction
  const cands = all.filter((q) => (dc ? Math.sign(POS[q][0] - c) === dc && POS[q][1] === r : Math.sign(POS[q][1] - r) === dr));
  const pool = cands.length ? cands : all.filter((q) => (dc ? Math.sign(POS[q][0] - c) === dc : Math.sign(POS[q][1] - r) === dr));
  return pool.sort((a, b) => Math.abs(POS[a][0] - c) + Math.abs(POS[a][1] - r) - (Math.abs(POS[b][0] - c) + Math.abs(POS[b][1] - r)))[0];
}

const worst = (ps: Problem[]): Status => (ps.some((p) => p.severity === 'bad') ? 'bad' : ps.some((p) => p.severity === 'warn') ? 'warn' : 'ok');
const fix1 = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

/** Downsampled sparkline path over [i0, i1). `mode` picks min (voltage dips) or max (current spikes). */
function sparkPath(arr: ArrayLike<number>, i0: number, i1: number, w: number, h: number, lo: number, hi: number, mode: 'min' | 'max' | 'avg') {
  const n = 160, per = Math.max(1, Math.floor((i1 - i0) / n));
  let d = '';
  let pen = false;
  for (let k = 0; k < n; k++) {
    const a = i0 + k * per;
    if (a >= i1) break;
    let v = mode === 'min' ? Infinity : mode === 'max' ? -Infinity : 0, c = 0;
    for (let j = a; j < Math.min(a + per, i1); j++) {
      const x = arr[j];
      if (Number.isNaN(x)) continue;
      v = mode === 'min' ? Math.min(v, x) : mode === 'max' ? Math.max(v, x) : v + x;
      c++;
    }
    if (!c) { pen = false; continue; }
    if (mode === 'avg') v /= c;
    const x = (k / (n - 1)) * w, y = h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function RobotMap({ ctx }: { ctx: ViewCtx }) {
  const { parsed, tf } = ctx;
  const { log, events, analysis } = parsed;
  const span = analysis.focus;
  const stats = useMemo(() => computeStats(log, events, analysis, span), [log, events, analysis, span]);
  const problems = useMemo(() => findProblems(log, events, analysis, stats).filter((p) => p.severity !== 'info'), [log, events, analysis, stats]);
  const [checked, toggle] = useChecked(ctx.entry.key);

  const byPart = useMemo(() => {
    const m = {} as Record<Part, Problem[]>;
    (Object.keys(FINDINGS) as Part[]).forEach((p) => (m[p] = problems.filter((x) => FINDINGS[p].includes(x.id))));
    return m;
  }, [problems]);
  const status = (p: Part): Status => (p === 'power' && stats.brownouts.count ? 'bad' : worst(byPart[p]));
  const [focus, setFocus] = useState<Part>(() => ORDER.find((p) => status(p) === 'bad') ?? ORDER.find((p) => status(p) === 'warn') ?? 'battery');

  const open = (p: Part) => {
    const first = byPart[p].find((x) => x.t != null && Number.isFinite(x.t));
    if (first && log) ctx.jumpTo(first.t!, { chart: first.chart ?? CHART[p] });
    else ctx.setTab('graphs');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = neighbour(focus, e.key);
      if (n) { setFocus(n); e.preventDefault(); }
      else if (e.key === ' ') { toggle(focus); e.preventDefault(); }
      else if (e.key === 'Enter') { open(focus); e.preventDefault(); }
      else if (e.key === 'n') {
        const todo = ORDER.filter((p) => status(p) !== 'ok' && !checked.has(p));
        if (todo.length) setFocus(todo[(todo.indexOf(focus) + 1) % todo.length]);
      } else if (e.key === 'm' && TAG[focus] && events) ctx.showEvents({ tag: TAG[focus] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const railN = byPart.rio.filter((p) => p.id.startsWith('rail-')).reduce((a, p) => a + Number(/(\d+)×/.exec(p.title)?.[1] ?? 0), 0);
  const canN = analysis.canDevices.reduce((a, d) => a + d.count, 0);
  const loopN = Number(/(\d+)×/.exec(byPart.code.find((p) => p.id === 'loop')?.title ?? '')?.[1] ?? 0);
  const topCh = useMemo(() => [...stats.channels].filter((c) => c.peak > 0.5).sort((a, b) => b.ah - a.ah).slice(0, 12), [stats]);
  const maxAh = Math.max(...topCh.map((c) => c.ah), 0.001);

  const VALUE: Record<Part, [string, string]> = {
    battery: [fix1(stats.voltage.min, 2), 'V low'],
    power: [fix1(stats.current.peak, 0), 'A peak'],
    rio: railN ? [String(railN), railN === 1 ? 'fault' : 'faults'] : [fix1(stats.cpu.avg, 0), '% CPU'],
    radio: [String(stats.comms.enabledDrops), stats.comms.enabledDrops === 1 ? 'drop' : 'drops'],
    motors: [fix1(stats.current.ah, 1), 'Ah'],
    code: stats.codeStalls.count ? [fix1(stats.codeStalls.duration, 1), 's frozen'] : [String(loopN), 'overruns'],
    can: [String(canN), 'msgs'],
  };
  const ICON: Record<Part, Parameters<typeof Icon>[0]['name']> = { battery: 'battery', power: 'bolt', rio: 'cpu', radio: 'wifi', motors: 'gauge', code: 'activity', can: 'plug' };

  // sparkline for the focused part, over the match
  const i0 = log ? Math.max(0, Math.floor(span.start / log.period)) : 0;
  const i1 = log ? Math.min(log.count, Math.ceil(span.end / log.period)) : 0;
  const W = 600, H = 110;
  const chart = (p: Part): ReactNode => {
    if (!log) return null;
    const markX = (t: number) => ((t - span.start) / (span.end - span.start)) * W;
    const marks = byPart[p].filter((x) => x.t != null && Number.isFinite(x.t) && x.t! >= span.start && x.t! <= span.end);
    const series =
      p === 'battery' ? sparkPath(log.voltage, i0, i1, W, H, 5, 14, 'min')
        : p === 'power' || p === 'motors' ? sparkPath(log.totalCurrent, i0, i1, W, H, 0, Math.max(stats.current.peak, 1), 'max')
          : p === 'radio' ? sparkPath(log.tripMs, i0, i1, W, H, 0, Math.max(stats.trip.max, 5), 'avg')
            : p === 'can' ? sparkPath(log.can, i0, i1, W, H, 0, 100, 'avg')
              : sparkPath(log.cpu, i0, i1, W, H, 0, 100, 'avg');
    const bands = p === 'radio' ? analysis.noComms : p === 'code' ? analysis.codeStalls : p === 'battery' ? analysis.brownouts : [];
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="rm-spark">
        {bands.filter((b) => b.end >= span.start && b.start <= span.end).map((b, k) => (
          <rect key={k} x={markX(b.start)} y={0} width={Math.max(2, markX(b.end) - markX(b.start))} height={H} className={`rm-band ${p === 'code' ? 'warn' : 'bad'}`} />
        ))}
        {p === 'battery' && <line x1={0} x2={W} y1={H - ((7 - 5) / 9) * H} y2={H - ((7 - 5) / 9) * H} className="rm-threshold" />}
        <path d={series} className={`rm-line ${p}`} />
        {marks.map((x) => <line key={x.id} x1={markX(x.t!)} x2={markX(x.t!)} y1={0} y2={H} className={`rm-mark ${x.severity}`} />)}
      </svg>
    );
  };

  const f = focus;
  const fs = status(f);
  const todoCount = ORDER.filter((p) => status(p) !== 'ok' && !checked.has(p)).length;

  return (
    <div className="page rm-page">
      <div className="rm">
        <div className="rm-map">
          <svg className="rm-wires" viewBox="0 0 400 200" preserveAspectRatio="none">
            {WIRES.map(([a, b]) => {
              const [ac, ar] = POS[a], [bc, br] = POS[b];
              const x1 = (ac - 0.5) * 100, y1 = (ar - 0.5) * 100, x2 = (bc - 0.5) * 100, y2 = (br - 0.5) * 100;
              const hot = status(a) === 'bad' && status(b) === 'bad';
              // straight when aligned, otherwise dog-leg through the gap between rows
              const d = x1 === x2 || y1 === y2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}V100H${x2}V${y2}`;
              return <path key={a + b} d={d} className={`rm-wire ${hot ? 'hot' : ''}`} vectorEffect="non-scaling-stroke" />;
            })}
          </svg>
          {(Object.keys(POS) as Part[]).map((p) => {
            const s = status(p);
            return (
              <button
                key={p}
                className={`rm-node ${s} ${p === f ? 'focus' : ''} ${checked.has(p) ? 'done' : ''}`}
                style={{ gridColumn: POS[p][0], gridRow: POS[p][1] }}
                onClick={() => setFocus(p)}
                onDoubleClick={() => open(p)}
              >
                <span className={`rm-light ${checked.has(p) ? 'checked' : s}`}>{checked.has(p) && <Icon name="check" size={11} />}</span>
                <Icon name={ICON[p]} size={26} />
                <span className="rm-label">{LABEL[p]}</span>
                {p === 'motors' ? (
                  <span className="rm-bars">
                    {topCh.map((c) => <i key={c.ch} style={{ height: `${Math.max(10, (c.ah / maxAh) * 100)}%` }} />)}
                  </span>
                ) : (
                  <span className="rm-val">
                    {VALUE[p][0]}
                    <small>{VALUE[p][1].split(' ')[0]}</small>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <aside className={`rm-detail ${fs}`}>
          <div className="rm-dhead">
            <span className={`rm-light ${fs}`} />
            <h2>{LABEL[f]}</h2>
          </div>
          <div className="rm-dval">
            {VALUE[f][0]}
            <small>{VALUE[f][1]}</small>
          </div>
          {log && (
            <div className="rm-chart">
              {chart(f)}
              <div className="rm-axis">
                <span>{tf.fmt(span.start)}</span>
                <span>{tf.fmt(span.end)}</span>
              </div>
            </div>
          )}
          <div className="rm-fixes">
            {byPart[f].length ? (
              byPart[f].map((p) => (
                <div key={p.id} className="rm-fix">
                  <span className={`rm-light ${p.severity as Severity}`} />
                  <div>
                    <b>{p.title}</b>
                    {p.fix && <span>{p.fix}</span>}
                  </div>
                </div>
              ))
            ) : (
              <div className="rm-ok">
                <Icon name="check" size={18} /> Nothing wrong here
              </div>
            )}
          </div>
          <div className="rm-left">{todoCount ? `${todoCount} part${todoCount === 1 ? '' : 's'} left to check` : 'All parts checked'}</div>
        </aside>
      </div>
    </div>
  );
}
