/** Seconds between the LabVIEW epoch (1904-01-01 UTC) and the unix epoch. */
const LV_EPOCH_OFFSET = 2082844800;

/** Converts a LabVIEW timestamp (int64 seconds + uint64 fraction of 2^64) to unix seconds. */
export function lvToUnix(view: DataView, offset: number): number {
  const seconds = Number(view.getBigInt64(offset));
  const fraction = Number(view.getBigUint64(offset + 8)) / 2 ** 64;
  return seconds - LV_EPOCH_OFFSET + fraction;
}

/** Parses the DS file naming scheme ("2026_05_16 11_38_21 Sat") as local time, in unix seconds. */
export function parseLogName(name: string): number | null {
  const m = /(\d{4})_(\d{2})_(\d{2}) (\d{2})_(\d{2})_(\d{2})/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
}

/** Formats seconds as m:ss.s (or h:mm:ss for long spans). Negative values get a leading minus. */
export function fmtDuration(sec: number, decimals = 1): string {
  if (!Number.isFinite(sec)) return '–';
  const neg = sec < 0;
  let s = Math.abs(sec);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let secStr = s.toFixed(decimals);
  if (secStr.startsWith('60')) secStr = (0).toFixed(decimals); // rounding edge
  const pad = decimals > 0 ? 3 + decimals : 2;
  secStr = secStr.padStart(pad, '0');
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
  return (neg ? '-' : '') + body;
}

/** Short human duration: "2m 34s", "45.2s", "1h 03m". */
export function fmtSpan(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(Math.round(sec - m * 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, '0')}m`;
}

export function fmtClock(unix: number, withSeconds = true): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  });
}

export function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(unix: number): string {
  return `${fmtDate(unix)} · ${fmtClock(unix, false)}`;
}
