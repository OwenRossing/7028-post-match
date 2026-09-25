import type { TimeMode } from './settings';
import { fmtDuration } from './time';

function clock(unix: number, decimals: number): string {
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const secs = d.getSeconds() + (unix % 1);
  const ss = secs.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${hh}:${mm}:${ss}`;
}

export interface TimeFormat {
  mode: TimeMode;
  /** Offset subtracted for display (match start in match mode). */
  base: number;
  fmt: (t: number) => string;
  axis: (t: number, step: number) => string;
  /** Offset that makes axis ticks land on round displayed times. */
  tickBase: number;
  label: string;
}

/** Formats seconds-since-log-start according to the chosen time axis. */
export function makeTimeFormat(mode: TimeMode, startTime: number, matchStart?: number): TimeFormat {
  if (mode === 'clock') {
    return {
      mode,
      base: 0,
      fmt: (t) => clock(startTime + t, 2),
      axis: (t, step) => clock(startTime + t, step < 1 ? 1 : 0),
      tickBase: -(((startTime % 3600) + 3600) % 3600),
      label: 'Clock time',
    };
  }
  const base = mode === 'match' && matchStart != null ? matchStart : 0;
  return {
    mode,
    base,
    fmt: (t) => fmtDuration(t - base, 2),
    axis: (t, step) => fmtDuration(t - base, step < 1 ? 1 : 0),
    tickBase: base,
    label: base ? 'Match time' : 'Log time',
  };
}
