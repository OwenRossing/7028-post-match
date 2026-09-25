import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartGroup } from '../lib/chartGroup';
import { alpha, type ChartTheme } from '../lib/theme';

export interface SeriesSpec {
  label: string;
  color: string;
  data: ArrayLike<number | null>;
  scale?: string;
  width?: number;
  fmt?: (v: number) => string;
  dash?: number[];
  fill?: boolean;
  show?: boolean;
}

export interface AxisSpec {
  scale: string;
  side?: 'left' | 'right';
  fmt?: (v: number) => string;
  range?: (min: number, max: number) => [number, number];
}

export interface Threshold {
  value: number;
  scale: string;
  color: string;
  label?: string;
}

interface Props {
  group: ChartGroup;
  x: ArrayLike<number>;
  series: SeriesSpec[];
  axes: AxisSpec[];
  thresholds?: Threshold[];
  height?: number;
  theme: ChartTheme;
  /** Changing this rebuilds the chart. */
  rev: string;
  bands?: boolean;
  onPin?: (t: number) => void;
}

const TIME_INCRS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function drawSpans(u: uPlot, spans: { start: number; end: number }[], color: string, top = 0, height?: number) {
  const { ctx, bbox } = u;
  const h = height ?? bbox.height;
  ctx.fillStyle = color;
  for (const s of spans) {
    const x0 = Math.max(u.valToPos(s.start, 'x', true), bbox.left);
    const x1 = Math.min(u.valToPos(s.end, 'x', true), bbox.left + bbox.width);
    if (x1 <= bbox.left || x0 >= bbox.left + bbox.width) continue;
    ctx.fillRect(x0, bbox.top + top, Math.max(x1 - x0, 1), h);
  }
}

function overlayPlugin(group: ChartGroup, theme: ChartTheme, thresholds: Threshold[], bands: boolean): uPlot.Plugin {
  const dpr = devicePixelRatio || 1;
  return {
    hooks: {
      drawClear: [
        (u) => {
          if (!bands) return;
          const o = group.overlay;
          const a = theme.dark ? 0.1 : 0.09;
          drawSpans(u, o.modes.filter((m) => m.mode === 'auto'), alpha(theme.auto, a));
          drawSpans(u, o.modes.filter((m) => m.mode === 'teleop'), alpha(theme.teleop, a * 0.8));
          drawSpans(u, o.modes.filter((m) => m.mode === 'test'), alpha(theme.test, a));
          drawSpans(u, o.noComms, alpha(theme.nocomms, theme.dark ? 0.22 : 0.18));
          drawSpans(u, o.brownouts, alpha(theme.brownout, 0.28));
        },
      ],
      draw: [
        (u) => {
          const { ctx, bbox } = u;
          ctx.save();
          ctx.beginPath();
          ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
          ctx.clip();
          for (const th of thresholds) {
            const y = u.valToPos(th.value, th.scale, true);
            if (y < bbox.top || y > bbox.top + bbox.height) continue;
            ctx.strokeStyle = th.color;
            ctx.setLineDash([5 * dpr, 4 * dpr]);
            ctx.lineWidth = dpr;
            ctx.beginPath();
            ctx.moveTo(bbox.left, y);
            ctx.lineTo(bbox.left + bbox.width, y);
            ctx.stroke();
            if (th.label) {
              ctx.setLineDash([]);
              ctx.font = `${10 * dpr}px ${theme.font}`;
              ctx.fillStyle = th.color;
              ctx.textAlign = 'right';
              ctx.fillText(th.label, bbox.left + bbox.width - 4 * dpr, y - 4 * dpr);
            }
          }
          ctx.setLineDash([]);
          // Code stalls: a thin strip along the bottom.
          if (bands && group.overlay.stalls.length)
            drawSpans(u, group.overlay.stalls, alpha(theme.stall, 0.85), bbox.height - 3 * dpr, 3 * dpr);
          if (group.overlay.showMarkers) {
            const size = 4 * dpr;
            for (const m of group.overlay.markers) {
              const x = u.valToPos(m.t, 'x', true);
              if (x < bbox.left || x > bbox.left + bbox.width) continue;
              const color = m.level === 'error' ? theme.bad : m.level === 'warning' ? theme.warn : theme.nocomms;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.moveTo(x - size, bbox.top);
              ctx.lineTo(x + size, bbox.top);
              ctx.lineTo(x, bbox.top + size * 1.6);
              ctx.closePath();
              ctx.fill();
              if (m.level === 'error') {
                ctx.strokeStyle = alpha(color, 0.25);
                ctx.lineWidth = dpr;
                ctx.beginPath();
                ctx.moveTo(x, bbox.top + size * 1.6);
                ctx.lineTo(x, bbox.top + bbox.height);
                ctx.stroke();
              }
            }
          }
          if (group.pinned != null) {
            const x = u.valToPos(group.pinned, 'x', true);
            if (x >= bbox.left && x <= bbox.left + bbox.width) {
              ctx.strokeStyle = theme.accent;
              ctx.lineWidth = 2 * dpr;
              ctx.beginPath();
              ctx.moveTo(x, bbox.top);
              ctx.lineTo(x, bbox.top + bbox.height);
              ctx.stroke();
            }
          }
          ctx.restore();
        },
      ],
      setScale: [
        (u, key) => {
          if (key !== 'x' || group.isApplying) return;
          const { min, max } = u.scales.x;
          if (min != null && max != null) group.setRange(min, max, u);
        },
      ],
      setCursor: [
        (u) => {
          const left = u.cursor.left;
          group.setHover(left == null || left < 0 ? null : u.posToVal(left, 'x'));
          // with no cursor the legend shows just the series names, not "Battery: –"
          u.root.classList.toggle('idle', u.cursor.idx == null);
        },
      ],
    },
  };
}

