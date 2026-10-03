// Who is using the battery. Puts the power distribution channels of the Driver Station log and the motor currents of the
// robot logs side by side, finds the moment the battery was lowest, and ranks everything by what it drew then, at its
// peak, and in total. Also says, when there is nothing to rank, what the Driver Station log did record and why.

import { FLAG, type DSLog } from './dslog';
import type { RobotSignal } from './robotSeries';

export interface PowerSource {
  /** The Graphs row that shows it (`ch3`, `m:7`). */
  id: string;
  name: string;
  /** A power distribution channel, or a motor controller's own current. */
  kind: 'channel' | 'motor';
  /** On the Driver Station log's grid. */
  arr: Float32Array;
  /** Said next to the name when the number is not what the battery sees. */
  note?: string;
}

/**
 * Everything that has a current, once. A power channel and a motor's supply current are what the battery supplies; a stator
 * current is the torque current and can be far above it, so it is only used for a motor with no supply current of its own. A
 * robot log's own power channel array is left out when the Driver Station log has the channels already.
 */
export function powerSources(log: DSLog, robot: RobotSignal[], channelLabel: (ch: number) => string): PowerSource[] {
  const out: PowerSource[] = log.currents.map((arr, ch) => ({ id: `ch${ch}`, name: channelLabel(ch), kind: 'channel' as const, arr }));
  const supply = new Set(robot.filter((s) => s.kind === 'current' && /supply/i.test(s.short)).map((s) => `${s.log}|${s.group}`));
  robot.forEach((s, i) => {
    if (s.kind !== 'current') return;
    const channel = /\[\d+\]$/.test(s.short);
    const stator = /stator/i.test(s.short);
    if (channel && log.channelCount > 0) return;
    if (stator && supply.has(`${s.log}|${s.group}`)) return;
    out.push({ id: `m:${i}`, name: s.label ?? s.name, kind: channel ? 'channel' : 'motor', arr: s.arr, note: stator ? 'stator current: torque, not what the battery supplies' : undefined });
  });
  return out;
}

export interface PowerRow {
  source: PowerSource;
  peak: number;
  /** Record of the peak. */
  peakAt: number;
  /** Average while enabled. */
  mean: number;
  /** Charge drawn while enabled, in amp-hours. */
  ah: number;
  /** What it drew at the battery's low point (the largest value within 0.1 s of it). */
  atLow: number;
}

export interface PowerReport {
  /** The record where the battery was lowest while the robot was enabled. */
  low: { index: number; volts: number } | null;
  /** The robot's total current at that moment: the board's own total, or the sum of what is listed. */
  total: number | null;
  totalIsSum: boolean;
  rows: PowerRow[];
}

const enabledAt = (log: DSLog, i: number) => log.comms[i] === 1 && (log.flags[i] & (FLAG.DS_AUTO | FLAG.DS_TELEOP)) !== 0;
const WINDOW = 5; // records, 0.1 s

function maxNear(arr: ArrayLike<number>, i: number, win = WINDOW): number {
  let m = NaN;
  for (let k = Math.max(0, i - win); k <= Math.min(arr.length - 1, i + win); k++) {
    const v = arr[k];
    if (!Number.isNaN(v) && (Number.isNaN(m) || v > m)) m = v;
  }
  return m;
}

