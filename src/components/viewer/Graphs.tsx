import { useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { BROWNOUT_VOLTS, type ChartId } from '../../lib/analysis';
import type { DSEvent, EventKind } from '../../lib/dsevents';
import type { DSLog } from '../../lib/dslog';
import { chartsToPng, download, safeFileName } from '../../lib/export';
import { channelName, updateSettings, type TimeMode } from '../../lib/settings';
import { channelColor } from '../../lib/theme';
import { Icon } from '../Icon';
import { Navigator, TimelineLegend } from '../Navigator';
import { TimeChart, type AxisSpec, type SeriesSpec, type Threshold } from '../TimeChart';
import { useGroupValue, type ViewCtx } from './types';

export function toNullable(a: Float32Array): (number | null)[] {
  const out = new Array<number | null>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Number.isNaN(a[i]) ? null : a[i];
  return out;
}

interface ChartDef {
  id: ChartId;
  title: string;
  help: string;
  height: number;
  series: SeriesSpec[];
  axes: AxisSpec[];
  thresholds?: Threshold[];
}

const pad = (min: number | null, max: number | null, lo: number, hi: number): [number, number] => [
  Math.min(min ?? lo, lo),
  Math.max(max ?? hi, hi),
];

export const CHART_NAMES: Record<ChartId, string> = {
  voltage: 'Battery voltage',
  current: 'Total current',
  comms: 'Comms',
  cpu: 'roboRIO CPU & CAN',
  wifi: 'Wi-Fi (field radio)',
  channels: 'Power channels',
};

/** Default channels to plot: the ones that used the most charge. */
export function defaultChannels(log: DSLog | null, n = 6): number[] {
  if (!log?.channelCount) return [];
  const scored = log.currents.map((arr, ch) => {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) sum += arr[i];
    return { ch, sum };
  });
  return scored
    .filter((s) => s.sum > 0)
    .sort((a, b) => b.sum - a.sum)
    .slice(0, n)
    .map((s) => s.ch)
    .sort((a, b) => a - b);
}

export function useChannelArrays(log: DSLog | null, channels: number[]) {
  const cache = useRef<{ log: DSLog | null; map: Map<number, (number | null)[]> }>({ log: null, map: new Map() });
  return useMemo(() => {
    if (cache.current.log !== log) cache.current = { log, map: new Map() };
    const map = cache.current.map;
    for (const ch of channels) if (log && !map.has(ch)) map.set(ch, toNullable(log.currents[ch]));
    return map;
  }, [log, channels]);
}

