import { useEffect, useMemo, useState } from 'react';
import { computeStats, findProblems, verdictOf, type Stats } from '../lib/analysis';
import { ChartGroup } from '../lib/chartGroup';
import type { DSLog } from '../lib/dslog';
import type { LogEntry } from '../lib/library';
import type { ChartTheme } from '../lib/theme';
import { fmtClock, fmtDateTime, fmtDuration, fmtSpan } from '../lib/time';
import { loadParsed } from '../lib/useParsed';
import type { ParsedLog } from '../lib/workerClient';
import { Icon } from './Icon';
import { TimeChart } from './TimeChart';

type Align = 'match' | 'enable' | 'log';
type Metric = 'voltage' | 'totalCurrent' | 'tripMs' | 'cpu' | 'can' | 'packetLoss';

const METRICS: { id: Metric; label: string; unit: string; digits: number; range?: (min: number | null, max: number | null) => [number, number] }[] = [
  { id: 'voltage', label: 'Battery voltage', unit: 'V', digits: 2, range: (min, max) => [Math.min(min ?? 6.3, 6.3), Math.max(max ?? 13, 13)] },
  { id: 'totalCurrent', label: 'Total current', unit: 'A', digits: 1, range: (_m, max) => [0, Math.max((max ?? 10) * 1.08, 10)] },
  { id: 'tripMs', label: 'Trip time', unit: 'ms', digits: 1, range: (_m, max) => [0, Math.max((max ?? 10) * 1.1, 10)] },
  { id: 'packetLoss', label: 'Packet loss', unit: '%', digits: 0, range: () => [0, 100] },
  { id: 'cpu', label: 'roboRIO CPU', unit: '%', digits: 0, range: () => [0, 100] },
  { id: 'can', label: 'CAN utilization', unit: '%', digits: 0, range: () => [0, 100] },
];

interface Loaded {
  entry: LogEntry;
  parsed: ParsedLog;
  stats: Stats;
  verdict: 'ok' | 'warn' | 'bad';
}

function offsetFor(p: ParsedLog, align: Align): number {
  if (align === 'log') return 0;
  const a = p.analysis;
  if (align === 'match' && a.match) return a.match.start;
  return a.runs[0]?.start ?? 0;
}

