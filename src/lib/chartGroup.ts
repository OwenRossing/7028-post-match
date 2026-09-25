// Keeps a set of uPlot charts in sync: shared x range (zoom/pan), hover time and a pinned marker.
import type uPlot from 'uplot';
import type { ModeSegment, Span } from './analysis';

export interface Marker {
  t: number;
  level: 'error' | 'warning' | 'comms';
}

export interface Overlay {
  modes: ModeSegment[];
  noComms: Span[];
  stalls: Span[];
  brownouts: Span[];
  markers: Marker[];
  showMarkers: boolean;
}

type Channel = 'range' | 'hover' | 'pin';

let groupSeq = 0;

export class ChartGroup {
  readonly key = `sync-${++groupSeq}`;
  readonly plots = new Set<uPlot>();
  full: Span;
  range: Span;
  hover: number | null = null;
  pinned: number | null = null;
  overlay: Overlay = { modes: [], noComms: [], stalls: [], brownouts: [], markers: [], showMarkers: true };
  /** Formats a time for legends and tooltips. */
  fmt: (t: number) => string = (t) => t.toFixed(1);
  /** Formats an axis tick; step is the tick spacing in seconds. */
  fmtAxis: (t: number, step: number) => string = (t) => t.toFixed(0);
  /** Ticks are placed at round multiples of (t - tickBase), e.g. round match times. */
  tickBase = 0;
  /** Smallest visible span, in seconds. */
  minSpan = 0.2;
  private applying = false;
  private listeners: Record<Channel, Set<() => void>> = { range: new Set(), hover: new Set(), pin: new Set() };
  private hoverFrame = 0;

  constructor(full: Span, range?: Span) {
    this.full = full;
    this.range = range ?? full;
  }

  on(channel: Channel, fn: () => void): () => void {
    this.listeners[channel].add(fn);
    return () => this.listeners[channel].delete(fn);
  }

  private emit(channel: Channel) {
    this.listeners[channel].forEach((fn) => fn());
  }

  get isApplying() {
    return this.applying;
  }

  add(u: uPlot) {
    this.plots.add(u);
    this.applyTo(u);
  }

  remove(u: uPlot) {
    this.plots.delete(u);
  }

  private applyTo(u: uPlot) {
    this.applying = true;
    try {
      u.setScale('x', { min: this.range.start, max: this.range.end });
    } finally {
      this.applying = false;
    }
  }

  setFull(full: Span) {
    const wasFull = Math.abs(this.range.start - this.full.start) < 1e-6 && Math.abs(this.range.end - this.full.end) < 1e-6;
    this.full = full;
    if (wasFull) this.setRange(full.start, full.end);
    else this.setRange(this.range.start, this.range.end);
  }

  setRange(start: number, end: number, from?: uPlot) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (end - start < this.minSpan) {
      const mid = (start + end) / 2;
      start = mid - this.minSpan / 2;
      end = mid + this.minSpan / 2;
    }
    const span = Math.min(end - start, this.full.end - this.full.start);
    if (start < this.full.start) {
      start = this.full.start;
      end = start + span;
    }
    if (end > this.full.end) {
      end = this.full.end;
      start = end - span;
    }
    if (start === this.range.start && end === this.range.end && !from) return;
    this.range = { start, end };
    this.applying = true;
    try {
      for (const u of this.plots) if (u !== from) u.setScale('x', { min: start, max: end });
    } finally {
      this.applying = false;
    }
    this.emit('range');
  }

  zoomAround(t: number, factor: number) {
    const { start, end } = this.range;
    this.setRange(t - (t - start) * factor, t + (end - t) * factor);
  }

  zoom(factor: number) {
    const mid = (this.range.start + this.range.end) / 2;
    this.zoomAround(this.hover ?? this.pinned ?? mid, factor);
  }

  panBy(fraction: number) {
    const w = this.range.end - this.range.start;
    this.setRange(this.range.start + w * fraction, this.range.end + w * fraction);
  }

  reset() {
    this.setRange(this.full.start, this.full.end);
  }

  /** True when the view differs from both the whole log and the given default span. */
  isZoomedFrom(span?: { start: number; end: number }): boolean {
    const near = (a: { start: number; end: number }) =>
      Math.abs(this.range.start - a.start) < 0.05 && Math.abs(this.range.end - a.end) < 0.05;
    return !near(this.full) && !(span && near(span));
  }

  /** Pins a time marker; optionally scrolls it into view (keeping the zoom level). */
  pin(t: number | null, reveal = true) {
    this.pinned = t;
    if (t != null && reveal && (t < this.range.start || t > this.range.end)) {
      const w = this.range.end - this.range.start;
      this.setRange(t - w / 2, t + w / 2);
    }
    this.redraw();
    this.emit('pin');
  }

  /** Zooms to a window around t. */
  focusOn(t: number, width = 20) {
    this.pinned = t;
    this.setRange(t - width / 2, t + width / 2);
    this.redraw();
    this.emit('pin');
  }

  setHover(t: number | null) {
    if (t === this.hover) return;
    this.hover = t;
    if (!this.hoverFrame)
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        this.emit('hover');
      });
  }

  setOverlay(overlay: Partial<Overlay>) {
    this.overlay = { ...this.overlay, ...overlay };
    this.redraw();
  }

  redraw() {
    for (const u of this.plots) u.redraw(false, false);
  }
}