export function Graphs({
  ctx,
  channels,
  setChannels,
}: {
  ctx: ViewCtx;
  channels: number[];
  setChannels: (c: number[]) => void;
}) {
  const { parsed, group, theme, settings, tf } = ctx;
  const { log, analysis } = parsed;
  const [showMenu, setShowMenu] = useState(false);

  const arrays = useMemo(
    () =>
      log && {
        volt: toNullable(log.voltage),
        trip: toNullable(log.tripMs),
        loss: toNullable(log.packetLoss),
        cpu: toNullable(log.cpu),
        can: toNullable(log.can),
        db: toNullable(log.wifiDb),
        mb: toNullable(log.wifiMb),
        total: toNullable(log.totalCurrent),
      },
    [log],
  );
  const chArrays = useChannelArrays(log, channels);
  const wifiAvailable = useMemo(() => {
    if (!log) return false;
    for (let i = 0; i < log.count; i++) if (log.wifiDb[i] > 0 || log.wifiMb[i] > 0) return true;
    return false;
  }, [log]);

  const charts: ChartDef[] = useMemo(() => {
    if (!log || !arrays) return [];
    const c = theme.c;
    const list: ChartDef[] = [
      {
        id: 'voltage',
        title: CHART_NAMES.voltage,
        help: 'Dips mean high current draw or a tired battery. Below ~6.8 V the roboRIO browns out and disables motors.',
        height: 200,
        series: [{ label: 'Battery', color: c.volt, data: arrays.volt, scale: 'v', width: 1.6, fmt: (v) => `${v.toFixed(2)} V` }],
        axes: [{ scale: 'v', fmt: (v) => `${v}V`, range: (min, max) => pad(min, max, 6.3, 13) }],
        thresholds: [{ value: BROWNOUT_VOLTS, scale: 'v', color: theme.brownout, label: 'brownout' }],
      },
    ];
    if (log.channelCount)
      list.push({
        id: 'current',
        title: CHART_NAMES.current,
        help: 'Sum of every power distribution channel.',
        height: 160,
        series: [{ label: 'Total', color: c.current, data: arrays.total, scale: 'a', fill: true, fmt: (v) => `${v.toFixed(1)} A` }],
        axes: [{ scale: 'a', fmt: (v) => `${v}A`, range: (_min, max) => [0, Math.max((max ?? 10) * 1.08, 10)] }],
      });
    list.push(
      {
        id: 'comms',
        title: CHART_NAMES.comms,
        help: 'Round-trip time and packet loss between the DS and robot. Gray bands mean no robot comms.',
        height: 160,
        series: [
          { label: 'Trip time', color: c.trip, data: arrays.trip, scale: 'ms', fmt: (v) => `${v.toFixed(1)} ms` },
          { label: 'Packet loss', color: c.loss, data: arrays.loss, scale: 'pct', fmt: (v) => `${v.toFixed(0)}%` },
        ],
        axes: [
          { scale: 'ms', fmt: (v) => `${v}ms`, range: (_min, max) => [0, Math.max((max ?? 10) * 1.1, 10)] },
          { scale: 'pct', side: 'right', fmt: (v) => `${v}%`, range: () => [0, 100] },
        ],
      },
      {
        id: 'cpu',
        title: CHART_NAMES.cpu,
        help: 'roboRIO processor load and CAN bus utilization. Orange strip at the bottom: robot code not reporting (slow loop or stuck code).',
        height: 160,
        series: [
          { label: 'CPU', color: c.cpu, data: arrays.cpu, scale: 'pct', fmt: (v) => `${v.toFixed(0)}%` },
          { label: 'CAN', color: c.can, data: arrays.can, scale: 'pct', fmt: (v) => `${v.toFixed(0)}%` },
        ],
        axes: [{ scale: 'pct', fmt: (v) => `${v}%`, range: () => [0, 100] }],
      },
    );
    if (wifiAvailable)
      list.push({
        id: 'wifi',
        title: CHART_NAMES.wifi,
        help: 'Signal strength and bandwidth reported by the field radio (only on the field).',
        height: 150,
        series: [
          { label: 'Signal', color: c.wifiDb, data: arrays.db, scale: 'db', fmt: (v) => `${v.toFixed(1)} dB` },
          { label: 'Bandwidth', color: c.wifiMb, data: arrays.mb, scale: 'mb', fmt: (v) => `${v.toFixed(2)} Mb/s` },
        ],
        axes: [
          { scale: 'db', fmt: (v) => `${v}dB` },
          { scale: 'mb', side: 'right', fmt: (v) => `${v}Mb` },
        ],
      });
    if (log.channelCount)
      list.push({
        id: 'channels',
        title: CHART_NAMES.channels,
        help: 'Per-channel current. Pick channels below or name them on the Power tab.',
        height: 200,
        series: channels.map((ch) => ({
          label: channelName(ctx.labels, ch),
          color: channelColor(ch, theme.dark),
          data: chArrays.get(ch) ?? [],
          scale: 'a',
          fmt: (v: number) => `${v.toFixed(1)} A`,
        })),
        axes: [{ scale: 'a', fmt: (v) => `${v}A`, range: (_min, max) => [0, Math.max((max ?? 5) * 1.08, 5)] }],
      });
    return list;
  }, [log, arrays, theme, wifiAvailable, channels, chArrays, ctx.labels]);

  const visible = charts.filter((c) => !settings.hiddenCharts.includes(c.id));
  const rev = `${ctx.entry.key}|${log?.count}|${tf.mode}|${tf.base}|${theme.dark}|${channels.join(',')}|${ctx.labels?.join(',')}`;

  const zoomTo = (start: number, end: number) => group.setRange(start - 2, end + 2);
  const match = analysis.match;

  const exportPng = async () => {
    const plots = [...group.plots].sort((a: uPlot, b: uPlot) =>
      a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const blob = await chartsToPng(plots, `${analysis.title} — ${ctx.entry.key}`, theme.panel, theme.text);
    download(blob, `${safeFileName(`${analysis.title} ${ctx.entry.key}`)}.png`);
  };

  if (!log)
    return (
      <div className="page">
        <div className="banner info">
          <Icon name="info" /> No .dslog file for this log, so there is nothing to graph. The Events tab still works.
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="toolbar">
        <div className="seg" aria-label="Zoom to">
          {match && <button onClick={() => zoomTo(match.start, match.end)} title="Whole match (M)">Match</button>}
          {match?.autoStart != null && <button onClick={() => zoomTo(match.autoStart!, match.autoEnd!)} title="Autonomous (A)">Auto</button>}
          {match?.teleopStart != null && <button onClick={() => zoomTo(match.teleopStart!, match.teleopEnd!)} title="Teleop (T)">Teleop</button>}
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
        <span style={{ flex: 1 }} />
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
                        title={m === 'match' ? 'Seconds from the start of auto' : m === 'log' ? 'Seconds from the start of the log' : 'Wall clock time'}
                      >
                        {m === 'match' ? 'Match' : m === 'log' ? 'Log' : 'Clock'}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="item">
                  <input type="checkbox" checked={settings.showMarkers} onChange={(e) => updateSettings({ showMarkers: e.target.checked })} />
                  Show error markers
                </label>
                <hr />
                <div className="menu-label">Charts</div>
                {charts.map((c) => (
                  <label key={c.id} className="item">
                    <input
                      type="checkbox"
                      checked={!settings.hiddenCharts.includes(c.id)}
                      onChange={(e) =>
                        updateSettings((st) => ({
                          hiddenCharts: e.target.checked ? st.hiddenCharts.filter((x) => x !== c.id) : [...st.hiddenCharts, c.id],
                        }))
                      }
                    />
                    {c.title}
                  </label>
                ))}
                <hr />
                <button
                  className="item"
                  onClick={() => {
                    setShowMenu(false);
                    void exportPng();
                  }}
                >
                  <Icon name="image" /> Save charts as PNG
                </button>
                <div className="menu-note faint">Drag on a chart to zoom · Shift+drag to pan · double-click to reset · click to pin a time</div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, paddingBottom: 10 }}>
          <Navigator group={group} analysis={analysis} log={log} theme={theme} />
          <TimelineLegend theme={theme} />
        </div>
      </div>

      <div className={`graphs ${settings.eventsPanelOpen && parsed.events ? '' : 'no-panel'}`}>
        <div className="stack" style={{ gap: 12 }}>
          {visible.map((c) => (
            <div className="card chart-card" key={c.id} id={`chart-${c.id}`}>
              <div className="chart-title">
                {c.title}
                <span className="help hide-sm">{c.help}</span>
              </div>
              {c.id === 'channels' && (
                <ChannelPicker ctx={ctx} channels={channels} setChannels={setChannels} />
              )}
              {c.series.length > 0 ? (
                <TimeChart
                  group={group}
                  x={log.time}
                  series={c.series}
                  axes={c.axes}
                  thresholds={c.thresholds}
                  height={c.height}
                  theme={theme}
                  rev={rev}
                />
              ) : (
                <p className="muted" style={{ margin: '12px 0' }}>
                  Pick channels to plot.
                </p>
              )}
            </div>
          ))}
          {!visible.length && (
            <div className="banner info">
              <Icon name="info" /> All charts are hidden. Use the Charts menu to show some.
            </div>
          )}
        </div>
        {settings.eventsPanelOpen && parsed.events && <EventsPanel ctx={ctx} />}
      </div>
    </div>
  );
}

