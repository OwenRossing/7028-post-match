import { useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { BROWNOUT_VOLTS, type ChartId, type Span } from '../../lib/analysis';
import type { DSEvent, EventKind } from '../../lib/dsevents';
import type { DSLog } from '../../lib/dslog';
import { chartsToPng, download, safeFileName } from '../../lib/export';
import { drawAt, pdStatus, powerReport, powerSources, totalNear } from '../../lib/power';
import { channelName, updateSettings, type TimeMode } from '../../lib/settings';
import type { RobotSignal } from '../../lib/robotSeries';
import { channelColor } from '../../lib/theme';
import { Icon } from '../Icon';
import { Navigator, TimelineLegend } from '../Navigator';
import { TimeChart, type AxisSpec, type Threshold } from '../TimeChart';
import { Moment } from './Moment';
import { PowerCard } from './PowerCard';
import { Strip } from './Strip';
import { useGroupValue, type ViewCtx } from './types';

export function toNullable(a: Float32Array): (number | null)[] {
  const out = new Array<number | null>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Number.isNaN(a[i]) ? null : a[i];
  return out;
}

/** The signal rows an analysis chart id stands for (findings and the Board point at these). */
export const CHART_SIGNALS: Record<ChartId, string[]> = {
  voltage: ['voltage'],
  current: ['total'],
  comms: ['trip', 'loss'],
  cpu: ['cpu', 'can'],
  wifi: ['wifiDb', 'wifiMb'],
  channels: ['channels'],
};

type Section = 'Power' | 'Motors' | 'Network' | 'RIO' | 'Robot';

interface Signal {
  id: string;
  section: Section;
  name: string;
  arr: Float32Array;
  color: string;
  unit: string;
  digits: number;
  /** The number shown for the visible range. */
  stat: 'min' | 'max' | 'avg';
  lo?: number;
  hi?: number;
  low?: boolean;
  axis: AxisSpec;
  thresholds?: Threshold[];
  help: string;
  /** Drawn as a heat strip, like the power channels (motor currents). */
  heat?: boolean;
  /** For a robot signal: the device it belongs to. */
  group?: string;
}

const STAT_WORD = { min: 'lowest', max: 'peak', avg: 'avg' } as const;

function statIn(log: DSLog, arr: Float32Array, range: Span, kind: Signal['stat']): number {
  const i0 = Math.max(0, Math.floor(range.start / log.period));
  const i1 = Math.min(log.count - 1, Math.ceil(range.end / log.period));
  let sum = 0;
  let n = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const v = arr[i];
    if (Number.isNaN(v)) continue;
    sum += v;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!n) return NaN;
  return kind === 'min' ? lo : kind === 'max' ? hi : sum / n;
}

const chId = (ch: number) => `ch${ch}`;
const rgId = (group: string) => `rg:${group}`;
const IDLE_ID = 'mi';
/** The sections in the order they are drawn. */
const SECTIONS: Section[] = ['Power', 'Motors', 'Network', 'RIO', 'Robot'];

const peakOf = (a: Float32Array) => {
  let p = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > p) p = a[i];
  return p;
};
const plain = (v: number) => String(Math.round(v * 100) / 100);

/** The robot logs' signals as rows: motor currents as heat rows, everything else grouped by device. */
function robotRows(robot: RobotSignal[], dark: boolean): Signal[] {
  return robot.map((s, i) =>
    s.kind === 'current'
      ? {
          id: `m:${i}`,
          section: 'Motors' as const,
          name: s.label ?? s.name,
          arr: s.arr,
          color: channelColor(i, dark),
          unit: 'A',
          digits: 0,
          stat: 'max' as const,
          lo: 0,
          heat: true,
          group: s.group,
          axis: { scale: 'y', fmt: (v: number) => `${v}A`, range: (min?: number | null, max?: number | null) => [Math.min(0, min ?? 0), Math.max((max ?? 5) * 1.08, 5)] as [number, number] },
          help: `${s.name}, from ${s.log}`,
        }
      : {
          id: `r:${i}`,
          section: 'Robot' as const,
          name: s.short,
          arr: s.arr,
          color: channelColor(i % 24, dark),
          unit: '',
          digits: 2,
          stat: 'avg' as const,
          group: s.group,
          axis: {
            scale: 'y',
            fmt: plain,
            range: (min?: number | null, max?: number | null) => {
              const lo = min ?? 0;
              const hi = max ?? 1;
              const pad = (hi - lo) * 0.08 || 1;
              return [lo - pad, hi + pad] as [number, number];
            },
          },
          help: `${s.name}, from ${s.log}`,
        },
  );
}

