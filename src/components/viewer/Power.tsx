import { useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, indexAt, type Span } from '../../lib/analysis';
import type { DSLog } from '../../lib/dslog';
import { channelName, updateSettings } from '../../lib/settings';
import { channelColor, type ChartTheme } from '../../lib/theme';
import { Icon } from '../Icon';
import { TimeChart } from '../TimeChart';
import { defaultChannels, useChannelArrays } from './Graphs';
import { useGroupValue, type ViewCtx } from './types';

type Scope = 'focus' | 'all' | 'zoom';

function heatColor(v: number, dark: boolean): string {
  // Three stop sequential ramp: background → orange → bright.
  const stops = dark
    ? [
        [27, 32, 41],
        [150, 60, 25],
        [255, 128, 89],
        [255, 226, 170],
      ]
    : [
        [240, 242, 246],
        [253, 200, 165],
        [224, 83, 31],
        [110, 25, 5],
      ];
  const x = Math.min(Math.max(v, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function Heatmap({
  log,
  span,
  labels,
  theme,
  onPick,
}: {
  log: DSLog;
  span: Span;
  labels: string[] | undefined;
  theme: ChartTheme;
  onPick: (ch: number, t: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [width, setWidth] = useState(600);
  const labelW = 110;
  const rowH = 14;
  const height = log.channelCount * rowH + 18;

  useEffect(() => {
    const ro = new ResizeObserver(() => setWidth(wrapRef.current?.clientWidth ?? 600));
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
  }, []);

  const grid = useMemo(() => {
    const i0 = indexAt(log, span.start);
    const i1 = indexAt(log, span.end);
    const cols = Math.max(1, Math.min(Math.floor(width - labelW), i1 - i0 + 1));
    const data = log.currents.map(() => new Float32Array(cols).fill(NaN));
    let peak = 1;
    for (let ch = 0; ch < log.channelCount; ch++) {
      const arr = log.currents[ch];
      const row = data[ch];
      for (let i = i0; i <= i1; i++) {
        const v = arr[i];
        if (Number.isNaN(v)) continue;
        const c = Math.min(cols - 1, Math.floor(((i - i0) / (i1 - i0 + 1)) * cols));
        if (!(row[c] >= v)) row[c] = v;
        if (v > peak) peak = v;
      }
    }
    return { cols, data, peak, i0, i1 };
  }, [log, span, width]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const plotW = width - labelW;
    const colW = plotW / grid.cols;
    ctx.font = `11px ${theme.font}`;
    ctx.textBaseline = 'middle';
    for (let ch = 0; ch < log.channelCount; ch++) {
      const y = ch * rowH;
      ctx.fillStyle = theme.muted;
      const label = channelName(labels, ch);
      ctx.fillText(label.length > 16 ? label.slice(0, 15) + '…' : label, 0, y + rowH / 2);
      const row = grid.data[ch];
      for (let c = 0; c < grid.cols; c++) {
        const v = row[c];
        ctx.fillStyle = Number.isNaN(v) ? 'transparent' : heatColor(Math.sqrt(v / grid.peak), theme.dark);
        ctx.fillRect(labelW + c * colW, y + 1, Math.ceil(colW), rowH - 2);
      }
    }
    // Scale
    const sy = log.channelCount * rowH + 6;
    for (let x = 0; x < 120; x++) {
      ctx.fillStyle = heatColor(x / 119, theme.dark);
      ctx.fillRect(labelW + x, sy, 1, 8);
    }
    ctx.fillStyle = theme.faint;
    ctx.fillText('0 A', labelW + 126, sy + 4);
    ctx.fillText(`→ ${grid.peak.toFixed(0)} A (sqrt scale)`, labelW + 150, sy + 4);
  }, [grid, width, height, log, labels, theme]);

  const locate = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ch = Math.floor(y / rowH);
    if (x < labelW || ch < 0 || ch >= log.channelCount) return null;
    const c = Math.floor(((x - labelW) / (width - labelW)) * grid.cols);
    const i = grid.i0 + Math.floor((c / grid.cols) * (grid.i1 - grid.i0 + 1));
    return { ch, c, t: i * log.period, x, y };
  };

  return (
    <div className="heatmap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => {
          const p = locate(e);
          if (!p) return setTip(null);
          const v = grid.data[p.ch][p.c];
          setTip({
            x: Math.min(p.x + 12, width - 200),
            y: p.y + 12,
            text: `${channelName(labels, p.ch)} · ${Number.isNaN(v) ? '–' : v.toFixed(1) + ' A peak'}`,
          });
        }}
        onMouseLeave={() => setTip(null)}
        onClick={(e) => {
          const p = locate(e);
          if (p) onPick(p.ch, p.t);
        }}
      />
      {tip && (
        <div className="heat-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

export function Power({ ctx, channels, setChannels }: { ctx: ViewCtx; channels: number[]; setChannels: (c: number[]) => void }) {
  const { parsed, group, theme, labels, labelKey, tf } = ctx;
  const { log, events, analysis } = parsed;
  const range = useGroupValue(group, 'range', () => group.range);
  const zoomed = useMemo(() => group.isZoomedFrom(parsed.analysis.focus), [group, range, parsed.analysis.focus]);
  const [scope, setScope] = useState<Scope>('focus');
  const eff: Scope = scope === 'zoom' && !zoomed ? 'focus' : scope;
  const span = useMemo(
    () => (eff === 'all' ? { start: 0, end: analysis.duration } : eff === 'zoom' ? range : analysis.focus),
    [eff, analysis, range],
  );
  const stats = useMemo(() => computeStats(log, events, analysis, span), [log, events, analysis, span]);
  const [sort, setSort] = useState<'ch' | 'ah' | 'peak'>('ch');
  const chArrays = useChannelArrays(log, channels);

  if (!log || !log.channelCount)
    return (
      <div className="page">
        <div className="banner info">
          <Icon name="info" /> This log has no power distribution data (no PDP/PDH was on the CAN bus, or it has CAN ID other than the default).
        </div>
      </div>
    );

  const setLabel = (ch: number, value: string) =>
    updateSettings((s) => {
      const arr = [...(s.channelLabels[labelKey] ?? [])];
      arr[ch] = value;
      return { channelLabels: { ...s.channelLabels, [labelKey]: arr } };
    });

  const maxAh = Math.max(...stats.channels.map((c) => c.ah), 0.0001);
  const rows = [...stats.channels].sort((a, b) =>
    sort === 'ch' ? a.ch - b.ch : sort === 'ah' ? b.ah - a.ah : (b.peak || 0) - (a.peak || 0),
  );
  const toggle = (ch: number) =>
    setChannels(channels.includes(ch) ? channels.filter((c) => c !== ch) : [...channels, ch].sort((a, b) => a - b));

  return (
    <div className="page">
      <div className="toolbar">
        <span className="label">Scope</span>
        <div className="seg">
          <button className={eff === 'focus' ? 'on' : ''} onClick={() => setScope('focus')}>
            {analysis.match ? analysis.match.label : 'Active time'}
          </button>
          <button className={eff === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            Whole log
          </button>
          {zoomed && (
            <button className={eff === 'zoom' ? 'on' : ''} onClick={() => setScope('zoom')}>
              Zoomed range
            </button>
          )}
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          {log.pdType === 'rev' ? 'REV Power Distribution Hub' : 'CTRE Power Distribution Panel'}
          {log.pdCanId != null ? ` · CAN ID ${log.pdCanId}` : ''} · {log.channelCount} channels
        </span>
        <span style={{ flex: 1 }} />
        <span className="badge">Total peak {stats.current.peak.toFixed(0)} A</span>
        <span className="badge">Used {(stats.current.ah * 1000).toFixed(0)} mAh</span>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Current heatmap</h3>
          <span className="faint" style={{ fontSize: 12 }}>
            Peak current per channel over time. Click a cell to jump there.
          </span>
        </div>
        <div className="card-body">
          <Heatmap
            log={log}
            span={span}
            labels={labels}
            theme={theme}
            onPick={(ch, t) => {
              if (!channels.includes(ch)) setChannels([...channels, ch].sort((a, b) => a - b));
              ctx.jumpTo(t, { chart: 'channels' });
            }}
          />
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Channels</h3>
            <span className="grow" />
            <div className="seg">
              <button className={sort === 'ch' ? 'on' : ''} onClick={() => setSort('ch')}>
                #
              </button>
              <button className={sort === 'ah' ? 'on' : ''} onClick={() => setSort('ah')}>
                Charge
              </button>
              <button className={sort === 'peak' ? 'on' : ''} onClick={() => setSort('peak')}>
                Peak
              </button>
            </div>
          </div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>Name (click to edit)</th>
                  <th className="r">Avg</th>
                  <th className="r">Peak</th>
                  <th>Charge used</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.ch}>
                    <td>
                      <input
                        type="checkbox"
                        checked={channels.includes(c.ch)}
                        onChange={() => toggle(c.ch)}
                        style={{ accentColor: channelColor(c.ch, theme.dark) }}
                        title="Plot this channel"
                      />
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                        <span className="swatch" style={{ background: channelColor(c.ch, theme.dark) }} />
                        <span className="faint num" style={{ width: 20, fontSize: 12 }}>
                          {c.ch}
                        </span>
                        <input
                          key={`${labelKey}-${c.ch}`}
                          className="ch-label-input"
                          placeholder={`Ch ${c.ch}`}
                          defaultValue={labels?.[c.ch] ?? ''}
                          onBlur={(e) => setLabel(c.ch, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        />
                      </div>
                    </td>
                    <td className="r">{Number.isFinite(c.avg) ? c.avg.toFixed(1) : '–'} A</td>
                    <td className="r">
                      <button
                        className="btn small ghost"
                        style={{ padding: '0 4px' }}
                        onClick={() => ctx.jumpTo(c.peakT, { chart: 'channels' })}
                        title={Number.isFinite(c.peakT) ? `at ${tf.fmt(c.peakT)}` : ''}
                        disabled={!Number.isFinite(c.peakT)}
                      >
                        {Number.isFinite(c.peak) ? c.peak.toFixed(1) : '–'} A
                      </button>
                    </td>
                    <td style={{ minWidth: 130 }}>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <div className="bar" style={{ flex: 1 }}>
                          <div style={{ width: `${(c.ah / maxAh) * 100}%`, background: channelColor(c.ch, theme.dark) }} />
                        </div>
                        <span className="num faint" style={{ fontSize: 12, width: 62, textAlign: 'right' }}>
                          {(c.ah * 1000).toFixed(0)} mAh
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
              Names are saved in this browser for {labelKey.startsWith('any') ? 'all logs' : `team ${labelKey.split(':')[0]}`} and used in charts and CSV exports.
            </p>
          </div>
        </div>

        <div className="card chart-card">
          <div className="chart-title">
            Selected channels
            <span className="grow" style={{ flex: 1 }} />
            <button className="btn small ghost" onClick={() => setChannels(defaultChannels(log))}>
              Top 6
            </button>
            <button className="btn small ghost" onClick={() => setChannels([])}>
              Clear
            </button>
          </div>
          {channels.length ? (
            <TimeChart
              group={group}
              x={log.time}
              series={channels.map((ch) => ({
                label: channelName(labels, ch),
                color: channelColor(ch, theme.dark),
                data: chArrays.get(ch) ?? [],
                scale: 'a',
                fmt: (v: number) => `${v.toFixed(1)} A`,
              }))}
              axes={[{ scale: 'a', fmt: (v) => `${v}A`, range: (_min, max) => [0, Math.max((max ?? 5) * 1.08, 5)] }]}
              height={300}
              theme={theme}
              rev={`power|${ctx.entry.key}|${log.count}|${channels.join(',')}|${labels?.join(',')}|${tf.mode}|${theme.dark}`}
            />
          ) : (
            <p className="muted">Tick channels in the table to plot them.</p>
          )}
        </div>
      </div>
    </div>
  );
}