function ChannelPicker({ ctx, channels, setChannels }: { ctx: ViewCtx; channels: number[]; setChannels: (c: number[]) => void }) {
  const log = ctx.parsed.log!;
  const toggle = (ch: number) =>
    setChannels(channels.includes(ch) ? channels.filter((c) => c !== ch) : [...channels, ch].sort((a, b) => a - b));
  return (
    <div className="row" style={{ gap: 5, margin: '4px 0 8px' }}>
      {log.currents.map((_, ch) => (
        <button
          key={ch}
          className={`chip ${channels.includes(ch) ? 'on' : ''}`}
          style={{ ['--chip-color' as string]: channelColor(ch, ctx.theme.dark), height: 24, padding: '0 8px' }}
          onClick={() => toggle(ch)}
          title={channelName(ctx.labels, ch)}
        >
          <span className="dot" />
          {ctx.labels?.[ch]?.trim() ? channelName(ctx.labels, ch) : ch}
        </button>
      ))}
      <button className="btn small ghost" onClick={() => setChannels(defaultChannels(log))}>
        Top 6
      </button>
      <button className="btn small ghost" onClick={() => setChannels([])}>
        Clear
      </button>
    </div>
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
              style={{ ['--chip-color' as string]: `var(--${k === 'error' ? 'bad' : k === 'warning' ? 'warn' : k === 'print' ? 'faint' : k === 'ds' ? 'info' : 'test'})`, height: 24, padding: '0 8px' }}
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
