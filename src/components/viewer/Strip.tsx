import { useEffect, useRef, useState } from 'react';
import type { Span } from '../../lib/analysis';
import type { DSLog } from '../../lib/dslog';
import { alpha, type ChartTheme } from '../../lib/theme';
import { useGroupValue, type ViewCtx } from './types';

/** Sequential ramp for current: background → orange → bright. */
export function heatColor(v: number, dark: boolean): string {
  const stops = dark
    ? [
        [27, 32, 41],
        [150, 60, 25],
        [255, 128, 89],
        [255, 226, 170],
      ]
    : [
        [236, 238, 242],
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

interface Props {
  ctx: ViewCtx;
  log: DSLog;
  arr: Float32Array;
  range: Span;
  mode: 'line' | 'heat';
  color: string;
  /** Fixed scale; otherwise the data in view. */
  lo?: number;
  hi?: number;
  /** Draw the lowest value per pixel (battery dips) instead of the highest. */
  low?: boolean;
  theme: ChartTheme;
}

/** A one-line picture of a signal over the visible range. Click to pin a time; follows the charts' cursor. */
export function Strip({ ctx, log, arr, range, mode, color, lo, hi, low, theme }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const hover = useGroupValue(ctx.group, 'hover', () => ctx.group.hover);
  const pinned = useGroupValue(ctx.group, 'pin', () => ctx.group.pinned);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { w, h } = size;
    const canvas = canvasRef.current;
    if (!canvas || !w || !h) return;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const i0 = Math.max(0, Math.floor(range.start / log.period));
    const i1 = Math.min(log.count - 1, Math.ceil(range.end / log.period));
    const cols = Math.max(1, Math.floor(w));
    const mins = new Float32Array(cols).fill(NaN);
    const maxs = new Float32Array(cols).fill(NaN);
    let dlo = Infinity;
    let dhi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const v = arr[i];
      if (Number.isNaN(v)) continue;
      const c = Math.min(cols - 1, Math.floor(((i - i0) / Math.max(1, i1 - i0)) * cols));
      if (!(mins[c] <= v)) mins[c] = v;
      if (!(maxs[c] >= v)) maxs[c] = v;
      if (v < dlo) dlo = v;
      if (v > dhi) dhi = v;
    }
    const a = lo ?? dlo;
    const b = Math.max(hi ?? dhi, a + 1e-6);

    if (mode === 'heat') {
      for (let c = 0; c < cols; c++) {
        const v = maxs[c];
        if (Number.isNaN(v)) continue;
        g.fillStyle = heatColor(Math.sqrt(Math.max(0, v) / b), theme.dark);
        g.fillRect(c, 0, 1.2, h);
      }
      return;
    }
    const y = (v: number) => h - 1.5 - ((v - a) / (b - a)) * (h - 3);
    g.fillStyle = alpha(color, 0.22);
    for (let c = 0; c < cols; c++) {
      if (Number.isNaN(maxs[c])) continue;
      const top = y(maxs[c]);
      g.fillRect(c, top, 1, Math.max(1, y(mins[c]) - top));
    }
    g.strokeStyle = color;
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (let c = 0; c < cols; c++) {
      const v = low ? mins[c] : maxs[c];
      if (Number.isNaN(v)) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(c + 0.5, y(v));
      else g.moveTo(c + 0.5, y(v));
      pen = true;
    }
    g.stroke();
  }, [size, arr, log, range, mode, color, lo, hi, low, theme]);

  const span = Math.max(range.end - range.start, 1e-6);
  const pct = (t: number) => ((t - range.start) / span) * 100;
  const inView = (t: number | null): t is number => t != null && t >= range.start && t <= range.end;

  return (
    <div
      className={`strip ${mode}`}
      ref={wrapRef}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        ctx.group.setHover(range.start + ((e.clientX - r.left) / r.width) * span);
      }}
      onMouseLeave={() => ctx.group.setHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        ctx.group.pin(range.start + ((e.clientX - r.left) / r.width) * span, false);
      }}
    >
      <canvas ref={canvasRef} />
      {inView(hover) && <i className="strip-hover" style={{ left: `${pct(hover)}%` }} />}
      {inView(pinned) && <i className="strip-pin" style={{ left: `${pct(pinned)}%` }} />}
    </div>
  );
}