export function powerReport(log: DSLog, sources: PowerSource[]): PowerReport {
  const enabled: number[] = [];
  for (let i = 0; i < log.count; i++) if (enabledAt(log, i)) enabled.push(i);
  // a log with no enabled time (a pit check) is judged over everything the robot was connected for
  const span = enabled.length ? enabled : Array.from({ length: log.count }, (_, i) => i).filter((i) => log.comms[i] === 1);

  let low: PowerReport['low'] = null;
  for (const i of span) {
    const v = log.voltage[i];
    if (Number.isFinite(v) && (!low || v < low.volts)) low = { index: i, volts: v };
  }

  const rows: PowerRow[] = [];
  for (const source of sources) {
    let peak = NaN;
    let peakAt = -1;
    let sum = 0;
    let n = 0;
    for (const i of span) {
      const v = source.arr[i];
      if (Number.isNaN(v)) continue;
      sum += v;
      n++;
      if (Number.isNaN(peak) || v > peak) [peak, peakAt] = [v, i];
    }
    if (!n) continue;
    rows.push({ source, peak, peakAt, mean: sum / n, ah: (sum * log.period) / 3600, atLow: low ? maxNear(source.arr, low.index) : NaN });
  }

  let total: number | null = null;
  let totalIsSum = false;
  if (low) {
    const own = maxNear(log.totalCurrent, low.index);
    if (Number.isFinite(own)) total = own;
    else if (rows.some((r) => Number.isFinite(r.atLow))) {
      total = rows.reduce((a, r) => a + (Number.isFinite(r.atLow) ? r.atLow : 0), 0);
      totalIsSum = true;
    }
  }
  return { low, total, totalIsSum, rows };
}

/** The robot's total current within `win` records of one (the board's own total, NaN where it has none). */
export const totalNear = (log: DSLog, index: number, win = WINDOW): number => maxNear(log.totalCurrent, index, win);

export type PowerSort = 'low' | 'peak' | 'used';

/** The rows in the order asked for, biggest first. */
export function sortRows(rows: PowerRow[], by: PowerSort): PowerRow[] {
  const key = (r: PowerRow) => (by === 'low' ? r.atLow : by === 'peak' ? r.peak : r.ah);
  return [...rows].sort((a, b) => (Number.isNaN(key(b)) ? -Infinity : key(b)) - (Number.isNaN(key(a)) ? -Infinity : key(a)));
}

/** The biggest draws at one moment, for the card that says what is going on at a pinned time. */
export function drawAt(sources: PowerSource[], index: number, n = 3): { source: PowerSource; amps: number }[] {
  return sources
    .map((source) => ({ source, amps: maxNear(source.arr, index, 2) }))
    .filter((d) => Number.isFinite(d.amps) && d.amps >= 1)
    .sort((a, b) => b.amps - a.amps)
    .slice(0, n);
}

export interface PdStatus {
  kind: 'ok' | 'none' | 'unknown' | 'idle';
  text: string;
}

const KNOWN_PD = new Set([0, 25, 33]);

/**
 * What the Driver Station log says about the power distribution board, in a sentence. A board the log never mentions has
 * nothing to graph, and which way it fails (never reported, a type not decoded, or decoded but never above 1 A) decides what to
 * do about it.
 */
export function pdStatus(log: DSLog): PdStatus {
  const decoded = (log.typeBytes[33] ?? 0) + (log.typeBytes[25] ?? 0);
  const unknown = Object.entries(log.typeBytes).filter(([t]) => !KNOWN_PD.has(Number(t)));
  const unknownCount = unknown.reduce((a, [, c]) => a + c, 0);
  const types = unknown.map(([t, c]) => `type ${t} ×${c}`).join(', ');
  if (!decoded && unknownCount)
    return { kind: 'unknown', text: `${unknownCount.toLocaleString('en-US')} of this log's ${log.count.toLocaleString('en-US')} records carry a power distribution type PitView does not decode (${types}).` };
  if (!decoded)
    return {
      kind: 'none',
      text: `None of this log's ${log.count.toLocaleString('en-US')} records carry power distribution data: the Driver Station recorded no board.`,
    };
  const used = log.currents.some((a) => a.some((v) => v >= 1));
  if (!used) return { kind: 'idle', text: 'The power distribution board was recorded, but every channel stayed under 1 A: the robot was probably not driven.' };
  return { kind: 'ok', text: `The ${log.pdType === 'rev' ? 'REV PDH' : 'CTRE PDP'} was recorded${unknownCount ? `, along with ${unknownCount.toLocaleString('en-US')} records of a type PitView does not decode (${types})` : ''}.` };
}