export function TimeChart({ group, x, series, axes, thresholds = [], height = 180, theme, rev, bands = true, onPin }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const axisBase = {
      stroke: theme.faint,
      font: `11px ${theme.font}`,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { stroke: theme.grid, width: 1, size: 4 },
    };
    const scales: uPlot.Scales = { x: { time: false, auto: false } };
    for (const a of axes) scales[a.scale] = { auto: true, ...(a.range ? { range: (_u, min, max) => a.range!(min, max) } : {}) };

    let panStart: { x: number; range: { start: number; end: number } } | null = null;
    let downX = 0;

    const opts: uPlot.Options = {
      width: host.clientWidth || 600,
      height,
      pxAlign: false,
      scales,
      legend: { live: true },
      cursor: {
        sync: { key: group.key, setSeries: false },
        drag: { x: true, y: false, setScale: true },
        points: { size: 6 },
        bind: {
          mousedown: (u, _t, handler) => (e: MouseEvent) => {
            downX = e.clientX;
            if (e.shiftKey || e.button === 1) {
              panStart = { x: e.clientX, range: { ...group.range } };
              e.preventDefault();
              const move = (ev: MouseEvent) => {
                if (!panStart) return;
                const w = panStart.range.end - panStart.range.start;
                const dt = ((ev.clientX - panStart.x) / u.over.clientWidth) * w;
                group.setRange(panStart.range.start - dt, panStart.range.end - dt);
              };
              const up = () => {
                panStart = null;
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
              };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
              return null;
            }
            return handler(e);
          },
          dblclick: () => () => {
            group.reset();
            return null;
          },
        },
      },
      series: [
        { label: 'Time', value: (_u, v) => (v == null ? '–' : group.fmt(v)) },
        ...series.map<uPlot.Series>((s) => ({
          label: s.label,
          scale: s.scale ?? 'y',
          stroke: s.color,
          width: s.width ?? 1.5,
          dash: s.dash,
          show: s.show ?? true,
          fill: s.fill ? alpha(s.color, 0.12) : undefined,
          points: { show: false },
          spanGaps: false,
          value: (_u, v) => (v == null ? '–' : s.fmt ? s.fmt(v) : v.toFixed(2)),
        })),
      ],
      axes: [
        {
          ...axisBase,
          incrs: TIME_INCRS,
          space: 80,
          splits: (_u, _i, min, max, incr) => {
            const b = group.tickBase;
            const out: number[] = [];
            const first = Math.ceil((min - b) / incr) * incr + b;
            for (let v = first; v <= max + 1e-9 && out.length < 500; v += incr) out.push(Number(v.toFixed(6)));
            return out;
          },
          values: (_u, splits) => {
            const step = splits.length > 1 ? splits[1] - splits[0] : 1;
            return splits.map((v) => group.fmtAxis(v, step));
          },
        },
        ...axes.map<uPlot.Axis>((a) => ({
          ...axisBase,
          scale: a.scale,
          side: a.side === 'right' ? 1 : 3,
          size: 48,
          grid: a.side === 'right' ? { show: false } : axisBase.grid,
          values: (_u, splits) => splits.map((v) => (a.fmt ? a.fmt(v) : String(v))),
        })),
      ],
      plugins: [overlayPlugin(group, theme, thresholds, bands)],
    };

    const data = [x, ...series.map((s) => s.data)] as uPlot.AlignedData;
    const u = new uPlot(opts, data, host);
    u.root.classList.add('idle');
    group.add(u);

    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!(e.ctrlKey || e.metaKey || e.shiftKey || horizontal)) return; // let the page scroll
      e.preventDefault();
      const rect = u.over.getBoundingClientRect();
      if (e.shiftKey || horizontal) {
        const d = horizontal ? e.deltaX : e.deltaY;
        group.panBy(d / rect.width);
      } else {
        const t = u.posToVal(e.clientX - rect.left, 'x');
        group.zoomAround(t, Math.exp(e.deltaY * 0.004));
      }
    };
    const onClick = (e: MouseEvent) => {
      if (Math.abs(e.clientX - downX) > 3) return;
      const rect = u.over.getBoundingClientRect();
      const t = u.posToVal(e.clientX - rect.left, 'x');
      if (onPinRef.current) onPinRef.current(t);
      else group.pin(t, false);
    };
    u.over.addEventListener('wheel', onWheel, { passive: false });
    u.over.addEventListener('click', onClick);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w > 0 && Math.abs(w - u.width) > 1) u.setSize({ width: w, height });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      u.over.removeEventListener('wheel', onWheel);
      u.over.removeEventListener('click', onClick);
      group.remove(u);
      u.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, theme, group, height]);

  return <div className="chart-host" ref={hostRef} />;
}