/**
 * Graphs: every signal as one folded row with a strip of the visible range. Space or Enter unfolds the full
 * chart. Power channels are a folded group whose rows together read like a heatmap.
 */
export function Graphs({
  ctx,
  open,
  setOpen,
  sel,
  setSel,
}: {
  ctx: ViewCtx;
  open: string[];
  setOpen: (fn: (o: string[]) => string[]) => void;
  sel: string | null;
  setSel: (id: string | null) => void;
}) {
  const { parsed, group, theme, settings, tf, labels, labelKey } = ctx;
  const { log, analysis } = parsed;
  const range = useGroupValue(group, 'range', () => group.range);
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const signals = useMemo<Signal[]>(() => {
    if (!log) return [];
    const c = theme.c;
    const pct = (v: number) => `${v}%`;
    const list: Signal[] = [
      {
        id: 'voltage',
        section: 'Power',
        name: 'Battery voltage',
        arr: log.voltage,
        color: c.volt,
        unit: 'V',
        digits: 2,
        stat: 'min',
        low: true,
        axis: { scale: 'y', fmt: (v) => `${v}V`, range: (min, max) => [Math.min(min ?? 6.3, 6.3), Math.max(max ?? 13, 13)] },
        thresholds: [{ value: BROWNOUT_VOLTS, scale: 'y', color: theme.brownout, label: 'brownout' }],
        help: 'Dips mean high current draw or a tired battery. Below ~6.8 V the roboRIO browns out.',
      },
    ];
    if (log.channelCount)
      list.push({
        id: 'total',
        section: 'Power',
        name: 'Total current',
        arr: log.totalCurrent,
        color: c.current,
        unit: 'A',
        digits: 0,
        stat: 'max',
        lo: 0,
        axis: { scale: 'y', fmt: (v) => `${v}A`, range: (_min, max) => [0, Math.max((max ?? 10) * 1.08, 10)] },
        help: 'Sum of every power distribution channel.',
      });
    list.push(
      {
        id: 'trip',
        section: 'Network',
        name: 'Trip time',
        arr: log.tripMs,
        color: c.trip,
        unit: 'ms',
        digits: 1,
        stat: 'avg',
        lo: 0,
        axis: { scale: 'y', fmt: (v) => `${v}ms`, range: (_min, max) => [0, Math.max((max ?? 10) * 1.1, 10)] },
        help: 'Round trip between the DS and the robot. Gray bands mean no robot comms.',
      },
      {
        id: 'loss',
        section: 'Network',
        name: 'Packet loss',
        arr: log.packetLoss,
        color: c.loss,
        unit: '%',
        digits: 1,
        stat: 'avg',
        lo: 0,
        hi: 100,
        axis: { scale: 'y', fmt: pct, range: () => [0, 100] },
        help: 'Share of DS packets that got no answer.',
      },
    );
    if (hasWifi(log))
      list.push(
        {
          id: 'wifiDb',
          section: 'Network',
          name: 'Wi-Fi signal',
          arr: log.wifiDb,
          color: c.wifiDb,
          unit: 'dB',
          digits: 1,
          stat: 'avg',
          axis: { scale: 'y', fmt: (v) => `${v}dB` },
          help: 'Signal strength reported by the field radio (only on the field).',
        },
        {
          id: 'wifiMb',
          section: 'Network',
          name: 'Wi-Fi bandwidth',
          arr: log.wifiMb,
          color: c.wifiMb,
          unit: 'Mb/s',
          digits: 2,
          stat: 'avg',
          lo: 0,
          axis: { scale: 'y', fmt: (v) => `${v}Mb` },
          help: 'Bandwidth reported by the field radio.',
        },
      );
    list.push(
      {
        id: 'cpu',
        section: 'RIO',
        name: 'CPU',
        arr: log.cpu,
        color: c.cpu,
        unit: '%',
        digits: 0,
        stat: 'avg',
        lo: 0,
        hi: 100,
        axis: { scale: 'y', fmt: pct, range: () => [0, 100] },
        help: 'roboRIO processor load. The orange strip on the chart is robot code not reporting.',
      },
      {
        id: 'can',
        section: 'RIO',
        name: 'CAN bus',
        arr: log.can,
        color: c.can,
        unit: '%',
        digits: 0,
        stat: 'avg',
        lo: 0,
        hi: 100,
        axis: { scale: 'y', fmt: pct, range: () => [0, 100] },
        help: 'roboRIO CAN bus utilization.',
      },
    );
    return [...list, ...robotRows(parsed.robot ?? [], theme.dark)];
  }, [log, theme, parsed.robot]);

  // Motors, busiest first; the heat strips share one scale so they can be compared.
  const motors = useMemo(() => signals.filter((s) => s.section === 'Motors').sort((a, b) => peakOf(b.arr) - peakOf(a.arr)), [signals]);
  // Motors that never drew a full amp are folded away, so the list is the ones that did something.
  const motorsActive = useMemo(() => motors.filter((s) => peakOf(s.arr) >= 1), [motors]);
  const motorsIdle = useMemo(() => motors.filter((s) => !(peakOf(s.arr) >= 1)), [motors]);
  const motorPeak = useMemo(() => Math.max(1, ...motors.map((s) => peakOf(s.arr)).filter(Number.isFinite)), [motors]);
  // The rest of the robot's signals, by device. Only the open groups draw their rows.
  const robotGroups = useMemo(() => {
    const out = new Map<string, Signal[]>();
    for (const s of signals) if (s.section === 'Robot') out.set(s.group ?? 'Other', [...(out.get(s.group ?? 'Other') ?? []), s]);
    return [...out];
  }, [signals]);
  // Everything with a current, and who drew the most when the battery was lowest.
  const sources = useMemo(() => (log ? powerSources(log, parsed.robot ?? [], (ch) => channelName(labels, ch)) : []), [log, parsed.robot, labels]);
  const report = useMemo(() => (log ? powerReport(log, sources) : null), [log, sources]);
  // Robot logs that are attached but are not on the graphs, and why.
  const unplaced = useMemo(
    () => parsed.extras.filter((x) => x.ok && x.decoded !== false && (!x.alignment || (x.alignment.confidence !== 'high' && x.alignment.confidence !== 'medium'))),
    [parsed.extras],
  );

  // Converted lazily, only for charts that are open.
  const nullable = useRef<{ log: DSLog | null; map: Map<Float32Array, (number | null)[]> }>({ log: null, map: new Map() });
  if (nullable.current.log !== log) nullable.current = { log, map: new Map() };
  const dataOf = (a: Float32Array) => {
    let d = nullable.current.map.get(a);
    if (!d) nullable.current.map.set(a, (d = toNullable(a)));
    return d;
  };

  const channelPeak = useMemo(() => {
    let p = 1;
    for (const arr of log?.currents ?? []) for (let i = 0; i < arr.length; i++) if (arr[i] > p) p = arr[i];
    return p;
  }, [log]);
  const usedChannel = useMemo(() => (log?.currents ?? []).map((arr) => arr.some((v) => v >= 1)), [log]);

  const isOpen = (id: string) => open.includes(id);
  const toggle = (id: string, force?: boolean) =>
    setOpen((o) => ((force ?? !o.includes(id)) ? [...new Set([...o, id])] : o.filter((x) => x !== id)));

  // Rows in screen order, for the keyboard.
  const order = useMemo(() => {
    const ids: string[] = [];
    for (const sec of SECTIONS) {
      if (sec === 'Motors') {
        ids.push(...motorsActive.map((s) => s.id));
        if (motorsIdle.length) {
          ids.push(IDLE_ID);
          if (isOpen(IDLE_ID)) ids.push(...motorsIdle.map((s) => s.id));
        }
      }
      else if (sec === 'Robot')
        for (const [g, rows] of robotGroups) {
          ids.push(rgId(g));
          if (isOpen(rgId(g))) ids.push(...rows.map((s) => s.id));
        }
      else
        for (const s of signals) {
          if (s.section !== sec) continue;
          ids.push(s.id);
          if (s.id === 'total' && log?.channelCount) {
            ids.push('channels');
            if (isOpen('channels')) for (let ch = 0; ch < log.channelCount; ch++) ids.push(chId(ch));
          }
        }
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, motorsActive, motorsIdle, robotGroups, open, log]);
  const cur = sel && order.includes(sel) ? sel : sel?.startsWith('ch') ? 'channels' : order[0];

  useEffect(() => {
    rootRef.current?.querySelector(`[data-sig="${String(cur).replace(/["\\]/g, '\\$&')}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-back') || !cur) return;
    const i = order.indexOf(cur);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        setSel(order[Math.min(order.length - 1, i + 1)]);
        break;
      case 'ArrowUp':
        setSel(order[Math.max(0, i - 1)]);
        break;
      case ' ':
      case 'Enter':
        toggle(cur);
        break;
      case 'e': {
        const tops = order.filter((id) => (!id.startsWith('ch') || id === 'channels') && !id.startsWith('rg:') && !id.startsWith('r:') && id !== IDLE_ID);
        const anyClosed = tops.some((id) => !isOpen(id));
        setOpen((o) => (anyClosed ? [...new Set([...o, ...tops])] : []));
        break;
      }
      case 'n':
        if (/^ch\d+$/.test(cur)) setRenaming(Number(cur.slice(2)));
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, []);

  const setLabel = (ch: number, value: string) =>
    updateSettings((s) => {
      const arr = [...(s.channelLabels[labelKey] ?? [])];
      arr[ch] = value.trim();
      return { channelLabels: { ...s.channelLabels, [labelKey]: arr } };
    });

  const zoomTo = (start: number, end: number) => group.setRange(start - 2, end + 2);
  const match = analysis.match;
  const rev = `${ctx.entry.key}|${log?.count}|${parsed.robot?.length ?? 0}|${tf.mode}|${tf.base}|${theme.dark}|${labels?.join(',')}`;

  const exportPng = async () => {
    const plots = [...group.plots].sort((a: uPlot, b: uPlot) =>
      a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    if (!plots.length) return;
    const blob = await chartsToPng(plots, `${analysis.title} — ${ctx.entry.key}`, theme.panel, theme.text);
    download(blob, `${safeFileName(`${analysis.title} ${ctx.entry.key}`)}.png`);
  };

  if (!log)
    return (
      <div className="page">
        <div className="banner info">
          <Icon name="info" /> No .dslog file for this log, so there is nothing to graph. Messages still work.
        </div>
      </div>
    );

  const chart = (
    id: string,
    name: string,
    arr: Float32Array,
    color: string,
    unit: string,
    digits: number,
    axis: AxisSpec,
    thresholds?: Threshold[],
  ) => (
    <div className="g-chart">
      <TimeChart
        group={group}
        x={log.time}
        series={[
          { label: name, color, data: dataOf(arr), scale: 'y', width: 1.6, fill: unit === 'A', fmt: (v) => `${v.toFixed(digits)} ${unit}` },
        ]}
        axes={[axis]}
        thresholds={thresholds}
        height={170}
        theme={theme}
        rev={`${id}|${rev}`}
      />
    </div>
  );

  const signalRow = (s: Signal, child = false) => {
    const v = statIn(log, s.arr, range, s.stat);
    const on = isOpen(s.id);
    return (
      <div key={s.id} className={`g-item ${on ? 'open' : ''}`} id={`sig-${s.id}`}>
        <div className={`g-row ${child ? 'child' : ''} ${cur === s.id ? 'sel' : ''}`} data-sig={s.id} onClick={() => (setSel(s.id), toggle(s.id))} title={s.help}>
          <Chevron open={on} />
          <span className="g-name">
            <i className="g-swatch" style={{ background: s.color }} />
            {s.name}
          </span>
          <span className="g-stat">
            <small>{STAT_WORD[s.stat]}</small>
            {Number.isFinite(v) ? v.toFixed(s.digits) : '–'}
            <small>{s.unit}</small>
          </span>
          <Strip
            ctx={ctx}
            log={log}
            arr={s.arr}
            range={range}
            mode={s.heat ? 'heat' : 'line'}
            color={s.heat ? '' : s.color}
            lo={s.lo}
            hi={s.heat ? motorPeak : s.hi}
            low={s.low}
            theme={theme}
          />
        </div>
        {on && chart(s.id, s.name, s.arr, s.color, s.unit, s.digits, s.axis, s.thresholds)}
      </div>
    );
  };

  const groupRow = (id: string, label: string, rows: Signal[]) => {
    const on = isOpen(id);
    return (
      <div key={id} className={`g-item group ${on ? 'open' : ''}`} id={`sig-${id}`}>
        <div className={`g-row ${cur === id ? 'sel' : ''}`} data-sig={id} onClick={() => (setSel(id), toggle(id))}>
          <Chevron open={on} />
          <span className="g-name">
            {label} <span className="g-count">{rows.length}</span>
          </span>
        </div>
        {on && <div className="g-children">{rows.map((s) => signalRow(s, true))}</div>}
      </div>
    );
  };

  const channelsGroup = () => {
    const on = isOpen('channels');
    const used = usedChannel.filter(Boolean).length;
    return (
      <div key="channels" className={`g-item group ${on ? 'open' : ''}`} id="sig-channels">
        <div
          className={`g-row ${cur === 'channels' ? 'sel' : ''}`}
          data-sig="channels"
          onClick={() => (setSel('channels'), toggle('channels'))}
        >
          <Chevron open={on} />
          <span className="g-name">
            Channels <span className="g-count">{used} used</span>
          </span>
          <span className="g-stat">
            <small>of</small>
            {log.channelCount}
          </span>
          <Strip ctx={ctx} log={log} arr={log.totalCurrent} range={range} mode="heat" color="" theme={theme} />
        </div>
        {on && (
          <div className="g-children">
            {used === 0 && (
              <p className="g-note">Every channel stayed under 1 A in this log, so none is drawn as used: the robot was probably not driven (disabled, on blocks, or a pit check).</p>
            )}
            {log.currents.map((arr, ch) => {
              const id = chId(ch);
              const chOpen = isOpen(id);
              const peak = statIn(log, arr, range, 'max');
              const name = channelName(labels, ch);
              return (
                <div key={id} className={`g-item ${chOpen ? 'open' : ''} ${usedChannel[ch] ? '' : 'unused'}`} id={`sig-${id}`}>
                  <div className={`g-row child ${cur === id ? 'sel' : ''}`} data-sig={id} onClick={() => (setSel(id), toggle(id))}>
                    <Chevron open={chOpen} />
                    <span className="g-name" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(ch))}>
                      <i className="g-swatch" style={{ background: channelColor(ch, theme.dark) }} />
                      {renaming === ch ? (
                        <input
                          className="g-rename"
                          autoFocus
                          defaultValue={labels?.[ch] ?? ''}
                          placeholder={`Ch ${ch}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                          onBlur={(e) => {
                            if (renaming === ch) setLabel(ch, e.target.value);
                            setRenaming(null);
                          }}
                        />
                      ) : (
                        <>
                          {name}
                          {labels?.[ch]?.trim() && <span className="g-count">{ch}</span>}
                        </>
                      )}
                    </span>
                    <span className="g-stat">
                      <small>peak</small>
                      {Number.isFinite(peak) ? peak.toFixed(0) : '–'}
                      <small>A</small>
                    </span>
                    <Strip ctx={ctx} log={log} arr={arr} range={range} mode="heat" color="" hi={channelPeak} theme={theme} />
                  </div>
                  {chOpen &&
                    chart(id, name, arr, channelColor(ch, theme.dark), 'A', 1, {
                      scale: 'y',
                      fmt: (v) => `${v}A`,
                      range: (_min, max) => [0, Math.max((max ?? 5) * 1.08, 5)],
                    })}
                </div>
              );
            })}
            <p className="g-note">
              Press <kbd>N</kbd> or double-click a channel to name it. Names are saved in this browser
              {labelKey.startsWith('any') ? '' : ` for team ${labelKey.split(':')[0]}`} and used everywhere.
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="page graphs-page" ref={rootRef}>
      <div className="toolbar">
        <div className="seg" aria-label="Zoom to">
          {match && (
            <button onClick={() => zoomTo(match.start, match.end)} title="Whole match (M)">
              Match
            </button>
          )}
          {match?.autoStart != null && (
            <button onClick={() => zoomTo(match.autoStart!, match.autoEnd!)} title="Autonomous (A)">
              Auto
            </button>
          )}
          {match?.teleopStart != null && (
            <button onClick={() => zoomTo(match.teleopStart!, match.teleopEnd!)} title="Teleop (T)">
              Teleop
            </button>
          )}
          {!match && analysis.runs.length > 0 && (
            <button onClick={() => zoomTo(analysis.focus.start, analysis.focus.end)} title="Enabled time (M)">
              Enabled
            </button>
          )}
          <button onClick={() => group.reset()} title="Whole log (F)">
            All
          </button>
        </div>
        <button className="btn icon round" onClick={() => group.zoom(0.6)} title="Zoom in (+)" aria-label="Zoom in">
          <Icon name="zoomIn" size={16} />
        </button>
        <button className="btn icon round" onClick={() => group.zoom(1 / 0.6)} title="Zoom out (−)" aria-label="Zoom out">
          <Icon name="zoomOut" size={16} />
        </button>
        <div className="toolbar-legend">
          <TimelineLegend theme={theme} />
        </div>
        {parsed.events && (
          <button
            className={`btn icon round ${settings.eventsPanelOpen ? 'active' : ''}`}
            onClick={() => updateSettings({ eventsPanelOpen: !settings.eventsPanelOpen })}
            title="Show messages next to the graphs"
            aria-label="Messages panel"
          >
            <Icon name="list" size={16} />
          </button>
        )}
        <div className="menu-wrap">
          <button className="btn icon round" onClick={() => setShowMenu((m) => !m)} title="Graph options" aria-label="Graph options">
            <Icon name="more" size={18} />
          </button>
          {showMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setShowMenu(false)} />
              <div className="menu" style={{ width: 280 }}>
                <div className="menu-label">Time axis</div>
                <div className="menu-note">
                  <div className="seg" style={{ width: '100%' }}>
                    {(['match', 'log', 'clock'] as TimeMode[]).map((m) => (
                      <button
                        key={m}
                        style={{ flex: 1 }}
                        className={settings.timeMode === m ? 'on' : ''}
                        onClick={() => updateSettings({ timeMode: m })}
                        title={
                          m === 'match'
                            ? 'Seconds from the start of auto'
                            : m === 'log'
                              ? 'Seconds from the start of the log'
                              : 'Wall clock time'
                        }
                      >
                        {m === 'match' ? 'Match' : m === 'log' ? 'Log' : 'Clock'}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="item">
                  <input
                    type="checkbox"
                    checked={settings.showMarkers}
                    onChange={(e) => updateSettings({ showMarkers: e.target.checked })}
                  />
                  Show error markers
                </label>
                <hr />
                <button
                  className="item"
                  onClick={() => {
                    setShowMenu(false);
                    void exportPng();
                  }}
                  disabled={!open.length}
                >
                  <Icon name="image" /> Save open charts as PNG
                </button>
                <div className="menu-note faint">
                  Drag on a chart to zoom · Shift+drag to pan · double-click to reset · click to pin a time
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <Navigator group={group} analysis={analysis} log={log} theme={theme} height={46} />
        </div>
      </div>

      <Moment
        ctx={ctx}
        draw={(t) => {
          const i = Math.min(log.count - 1, Math.max(0, Math.round(t / log.period)));
          return { top: drawAt(sources, i, 3).map((d) => ({ name: d.source.name, amps: d.amps })), total: totalNear(log, i, 2), volts: log.voltage[i] };
        }}
      />
      {report && <PowerCard ctx={ctx} sources={sources} report={report} />}

      <div className={`graphs ${settings.eventsPanelOpen && parsed.events ? '' : 'no-panel'}`}>
        <div className="g-list">
          {SECTIONS.map((sec) => {
            if (sec === 'Motors')
              return motors.length ? (
                <section key={sec} className="g-sec">
                  <h2>Motors</h2>
                  {motorsActive.map((s) => signalRow(s))}
                  {motorsIdle.length > 0 && groupRow(IDLE_ID, 'Idle: never above 1 A', motorsIdle)}
                  {!motorsActive.length && <p className="g-note">None of the motors or channels in the robot logs drew a full amp: the robot was probably not driven.</p>}
                  <p className="g-note">
                    Motor and power channel currents from the attached robot logs, busiest first, on one scale so they can be compared. Open a row for its chart; the
                    Info page says how each log lined up with the match.
                  </p>
                </section>
              ) : null;
            if (sec === 'Robot')
              return robotGroups.length || unplaced.length ? (
                <section key={sec} className="g-sec">
                  <h2>Robot logs</h2>
                  {robotGroups.map(([g, rows]) => groupRow(rgId(g), g, rows))}
                  {unplaced.map((x) => (
                    <p key={x.name} className="g-note">
                      <b>{x.name}</b> is not on the graphs: {x.alignment?.detail ?? "there is nothing to line it up with the match by."} Its signals are listed on the Info page.
                    </p>
                  ))}
                </section>
              ) : null;
            const rows = signals.filter((s) => s.section === sec);
            if (!rows.length) return null;
            return (
              <section key={sec} className="g-sec">
                <h2>{sec}</h2>
                {rows.map((s) => [signalRow(s), s.id === 'total' && log.channelCount ? channelsGroup() : null])}
                {sec === 'Power' && !log.channelCount && (
                  <p className="g-note">
                    {pdStatus(log).kind === 'frozen'
                      ? `${pdStatus(log).text} `
                      : "No power distribution data in this Driver Station log, so there are no per-channel currents here. The Driver Station only records them when the robot's code is reading the power distribution board (WPILib's PowerDistribution class) and the board is on the CAN bus. "}
                    {motors.length ? 'The attached robot logs have motor currents of their own, under Motors.' : "Attach the robot's .wpilog, or a converted .hoot, to see motor currents from it."}
                  </p>
                )}
              </section>
            );
          })}
        </div>
        {settings.eventsPanelOpen && parsed.events && <EventsPanel ctx={ctx} />}
      </div>
    </div>
  );
}

function hasWifi(log: DSLog) {
  for (let i = 0; i < log.count; i++) if (log.wifiDb[i] > 0 || log.wifiMb[i] > 0) return true;
  return false;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="g-chev"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{ transform: open ? 'rotate(90deg)' : undefined }}
      aria-hidden="true"
    >
      <path d="M3 1.5 6.8 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const KIND_LABEL: Record<EventKind, string> = {
  error: 'Errors',
  warning: 'Warnings',
  print: 'Prints',
  ds: 'DS',
  fms: 'FMS',
};

