import { useEffect, useRef } from 'react';
import type { Analysis } from '../lib/analysis';
import type { ChartGroup } from '../lib/chartGroup';
import type { DSLog } from '../lib/dslog';
import { alpha, type ChartTheme } from '../lib/theme';

interface Props {
  group: ChartGroup;
  analysis: Analysis;
  log: DSLog | null;
  theme: ChartTheme;
  height?: number;
  /** When false, clicking jumps instead of steering the zoom window. */
  interactive?: boolean;
  onJump?: (t: number) => void;
}

const BAND_H = 16;
const EDGE = 7;

export function Navigator({ group, analysis, log, theme, height = 78, interactive = true, onJump }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    let width = wrap.clientWidth;
    let columns: { min: Float32Array; max: Float32Array } | null = null;
    const full = () => group.full;
    const tToX = (t: number) => ((t - full().start) / (full().end - full().start || 1)) * width;
    const xToT = (x: number) => full().start + (x / width) * (full().end - full().start);

    const buildColumns = () => {
      columns = null;
      if (!log || !width) return;
      const min = new Float32Array(Math.ceil(width)).fill(NaN);
      const max = new Float32Array(Math.ceil(width)).fill(NaN);
      for (let i = 0; i < log.count; i++) {
        const v = log.voltage[i];
        if (Number.isNaN(v)) continue;
        const c = Math.floor(tToX(i * log.period));
        if (c < 0 || c >= min.length) continue;
        if (!(v >= min[c])) min[c] = Number.isNaN(min[c]) ? v : Math.min(min[c], v);
        if (!(v <= max[c])) max[c] = Number.isNaN(max[c]) ? v : Math.max(max[c], v);
      }
      columns = { min, max };
    };

    const draw = () => {
      const dpr = devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `600 10.5px ${theme.font}`;
      ctx.textBaseline = 'middle';

      // Mode band
      ctx.fillStyle = alpha(theme.faint, 0.14);
      ctx.fillRect(0, 0, width, BAND_H);
      for (const m of analysis.modes) {
        if (m.mode === 'disabled') continue;
        const color = m.mode === 'auto' ? theme.auto : m.mode === 'teleop' ? theme.teleop : theme.test;
        const x0 = tToX(m.start);
        const x1 = tToX(m.end);
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), BAND_H);
        if (x1 - x0 > 44) {
          ctx.fillStyle = theme.dark ? '#0b0e13' : '#ffffff';
          ctx.fillText(m.mode === 'auto' ? 'Auto' : m.mode === 'teleop' ? 'Teleop' : 'Test', x0 + 6, BAND_H / 2 + 0.5);
        }
      }
      for (const s of analysis.noComms) {
        const x0 = tToX(s.start);
        const x1 = tToX(s.end);
        ctx.fillStyle = alpha(theme.nocomms, 0.55);
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), BAND_H);
      }

      // Plot area
      const top = BAND_H + 4;
      const bottom = height - 8;
      const plotH = bottom - top;
      for (const s of analysis.noComms) {
        const x0 = tToX(s.start);
        ctx.fillStyle = alpha(theme.nocomms, theme.dark ? 0.16 : 0.12);
        ctx.fillRect(x0, top, Math.max(1, tToX(s.end) - x0), plotH);
      }
      if (columns) {
        const lo = 6;
        const hi = 13.5;
        const y = (v: number) => bottom - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * plotH;
        ctx.fillStyle = alpha(theme.c.volt, 0.85);
        for (let c = 0; c < columns.min.length; c++) {
          const a = columns.min[c];
          if (Number.isNaN(a)) continue;
          const b = columns.max[c];
          const y0 = y(b);
          const y1 = y(a);
          ctx.fillRect(c, y0, 1, Math.max(1.2, y1 - y0));
        }
        // Brownout threshold
        ctx.strokeStyle = alpha(theme.brownout, 0.5);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y(6.8));
        ctx.lineTo(width, y(6.8));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const s of analysis.brownouts) {
        const x0 = tToX(s.start);
        ctx.fillStyle = alpha(theme.brownout, 0.6);
        ctx.fillRect(x0, top, Math.max(2, tToX(s.end) - x0), plotH);
      }
      ctx.fillStyle = theme.stall;
      for (const s of analysis.codeStalls) {
        const x0 = tToX(s.start);
        ctx.fillRect(x0, bottom + 2, Math.max(1.5, tToX(s.end) - x0), 3);
      }
      for (const m of group.overlay.markers) {
        if (m.level === 'comms') continue;
        ctx.fillStyle = m.level === 'error' ? theme.bad : theme.warn;
        ctx.fillRect(tToX(m.t) - 0.75, height - 3, 1.5, 3);
      }

      // Viewport window
      if (interactive) {
        const r = group.range;
        const isFull = r.start <= full().start + 1e-6 && r.end >= full().end - 1e-6;
        if (!isFull) {
          const x0 = tToX(r.start);
          const x1 = tToX(r.end);
          ctx.fillStyle = theme.dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.6)';
          ctx.fillRect(0, 0, x0, height);
          ctx.fillRect(x1, 0, width - x1, height);
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x0 + 0.75, 0.75, Math.max(2, x1 - x0 - 1.5), height - 1.5);
          ctx.fillStyle = theme.accent;
          ctx.fillRect(x0, height / 2 - 8, 3, 16);
          ctx.fillRect(x1 - 3, height / 2 - 8, 3, 16);
        }
      }
      if (group.hover != null) {
        ctx.fillStyle = theme.muted;
        ctx.fillRect(tToX(group.hover) - 0.5, 0, 1, height);
      }
      if (group.pinned != null) {
        ctx.fillStyle = theme.accent;
        ctx.fillRect(tToX(group.pinned) - 1, 0, 2, height);
      }
    };

    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      if (w && w !== width) {
        width = w;
        buildColumns();
        draw();
      }
    });
    ro.observe(wrap);
    width = wrap.clientWidth;
    buildColumns();
    draw();
    const offs = [group.on('range', draw), group.on('hover', draw), group.on('pin', draw)];

    // Interaction
    let drag: { mode: 'pan' | 'left' | 'right' | 'new'; x0: number; start: number; end: number; moved: boolean } | null = null;
    const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
    const onDown = (e: PointerEvent) => {
      const x = localX(e);
      const r = group.range;
      const xs = tToX(r.start);
      const xe = tToX(r.end);
      const isFull = r.start <= full().start + 1e-6 && r.end >= full().end - 1e-6;
      let mode: 'pan' | 'left' | 'right' | 'new' = 'new';
      if (interactive && !isFull) {
        if (Math.abs(x - xs) <= EDGE) mode = 'left';
        else if (Math.abs(x - xe) <= EDGE) mode = 'right';
        else if (x > xs && x < xe) mode = 'pan';
      }
      drag = { mode, x0: x, start: r.start, end: r.end, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const x = localX(e);
      if (!drag) {
        if (!interactive) {
          canvas.style.cursor = 'pointer';
          return;
        }
        const r = group.range;
        const near = Math.abs(x - tToX(r.start)) <= EDGE || Math.abs(x - tToX(r.end)) <= EDGE;
        const inside = x > tToX(r.start) && x < tToX(r.end);
        const isFull = r.start <= full().start + 1e-6 && r.end >= full().end - 1e-6;
        canvas.style.cursor = !isFull && near ? 'ew-resize' : !isFull && inside ? 'grab' : 'crosshair';
        return;
      }
      if (Math.abs(x - drag.x0) > 3) drag.moved = true;
      if (!drag.moved || !interactive) return;
      const dt = xToT(x) - xToT(drag.x0);
      if (drag.mode === 'pan') group.setRange(drag.start + dt, drag.end + dt);
      else if (drag.mode === 'left') group.setRange(Math.min(drag.start + dt, drag.end - group.minSpan), drag.end);
      else if (drag.mode === 'right') group.setRange(drag.start, Math.max(drag.end + dt, drag.start + group.minSpan));
      else {
        const a = xToT(drag.x0);
        const b = xToT(x);
        group.setRange(Math.min(a, b), Math.max(a, b));
      }
    };
    const onUp = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const t = xToT(localX(e));
        if (!interactive) onJump?.(t);
        else if (drag.mode === 'new') {
          const w = group.range.end - group.range.start;
          const isFull = w >= full().end - full().start - 1e-6;
          if (isFull) group.pin(t, false);
          else group.setRange(t - w / 2, t + w / 2);
        }
      }
      drag = null;
    };
    const onLeave = () => group.setHover(null);
    const onHover = (e: PointerEvent) => {
      if (!drag) group.setHover(xToT(localX(e)));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointermove', onHover);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      ro.disconnect();
      offs.forEach((off) => off());
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointermove', onHover);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [group, analysis, log, theme, height, interactive, onJump]);

  return (
    <div className="navigator" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label="Log timeline" />
    </div>
  );
}

export function TimelineLegend({ theme }: { theme: ChartTheme }) {
  const items: [string, string][] = [
    ['Auto', theme.auto],
    ['Teleop', theme.teleop],
    ['No robot comms', alpha(theme.nocomms, 0.7)],
    ['Brownout', theme.brownout],
    ['Code not responding', theme.stall],
    ['Battery voltage', theme.c.volt],
  ];
  return (
    <div className="legend-row">
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}
