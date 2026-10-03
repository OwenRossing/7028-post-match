// Robot logs as graphs. Every numeric signal of an attached roboRIO or Phoenix log is resampled onto the Driver Station
// log's 20 ms grid, using the offset that lined the two logs up, so it can be shown with the same strips and charts as the
// Driver Station's own signals. Motor currents are picked out by name, to read per-motor use like the power channels do.

import { parseWPILog, type WPILogSeries } from './wpilog';

export interface RobotSignal {
  /** The robot log it is from. */
  log: string;
  /** Its full name in the log. */
  name: string;
  /** The device or prefix it belongs to ("Phoenix6/TalonFX-1"). */
  group: string;
  /** What is left of the name after the group ("StatorCurrent"). */
  short: string;
  /** A motor current (or a power distribution channel) as opposed to anything else. */
  kind: 'current' | 'other';
  /** For a current: what to call the motor, "TalonFX 1 · Stator". */
  label?: string;
  /** On the Driver Station log's grid: one value per record, NaN where the signal has no value. */
  arr: Float32Array;
}

/** Signals past this many are dropped (currents are kept first): a log can have thousands, and each takes a strip. */
export const MAX_SIGNALS = 1500;

const NOT_A_MOTOR = /limit|threshold|setpoint|max|min|allowed|enable|mode|config|target|command|request|total|battery/i;

/** Splits "Phoenix6/TalonFX-1/StatorCurrent" into its device and the rest. */
export function splitName(name: string): { group: string; short: string } {
  const clean = name.replace(/^NT:/, '').replace(/^\/+/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? { group: 'Other', short: clean } : { group: clean.slice(0, i), short: clean.slice(i + 1) };
}

const pretty = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
const lastSegment = (group: string) => group.slice(group.lastIndexOf('/') + 1);

/** Whether a signal is a motor's (or a power channel's) current, and what to call it. */
export function motorCurrent(name: string): { group: string; short: string; label: string } | null {
  const { group, short } = splitName(name);
  const element = /^(.*?)\[(\d+)\]$/.exec(short);
  const base = element ? element[1] : short;
  if (!/current|amps?$/i.test(base) || NOT_A_MOTOR.test(base) || NOT_A_MOTOR.test(lastSegment(group))) return null;
  const device = pretty(lastSegment(group));
  if (element) return { group, short, label: `${device} ch ${element[2]}` }; // an array of currents, one per channel
  const what = pretty(base.replace(/current|amps?$/gi, ''));
  return { group, short, label: what ? `${device} · ${what}` : device };
}

/**
 * One robot signal on the Driver Station grid. Record `i` covers DS time [i·period, (i+1)·period), which is robot time
 * `offset` earlier. A bin with several samples takes the one furthest from zero (`peak`, so a current spike is not
 * averaged away) or their mean; a bin with none holds the last value, while the signal exists, and is NaN before and after.
 */
export function resample(s: WPILogSeries, offset: number, count: number, period: number, how: 'peak' | 'mean'): Float32Array {
  const out = new Float32Array(count).fill(NaN);
  if (!s.t.length || count <= 0) return out;
  const sum = new Float64Array(how === 'mean' ? count : 0);
  const n = new Uint16Array(how === 'mean' ? count : 0);
  let first = Infinity;
  let last = -Infinity;
  for (let k = 0; k < s.t.length; k++) {
    const bin = Math.floor((s.t[k] + offset) / period);
    if (bin < 0 || bin >= count) continue;
    const v = s.v[k];
    if (Number.isNaN(v)) continue;
    if (bin < first) first = bin;
    if (bin > last) last = bin;
    if (how === 'mean') {
      sum[bin] += v;
      n[bin]++;
    } else if (Number.isNaN(out[bin]) || Math.abs(v) > Math.abs(out[bin])) out[bin] = v;
  }
  if (first === Infinity) return out;
  let held = NaN;
  for (let i = first; i <= last; i++) {
    const v = how === 'mean' ? (n[i] ? sum[i] / n[i] : NaN) : out[i];
    if (!Number.isNaN(v)) held = v;
    out[i] = Number.isNaN(v) ? held : v;
  }
  return out;
}

/**
 * Every numeric signal of a robot log on the Driver Station grid. `offset` is what lined the logs up (seconds to add to
 * the robot log's time to get the match's), and `count`/`period` are the Driver Station log's records.
 */
export function extractRobotSignals(bytes: Uint8Array, logName: string, offset: number, count: number, period: number): RobotSignal[] {
  const w = parseWPILog(bytes, { arrays: true, keep: (_name, type) => type !== 'string' && type !== 'json' });
  const currents: RobotSignal[] = [];
  const others: RobotSignal[] = [];
  for (const [name, s] of w.series) {
    if (s.t.length < 2 || /^systemTime$/i.test(name)) continue;
    const motor = motorCurrent(name);
    const arr = resample(s, offset, count, period, motor ? 'peak' : 'mean');
    if (!arr.some((v) => !Number.isNaN(v))) continue; // nothing of it falls inside this match
    if (motor) currents.push({ log: logName, name, group: motor.group, short: motor.short, kind: 'current', label: motor.label, arr });
    else {
      const { group, short } = splitName(name);
      others.push({ log: logName, name, group, short, kind: 'other', arr });
    }
  }
  others.sort((a, b) => a.name.localeCompare(b.name));
  return [...currents, ...others].slice(0, MAX_SIGNALS);
}