export function Compare({
  entries,
  theme,
  onOpen,
  onRemove,
  onClose,
}: {
  entries: LogEntry[];
  theme: ChartTheme;
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [align, setAlign] = useState<Align>('match');
  const [metrics, setMetrics] = useState<Set<Metric>>(new Set(['voltage', 'totalCurrent', 'tripMs', 'cpu']));
  const keys = entries.map((e) => e.key).join('|');

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    Promise.all(entries.map((e) => loadParsed(e).then((parsed) => ({ entry: e, parsed }))))
      .then((list) => {
        if (cancelled) return;
        setLoaded(
          list
            .filter((l) => l.parsed.log)
            .map(({ entry, parsed }) => {
              const stats = computeStats(parsed.log, parsed.events, parsed.analysis, parsed.analysis.focus);
              return { entry, parsed, stats, verdict: verdictOf(findProblems(parsed.log, parsed.events, parsed.analysis, stats)) };
            }),
        );
      })
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  const aligned = useMemo(() => {
    if (!loaded?.length) return null;
    const period = 0.02;
    const offsets = loaded.map((l) => offsetFor(l.parsed, align));
    const logs = loaded.map((l) => l.parsed.log!) as DSLog[];
    const minA = Math.min(...offsets.map((o) => -o));
    const maxA = Math.max(...logs.map((log, i) => log.count * period - offsets[i]));
    const n = Math.round((maxA - minA) / period) + 1;
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) x[k] = minA + k * period;
    const series = (metric: Metric) =>
      logs.map((log, i) => {
        const out = new Array<number | null>(n).fill(null);
        const src = log[metric];
        const shift = Math.round((-offsets[i] - minA) / period);
        for (let j = 0; j < log.count; j++) {
          const v = src[j];
          if (!Number.isNaN(v)) out[j + shift] = v;
        }
        return out;
      });
    return { x, series, full: { start: minA, end: maxA } };
  }, [loaded, align]);

  const group = useMemo(() => {
    if (!aligned) return null;
    const g = new ChartGroup(aligned.full);
    const anyMatch = align !== 'log' && loaded?.some((l) => l.parsed.analysis.runs.length);
    if (anyMatch) g.setRange(Math.max(aligned.full.start, -5), Math.min(aligned.full.end, 175));
    g.fmt = (t) => fmtDuration(t, 2);
    g.fmtAxis = (t, step) => fmtDuration(t, step < 1 ? 1 : 0);
    return g;
  }, [aligned, align, loaded]);

  if (error)
    return (
      <div className="center-state">
        <div>
          <h2>Couldn't load logs to compare</h2>
          <p>{error}</p>
        </div>
      </div>
    );

  const colors = theme.logColors;
  // Add the start time when two logs share a title (e.g. the same match replayed or re-opened).
  const labelOf = (l: Loaded) => {
    const title = l.parsed.analysis.title;
    const dup = (loaded ?? []).filter((x) => x.parsed.analysis.title === title).length > 1;
    return dup ? `${title} · ${fmtClock(l.entry.startTime, false)}` : title;
  };

  return (
    <div className="viewer">
      <div className="viewer-head" style={{ paddingBottom: 14 }}>
        <div className="viewer-title">
          <div>
            <h1>
              <Icon name="compare" size={20} /> Compare {entries.length} logs
            </h1>
            <div className="viewer-sub">
              <span>Overlay logs to spot a battery, mechanism or network that behaves differently.</span>
            </div>
          </div>
          <div className="viewer-actions">
            <button className="btn" onClick={onClose}>
              <Icon name="x" size={14} /> Done
            </button>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 6 }}>
          {entries.map((e, i) => {
            const l = loaded?.find((x) => x.entry.key === e.key);
            return (
              <span key={e.key} className="chip on" style={{ ['--chip-color' as string]: colors[i % colors.length], cursor: 'default' }}>
                <span className="dot" />
                <button className="btn ghost small" style={{ padding: 0, height: 'auto' }} onClick={() => onOpen(e.key)} title="Open this log">
                  {l ? labelOf(l) : e.summary?.title ?? e.key}
                </button>
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {fmtDateTime(e.startTime)}
                </span>
                <button className="btn ghost small icon" style={{ height: 18, width: 18 }} onClick={() => onRemove(e.key)} title="Remove from comparison">
                  <Icon name="x" size={11} />
                </button>
              </span>
            );
          })}
        </div>
      </div>

      {!loaded || !aligned || !group ? (
        <div className="center-state">
          <div className="row" style={{ justifyContent: 'center' }}>
            <div className="spinner" /> Loading {entries.length} logs…
          </div>
        </div>
      ) : (
        <div className="page">
          <div className="toolbar">
            <span className="label">Line up by</span>
            <div className="seg">
              <button className={align === 'match' ? 'on' : ''} onClick={() => setAlign('match')}>
                Match start
              </button>
              <button className={align === 'enable' ? 'on' : ''} onClick={() => setAlign('enable')}>
                First enable
              </button>
              <button className={align === 'log' ? 'on' : ''} onClick={() => setAlign('log')}>
                Log start
              </button>
            </div>
            <span className="sep" />
            {METRICS.map((m) => (
              <button
                key={m.id}
                className={`chip ${metrics.has(m.id) ? 'on' : ''}`}
                onClick={() =>
                  setMetrics((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })
                }
              >
                {m.label}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn small" onClick={() => group.reset()}>
              <Icon name="maximize" size={13} /> Reset zoom
            </button>
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <div className="card-body">
              <CompareTable loaded={loaded} colors={colors} />
            </div>
          </div>

          {METRICS.filter((m) => metrics.has(m.id)).map((m) => {
            const data = aligned.series(m.id);
            if (m.id === 'totalCurrent' && !loaded.some((l) => l.parsed.log!.channelCount)) return null;
            return (
              <div className="card chart-card" key={m.id}>
                <div className="chart-title">{m.label}</div>
                <TimeChart
                  group={group}
                  x={aligned.x}
                  bands={false}
                  series={loaded.map((l, i) => ({
                    label: labelOf(l),
                    color: colors[i % colors.length],
                    data: data[i],
                    scale: 'y',
                    fmt: (v: number) => `${v.toFixed(m.digits)} ${m.unit}`,
                  }))}
                  axes={[{ scale: 'y', fmt: (v) => `${v}${m.unit}`, range: m.range }]}
                  height={m.id === 'voltage' ? 220 : 170}
                  theme={theme}
                  rev={`cmp|${keys}|${align}|${m.id}|${theme.dark}`}
                  onPin={(t) => group.pin(t, false)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CompareTable({ loaded, colors }: { loaded: Loaded[]; colors: string[] }) {
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const rows: { label: string; value: (s: Stats, l: Loaded) => string; best?: 'min' | 'max'; num?: (s: Stats) => number }[] = [
    { label: 'Scope', value: (_s, l) => (l.parsed.analysis.match ? l.parsed.analysis.match.label : 'Enabled time') },
    { label: 'Enabled', value: (s) => fmtSpan(s.enabledTime) },
    { label: 'Resting battery', value: (s) => `${f(s.voltage.resting, 2)} V`, best: 'max', num: (s) => s.voltage.resting },
    { label: 'Lowest battery', value: (s) => `${f(s.voltage.min, 2)} V`, best: 'max', num: (s) => s.voltage.min },
    { label: 'Average battery', value: (s) => `${f(s.voltage.avg, 2)} V`, best: 'max', num: (s) => s.voltage.avg },
    { label: 'Brownouts', value: (s) => String(s.brownouts.count), best: 'min', num: (s) => s.brownouts.count },
    { label: 'Comms drops (enabled)', value: (s) => String(s.comms.enabledDrops), best: 'min', num: (s) => s.comms.enabledDrops },
    { label: 'Code not responding', value: (s) => `${s.codeStalls.count} (${fmtSpan(s.codeStalls.duration)})`, best: 'min', num: (s) => s.codeStalls.duration },
    { label: 'Trip time avg', value: (s) => `${f(s.trip.avg)} ms`, best: 'min', num: (s) => s.trip.avg },
    { label: 'Packet loss avg', value: (s) => `${f(s.loss.avg)}%`, best: 'min', num: (s) => s.loss.avg },
    { label: 'CPU avg', value: (s) => `${f(s.cpu.avg, 0)}%`, best: 'min', num: (s) => s.cpu.avg },
    { label: 'CAN max', value: (s) => `${f(s.can.max, 0)}%`, best: 'min', num: (s) => s.can.max },
    { label: 'Peak current', value: (s) => (s.current.available ? `${f(s.current.peak, 0)} A` : '–') },
    { label: 'Charge used', value: (s) => (s.current.available ? `${(s.current.ah * 1000).toFixed(0)} mAh` : '–') },
    { label: 'Errors', value: (s) => String(s.events.error), best: 'min', num: (s) => s.events.error },
  ];
  return (
    <table className="data">
      <thead>
        <tr>
          <th />
          {loaded.map((l, i) => (
            <th key={l.entry.key} className="r" style={{ color: colors[i % colors.length] }}>
              {l.parsed.analysis.title}
              <div className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                {fmtDateTime(l.entry.startTime)}
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="muted">Health</td>
          {loaded.map((l) => (
            <td key={l.entry.key} className="r">
              <span className={`badge ${l.verdict === 'ok' ? 'good' : l.verdict}`}>
                {l.verdict === 'ok' ? 'Healthy' : l.verdict === 'warn' ? 'Warnings' : 'Problems'}
              </span>
            </td>
          ))}
        </tr>
        {rows.map((r) => {
          const nums = r.num ? loaded.map((l) => r.num!(l.stats)) : [];
          const finite = nums.filter(Number.isFinite);
          const best = r.best && finite.length > 1 ? (r.best === 'min' ? Math.min(...finite) : Math.max(...finite)) : null;
          const allSame = finite.length > 1 && finite.every((v) => v === finite[0]);
          return (
            <tr key={r.label}>
              <td className="muted">{r.label}</td>
              {loaded.map((l, i) => (
                <td key={l.entry.key} className="r" style={best != null && !allSame && nums[i] === best ? { color: 'var(--good)', fontWeight: 600 } : undefined}>
                  {r.value(l.stats, l)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