function EventsPanel({ ctx }: { ctx: ViewCtx }) {
  const { group, tf } = ctx;
  const events = ctx.parsed.events!.events;
  const [kinds, setKinds] = useState<Set<EventKind>>(() => new Set<EventKind>(['error', 'warning', 'ds', 'fms']));
  const [onlyVisible, setOnlyVisible] = useState(true);
  const [q, setQ] = useState('');
  const range = useGroupValue(group, 'range', () => group.range);
  const hover = useGroupValue(group, 'hover', () => group.hover);
  const pinned = useGroupValue(group, 'pin', () => group.pinned);
  const listRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const c: Record<EventKind, number> = { error: 0, warning: 0, print: 0, ds: 0, fms: 0 };
    for (const e of events) if (!onlyVisible || (e.t >= range.start && e.t <= range.end)) c[e.kind]++;
    return c;
  }, [events, onlyVisible, range]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return events.filter(
      (e) =>
        kinds.has(e.kind) &&
        (!onlyVisible || (e.t >= range.start && e.t <= range.end)) &&
        (!needle || e.text.toLowerCase().includes(needle) || (e.location ?? '').toLowerCase().includes(needle)),
    );
  }, [events, kinds, onlyVisible, range, q]);

  const width = range.end - range.start;
  const nearTol = Math.max(0.25, width * 0.006);
  const isNear = (e: DSEvent) => hover != null && Math.abs(e.t - hover) <= nearTol;

  // Keep the pinned event in view.
  useEffect(() => {
    if (pinned == null || !listRef.current) return;
    const el = listRef.current.querySelector('.ev-item.pinned');
    el?.scrollIntoView({ block: 'nearest' });
  }, [pinned]);

  const toggle = (k: EventKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const shown = filtered.slice(0, 500);
  const pinnedId = pinned == null ? -1 : filtered.reduce((best, e) => (Math.abs(e.t - pinned) < 0.05 ? e.id : best), -1);

  return (
    <div className="card events-panel">
      <div className="card-head" style={{ paddingBottom: 8 }}>
        <h3>Messages</h3>
        <span className="grow" />
        <label className="toggle" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={onlyVisible} onChange={(e) => setOnlyVisible(e.target.checked)} />
          In view
        </label>
      </div>
      <div style={{ padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Filter messages…" value={q} onChange={(e) => setQ(e.target.value)} style={{ height: 30 }} />
        </div>
        <div className="row" style={{ gap: 5 }}>
          {(Object.keys(KIND_LABEL) as EventKind[]).map((k) => (
            <button
              key={k}
              className={`chip ${kinds.has(k) ? 'on' : ''}`}
              style={{
                ['--chip-color' as string]: `var(--${k === 'error' ? 'bad' : k === 'warning' ? 'warn' : k === 'print' ? 'faint' : k === 'ds' ? 'info' : 'test'})`,
                height: 24,
                padding: '0 8px',
              }}
              onClick={() => toggle(k)}
            >
              <span className="dot" />
              {KIND_LABEL[k]} <span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ev-list" ref={listRef}>
        {shown.map((e) => (
          <div
            key={e.id}
            className={`ev-item ${isNear(e) ? 'near' : ''} ${e.id === pinnedId ? 'pinned' : ''}`}
            onClick={() => group.pin(e.t)}
            onMouseEnter={() => group.setHover(e.t)}
            onMouseLeave={() => group.setHover(null)}
            title={e.location ?? undefined}
          >
            <span className="ev-time">{tf.fmt(e.t).replace(/\.\d+$/, (m) => m.slice(0, 2))}</span>
            <span className="ev-text">
              <span className={`ev-kind k-${e.kind}`} />
              {e.text}
            </span>
          </div>
        ))}
        {!shown.length && (
          <div className="lib-empty">
            {onlyVisible && events.length ? 'No matching messages in the visible range.' : 'No matching messages.'}
          </div>
        )}
        {filtered.length > shown.length && (
          <div className="lib-empty">+{filtered.length - shown.length} more. Zoom in or filter to narrow down.</div>
        )}
      </div>
    </div>
  );
}
