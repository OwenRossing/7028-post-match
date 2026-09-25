import { FLAG, ROBOT_MODE_MASK, type DSLog } from './dslog';
import { parseTracer, type DSEvent, type DSEventsFile } from './dsevents';
import { fmtDuration, fmtSpan } from './time';

export type Mode = 'disabled' | 'auto' | 'teleop' | 'test';

export interface Span {
  start: number;
  end: number;
}

export interface ModeSegment extends Span {
  mode: Mode;
}

export interface Run extends Span {
  autoStart?: number;
  autoEnd?: number;
  teleopStart?: number;
  teleopEnd?: number;
  autoTime: number;
  teleopTime: number;
  testTime: number;
  isMatch: boolean;
  label: string;
}

export interface ChannelStat {
  ch: number;
  avg: number;
  peak: number;
  peakT: number;
  /** Charge used, in amp-hours. */
  ah: number;
}

export interface Stats {
  span: Span;
  duration: number;
  enabledTime: number;
  autoTime: number;
  teleopTime: number;
  voltage: { min: number; minT: number; avg: number; resting: number; below7: number; below8: number };
  brownouts: { count: number; duration: number; firstT: number };
  comms: { drops: number; enabledDrops: number; dropTime: number; firstDropT: number; connectedTime: number };
  trip: { avg: number; p95: number; max: number; maxT: number };
  loss: { avg: number; max: number; maxT: number };
  cpu: { avg: number; max: number; maxT: number };
  can: { avg: number; max: number; maxT: number };
  wifi: { available: boolean; dbAvg: number; mbAvg: number };
  current: { available: boolean; peak: number; peakT: number; avg: number; ah: number };
  channels: ChannelStat[];
  watchdog: { count: number; duration: number; firstT: number };
  codeStalls: { count: number; enabledCount: number; duration: number; longest: number; longestT: number };
  events: { error: number; warning: number; print: number; ds: number; fms: number };
}

export type Severity = 'bad' | 'warn' | 'info';

export interface Problem {
  id: string;
  severity: Severity;
  title: string;
  /** What happened, in plain words. */
  detail: string;
  /** What to check or do about it before the next match. */
  fix?: string;
  /** Time to jump to when the problem is clicked. */
  t?: number;
  /** Chart that best shows the problem. */
  chart?: ChartId;
  /** Tag used to filter the events list. */
  tag?: string;
}

export type ChartId = 'voltage' | 'current' | 'comms' | 'cpu' | 'wifi' | 'channels';

export interface LoopCulprit {
  name: string;
  worst: number;
  count: number;
  framework: boolean;
}

export interface DeviceIssue {
  device: string;
  count: number;
  errors: number;
  firstT: number;
}

export interface Analysis {
  duration: number;
  modes: ModeSegment[];
  noComms: Span[];
  /** Connected, but the robot code did not report its mode (slow/stuck loop or code restarting). */
  codeStalls: Span[];
  brownouts: Span[];
  watchdog: Span[];
  runs: Run[];
  match?: Run;
  /** The interesting part of the log: the match, or the enabled/connected part. */
  focus: Span;
  title: string;
  loopCulprits: LoopCulprit[];
  canDevices: DeviceIssue[];
}

export function modeOf(f: number): Mode {
  if (f & FLAG.DS_DISABLED) return 'disabled';
  if (f & FLAG.DS_AUTO) return 'auto';
  if (f & FLAG.DS_TELEOP) return 'teleop';
  return 'test';
}

export function indexAt(log: DSLog, t: number): number {
  return Math.min(Math.max(Math.round(t / log.period), 0), Math.max(log.count - 1, 0));
}

function spansWhere(log: DSLog, pred: (i: number) => boolean): Span[] {
  const out: Span[] = [];
  let start = -1;
  for (let i = 0; i < log.count; i++) {
    const on = pred(i);
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push({ start: start * log.period, end: i * log.period });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start: start * log.period, end: log.count * log.period });
  return out;
}

function modeSegments(log: DSLog): ModeSegment[] {
  const out: ModeSegment[] = [];
  let cur: ModeSegment | null = null;
  for (let i = 0; i < log.count; i++) {
    const mode = modeOf(log.flags[i]);
    if (!cur || cur.mode !== mode) {
      if (cur) cur.end = i * log.period;
      cur = { start: i * log.period, end: (i + 1) * log.period, mode };
      out.push(cur);
    }
  }
  if (cur) cur.end = log.count * log.period;
  return out;
}

function fmsLabel(file: DSEventsFile | null): string | undefined {
  const fms = file?.meta.fms;
  if (!fms || fms.matchType === 'None' || !fms.matchNumber) return undefined;
  const type = fms.matchType.replace('Elimination', 'Playoff');
  return `${type} ${fms.matchNumber}${fms.replay > 1 ? ` (replay ${fms.replay})` : ''}`;
}

function buildRuns(modes: ModeSegment[], file: DSEventsFile | null): Run[] {
  const enabled = modes.filter((m) => m.mode !== 'disabled');
  const groups: ModeSegment[][] = [];
  for (const seg of enabled) {
    const last = groups[groups.length - 1];
    // Auto → teleop has a short disabled gap on the field; treat it as one run.
    if (last && seg.start - last[last.length - 1].end <= 5) last.push(seg);
    else groups.push([seg]);
  }
  const label = fmsLabel(file);
  let usedFmsLabel = false;
  return groups.map((g, idx) => {
    const run: Run = {
      start: g[0].start,
      end: g[g.length - 1].end,
      autoTime: 0,
      teleopTime: 0,
      testTime: 0,
      isMatch: false,
      label: '',
    };
    for (const s of g) {
      const d = s.end - s.start;
      if (s.mode === 'auto') {
        run.autoTime += d;
        run.autoStart ??= s.start;
        run.autoEnd = s.end;
      } else if (s.mode === 'teleop') {
        run.teleopTime += d;
        run.teleopStart ??= s.start;
        run.teleopEnd = s.end;
      } else run.testTime += d;
    }
    run.isMatch = run.autoTime >= 5 && run.teleopTime >= 20 && (run.autoStart ?? 0) < (run.teleopStart ?? 0);
    if (run.isMatch && label && !usedFmsLabel) {
      run.label = label;
      usedFmsLabel = true;
    } else if (run.isMatch) run.label = `Practice match ${idx + 1}`;
    else {
      const parts = [];
      if (run.autoTime) parts.push(`Auto ${fmtSpan(run.autoTime)}`);
      if (run.teleopTime) parts.push(`Teleop ${fmtSpan(run.teleopTime)}`);
      if (run.testTime) parts.push(`Test ${fmtSpan(run.testTime)}`);
      run.label = parts.join(' + ');
    }
    return run;
  });
}

const FRAMEWORK_EPOCH = /^(robotPeriodic|disabledPeriodic|autonomousPeriodic|teleopPeriodic|testPeriodic|simulationPeriodic|disabledInit|autonomousInit|teleopInit|testInit|robotInit|disabledExit|autonomousExit|teleopExit|testExit)\(\)$|^(LiveWindow|SmartDashboard|Shuffleboard)\./;

function loopCulprits(events: DSEvent[]): LoopCulprit[] {
  const map = new Map<string, LoopCulprit>();
  for (const e of events) {
    if (!e.tags.includes('tracer')) continue;
    const epochs = parseTracer(e.text);
    if (!epochs.length) continue;
    const [name, secs] = epochs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const c = map.get(name) ?? { name, worst: 0, count: 0, framework: FRAMEWORK_EPOCH.test(name) };
    c.count++;
    c.worst = Math.max(c.worst, secs);
    map.set(name, c);
  }
  return [...map.values()].sort((a, b) => Number(a.framework) - Number(b.framework) || b.worst - a.worst);
}

function deviceName(e: DSEvent): string | null {
  const loc = e.location ?? '';
  const m = /^((?:talon ?fx|talon ?srx|victor ?spx|pigeon ?2?|cancoder|candle|canrange|cANdi|spark ?(?:max|flex)?)[^"(]*?\d+)\s*(\("[^"]*"\))?/i.exec(loc);
  if (m) return `${m[1].trim()}${m[2] ? ' ' + m[2] : ''}`;
  const rev = /(SPARK(?: MAX| Flex)?|Spark(?:Max|Flex)?) ?\[?(\d+)\]?/i.exec(e.text);
  if (rev) return `${rev[1]} ${rev[2]}`;
  if (/phoenix6?::|ctre/i.test(loc)) return 'Phoenix (general)';
  return null;
}

function canDevices(events: DSEvent[]): DeviceIssue[] {
  const map = new Map<string, DeviceIssue>();
  for (const e of events) {
    if (!e.tags.includes('can') || (e.kind !== 'error' && e.kind !== 'warning')) continue;
    const dev = deviceName(e) ?? 'Unknown device';
    const d = map.get(dev) ?? { device: dev, count: 0, errors: 0, firstT: e.t };
    d.count++;
    if (e.level === 'error') d.errors++;
    map.set(dev, d);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function analyze(log: DSLog | null, file: DSEventsFile | null): Analysis {
  const events = file?.events ?? [];
  if (!log) {
    const duration = events.length ? events[events.length - 1].t : 0;
    return {
      duration,
      modes: [],
      noComms: [],
      codeStalls: [],
      brownouts: [],
      watchdog: [],
      runs: [],
      focus: { start: 0, end: duration },
      title: fmsLabel(file) ?? 'Events only',
      loopCulprits: loopCulprits(events),
      canDevices: canDevices(events),
    };
  }
  const duration = log.count * log.period;
  const modes = modeSegments(log);
  const noComms = spansWhere(log, (i) => !log.comms[i]);
  const codeStalls = spansWhere(log, (i) => log.comms[i] === 1 && (log.flags[i] & ROBOT_MODE_MASK) === 0);
  const brownouts = spansWhere(log, (i) => (log.flags[i] & FLAG.BROWNOUT) !== 0);
  const watchdog = spansWhere(log, (i) => log.comms[i] === 1 && (log.flags[i] & FLAG.WATCHDOG) !== 0);
  const runs = buildRuns(modes, file);
  const match = runs.find((r) => r.isMatch && r.label === fmsLabel(file)) ?? runs.find((r) => r.isMatch);

  let focus: Span;
  if (match) focus = { start: Math.max(0, match.start - 3), end: Math.min(duration, match.end + 3) };
  else if (runs.length) focus = { start: Math.max(0, runs[0].start - 5), end: Math.min(duration, runs[runs.length - 1].end + 5) };
  else {
    const connected = connectedSpan(log, noComms, duration);
    focus = connected ?? { start: 0, end: duration };
  }

  let title = match?.label ?? (runs.length ? 'Practice / testing' : 'Robot not enabled');
  if (!runs.length && noComms.length === 1 && noComms[0].start === 0 && noComms[0].end >= duration) title = 'No robot connection';

  return {
    duration,
    modes,
    noComms,
    codeStalls,
    brownouts,
    watchdog,
    runs,
    match,
    focus,
    title,
    loopCulprits: loopCulprits(events),
    canDevices: canDevices(events),
  };
}

function connectedSpan(log: DSLog, noComms: Span[], duration: number): Span | null {
  let start = 0;
  let end = duration;
  if (noComms.length && noComms[0].start === 0) start = noComms[0].end;
  const last = noComms[noComms.length - 1];
  if (last && last.end >= duration - log.period) end = last.start;
  return end > start ? { start, end } : null;
}

function overlap<T extends Span>(spans: T[], range: Span): T[] {
  return spans
    .filter((s) => s.end > range.start && s.start < range.end)
    .map((s) => ({ ...s, start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));
}

function sumSpans(spans: Span[]): number {
  return spans.reduce((a, s) => a + (s.end - s.start), 0);
}

export function computeStats(log: DSLog | null, file: DSEventsFile | null, analysis: Analysis, range: Span): Stats {
  const events = (file?.events ?? []).filter((e) => e.t >= range.start && e.t <= range.end);
  const evCounts = { error: 0, warning: 0, print: 0, ds: 0, fms: 0 };
  for (const e of events) evCounts[e.kind]++;

  const stats: Stats = {
    span: range,
    duration: range.end - range.start,
    enabledTime: 0,
    autoTime: 0,
    teleopTime: 0,
    voltage: { min: NaN, minT: NaN, avg: NaN, resting: NaN, below7: 0, below8: 0 },
    brownouts: { count: 0, duration: 0, firstT: NaN },
    comms: { drops: 0, enabledDrops: 0, dropTime: 0, firstDropT: NaN, connectedTime: 0 },
    trip: { avg: NaN, p95: NaN, max: NaN, maxT: NaN },
    loss: { avg: NaN, max: NaN, maxT: NaN },
    cpu: { avg: NaN, max: NaN, maxT: NaN },
    can: { avg: NaN, max: NaN, maxT: NaN },
    wifi: { available: false, dbAvg: NaN, mbAvg: NaN },
    current: { available: false, peak: NaN, peakT: NaN, avg: NaN, ah: 0 },
    channels: [],
    watchdog: { count: 0, duration: 0, firstT: NaN },
    codeStalls: { count: 0, enabledCount: 0, duration: 0, longest: 0, longestT: NaN },
    events: evCounts,
  };
  if (!log || !log.count) return stats;

  const i0 = indexAt(log, range.start);
  const i1 = Math.min(indexAt(log, range.end), log.count - 1);
  const dt = log.period;

  for (const seg of overlap(analysis.modes, range)) {
    const d = seg.end - seg.start;
    if (seg.mode === 'auto') stats.autoTime += d;
    if (seg.mode === 'teleop') stats.teleopTime += d;
    if (seg.mode !== 'disabled') stats.enabledTime += d;
  }

  const series = (arr: Float32Array) => {
    let sum = 0, n = 0, max = -Infinity, maxI = -1, min = Infinity, minI = -1;
    for (let i = i0; i <= i1; i++) {
      const v = arr[i];
      if (Number.isNaN(v)) continue;
      sum += v;
      n++;
      if (v > max) { max = v; maxI = i; }
      if (v < min) { min = v; minI = i; }
    }
    return { avg: n ? sum / n : NaN, max: n ? max : NaN, maxT: maxI * dt, min: n ? min : NaN, minT: minI * dt, n };
  };

  const v = series(log.voltage);
  stats.voltage.min = v.min;
  stats.voltage.minT = v.minT;
  stats.voltage.avg = v.avg;
  for (let i = i0; i <= i1; i++) {
    const x = log.voltage[i];
    if (x < 7) stats.voltage.below7 += dt;
    if (x < 8) stats.voltage.below8 += dt;
  }
  // Resting voltage: median of the 3 s before the first enable in range (or the first 3 s of data).
  const firstRun = analysis.runs.find((r) => r.end > range.start && r.start < range.end);
  const restEnd = firstRun ? indexAt(log, firstRun.start) : i0 + Math.round(3 / dt);
  const rest: number[] = [];
  for (let i = Math.max(0, restEnd - Math.round(3 / dt)); i < restEnd; i++) if (!Number.isNaN(log.voltage[i])) rest.push(log.voltage[i]);
  if (rest.length) {
    rest.sort((a, b) => a - b);
    stats.voltage.resting = rest[Math.floor(rest.length / 2)];
  }

  const bo = overlap(analysis.brownouts, range);
  stats.brownouts = { count: bo.length, duration: sumSpans(bo), firstT: bo[0]?.start ?? NaN };
  const wd = overlap(analysis.watchdog, range);
  stats.watchdog = { count: wd.length, duration: sumSpans(wd), firstT: wd[0]?.start ?? NaN };
  const stalls = overlap(analysis.codeStalls, range);
  const longest = stalls.reduce<Span | null>((a, s) => (!a || s.end - s.start > a.end - a.start ? s : a), null);
  stats.codeStalls = {
    count: stalls.length,
    enabledCount: stalls.filter((s) => modeOf(log.flags[indexAt(log, s.start)]) !== 'disabled').length,
    duration: sumSpans(stalls),
    longest: longest ? longest.end - longest.start : 0,
    longestT: longest?.start ?? NaN,
  };

  // A drop is comms going away after they were established. The robot being switched off at the end
  // of the log (while disabled) is not a drop. The DS logs "disabled" during a drop, so look at the
  // record just before it started.
  const isEnabledAt = (t: number) => modeOf(log.flags[Math.max(0, indexAt(log, t) - 1)]) !== 'disabled';
  const realDrops = overlap(
    analysis.noComms.filter((s) => s.start > 0 && (s.end < analysis.duration - dt || isEnabledAt(s.start))),
    range,
  );
  stats.comms.drops = realDrops.length;
  stats.comms.dropTime = sumSpans(realDrops);
  stats.comms.firstDropT = realDrops[0]?.start ?? NaN;
  stats.comms.enabledDrops = realDrops.filter((s) => isEnabledAt(s.start)).length;
  stats.comms.connectedTime = stats.duration - sumSpans(overlap(analysis.noComms, range));

  const trip = series(log.tripMs);
  const vals: number[] = [];
  for (let i = i0; i <= i1; i++) if (!Number.isNaN(log.tripMs[i])) vals.push(log.tripMs[i]);
  vals.sort((a, b) => a - b);
  stats.trip = { avg: trip.avg, max: trip.max, maxT: trip.maxT, p95: vals.length ? vals[Math.floor(vals.length * 0.95)] : NaN };
  const loss = series(log.packetLoss);
  stats.loss = { avg: loss.avg, max: loss.max, maxT: loss.maxT };
  const cpu = series(log.cpu);
  stats.cpu = { avg: cpu.avg, max: cpu.max, maxT: cpu.maxT };
  const can = series(log.can);
  stats.can = { avg: can.avg, max: can.max, maxT: can.maxT };
  const db = series(log.wifiDb);
  const mb = series(log.wifiMb);
  stats.wifi = { available: db.max > 0 || mb.max > 0, dbAvg: db.avg, mbAvg: mb.avg };

  if (log.channelCount) {
    const tot = series(log.totalCurrent);
    stats.current = { available: tot.n > 0, peak: tot.max, peakT: tot.maxT, avg: tot.avg, ah: (tot.avg * tot.n * dt) / 3600 || 0 };
    stats.channels = log.currents.map((arr, ch) => {
      const s = series(arr);
      return { ch, avg: s.avg, peak: s.max, peakT: s.maxT, ah: s.n ? (s.avg * s.n * dt) / 3600 : 0 };
    });
  }
  return stats;
}

function counterDelta<T>(samples: { t: number; value: T }[], key: keyof T, range?: Span) {
  const list = range ? samples.filter((s) => s.t <= range.end) : samples;
  if (!list.length) return { delta: 0, last: 0, firstT: NaN };
  const values = list.map((s) => Number(s.value[key]));
  const first = values[0];
  const last = values[values.length - 1];
  const idx = values.findIndex((v) => v > first);
  return { delta: last - first, last, firstT: idx >= 0 ? list[idx].t : NaN };
}

export const BROWNOUT_VOLTS = 6.8;

/** Finds the things a team should know about, most severe first. */
export function findProblems(
  log: DSLog | null,
  file: DSEventsFile | null,
  analysis: Analysis,
  stats: Stats,
): Problem[] {
  const out: Problem[] = [];
  const at = (t: number) => (Number.isFinite(t) ? ` at ${fmtDuration(t - (analysis.match?.start ?? 0), 1)}${analysis.match ? ' match time' : ''}` : '');
  const events = file?.events ?? [];
  const inRange = events.filter((e) => e.t >= stats.span.start && e.t <= stats.span.end);

  if (!log) out.push({ id: 'no-dslog', severity: 'info', title: 'No .dslog file', detail: 'Only messages are available. Add the matching .dslog to see graphs.' });
  if (!file) out.push({ id: 'no-events', severity: 'info', title: 'No .dsevents file', detail: 'Graphs only. Add the matching .dsevents file to see errors, prints and match info.' });

  if (log) {
    if (stats.brownouts.count > 0)
      out.push({
        id: 'brownout',
        severity: 'bad',
        title: `Brownout ×${stats.brownouts.count} (${fmtSpan(stats.brownouts.duration)} total)`,
        detail: `The roboRIO cut motor output because battery voltage fell below ~${BROWNOUT_VOLTS} V${at(stats.brownouts.firstT)}.`,
        fix: 'Swap in a fully charged battery. Then check the battery lead, Anderson connector and main breaker are tight, and look at the current graph for a mechanism stalling at that moment.',
        t: stats.brownouts.firstT,
        chart: 'voltage',
      });
    if (stats.voltage.min < 7)
      out.push({
        id: 'volt-low',
        severity: 'bad',
        title: `Battery dipped to ${stats.voltage.min.toFixed(2)} V`,
        detail: `Lowest voltage${at(stats.voltage.minT)}. Spent ${fmtSpan(stats.voltage.below7)} under 7 V, where brownouts start.`,
        fix: 'Use a fully charged battery and check the battery connections. The current graph shows what was pulling hardest at that moment.',
        t: stats.voltage.minT,
        chart: 'voltage',
      });
    else if (stats.voltage.min < 8)
      out.push({
        id: 'volt-sag',
        severity: 'warn',
        title: `Battery sagged to ${stats.voltage.min.toFixed(2)} V`,
        detail: `Lowest voltage${at(stats.voltage.minT)} (${fmtSpan(stats.voltage.below8)} under 8 V). Brownouts begin around ${BROWNOUT_VOLTS} V.`,
        fix: 'Start the next match on a freshly charged battery and keep an eye on current peaks.',
        t: stats.voltage.minT,
        chart: 'voltage',
      });
    if (analysis.runs.length && stats.voltage.resting < 12.3)
      out.push({
        id: 'volt-start',
        severity: stats.voltage.resting < 12 ? 'bad' : 'warn',
        title: `Started on a ${stats.voltage.resting.toFixed(2)} V battery`,
        detail: 'Resting voltage just before enabling. A fresh, fully charged battery reads about 12.8–13.2 V.',
        fix: 'Put a fully charged battery in before queueing, and check your charger rotation.',
        t: analysis.runs[0].start,
        chart: 'voltage',
      });
    if (stats.comms.enabledDrops > 0)
      out.push({
        id: 'comms-enabled',
        severity: 'bad',
        title: `Lost robot comms ${stats.comms.enabledDrops}× while enabled`,
        detail: `No packets from the robot for ${fmtSpan(stats.comms.dropTime)} total${at(stats.comms.firstDropT)}.`,
        fix: 'Check radio power (barrel jack / PoE) and the ethernet cable into the roboRIO. If a brownout or code crash happened at the same time, fix that first.',
        t: stats.comms.firstDropT,
        chart: 'comms',
        tag: 'comms',
      });
    else if (stats.comms.drops > 0)
      out.push({
        id: 'comms',
        severity: 'warn',
        title: `Lost robot comms ${stats.comms.drops}× while disabled`,
        detail: `Total ${fmtSpan(stats.comms.dropTime)}${at(stats.comms.firstDropT)}.`,
        fix: 'Harmless if someone rebooted or unplugged the robot. Otherwise check radio power and cables.',
        t: stats.comms.firstDropT,
        chart: 'comms',
        tag: 'comms',
      });
    if (stats.watchdog.count > 0)
      out.push({
        id: 'watchdog',
        severity: 'warn',
        title: `Watchdog tripped ${stats.watchdog.count}×`,
        detail: `Motor safety disabled outputs for ${fmtSpan(stats.watchdog.duration)}${at(stats.watchdog.firstT)}.`,
        fix: 'Usually slow code or lost comms. Look for loop overruns or comms drops at the same time.',
        t: stats.watchdog.firstT,
        chart: 'comms',
      });
    if (stats.codeStalls.enabledCount >= 3 || stats.codeStalls.longest >= 0.5)
      out.push({
        id: 'code-stall',
        severity: stats.codeStalls.longest >= 1 ? 'bad' : 'warn',
        title: `Robot code went unresponsive ${stats.codeStalls.count}× (longest ${fmtSpan(stats.codeStalls.longest)})`,
        detail: `The robot was connected but its code didn't report a mode for ${fmtSpan(stats.codeStalls.duration)} total${at(stats.codeStalls.longestT)} (longest gap).`,
        fix: 'Look for slow loops or blocking calls (Messages → loop overruns), or a code restart.',
        t: stats.codeStalls.longestT,
        chart: 'cpu',
        tag: 'loop',
      });
    if (stats.trip.p95 > 25 || stats.loss.avg > 5)
      out.push({
        id: 'network',
        severity: 'warn',
        title: `Laggy network (trip p95 ${stats.trip.p95.toFixed(1)} ms, loss avg ${stats.loss.avg.toFixed(1)}%)`,
        detail: 'Round-trip time or packet loss between DS and robot was high.',
        fix: 'Check radio placement, camera stream bandwidth, and interference.',
        t: stats.trip.maxT,
        chart: 'comms',
      });
    if (stats.can.max >= 90 || stats.can.avg >= 70)
      out.push({
        id: 'can-util',
        severity: 'warn',
        title: `CAN bus busy (peak ${stats.can.max.toFixed(0)}%, avg ${stats.can.avg.toFixed(0)}%)`,
        detail: 'High utilization of the roboRIO CAN bus can cause stale or missed frames.',
        fix: 'Lower status frame rates or move devices to a CANivore.',
        t: stats.can.maxT,
        chart: 'cpu',
      });
    if (stats.cpu.avg >= 85)
      out.push({
        id: 'cpu',
        severity: 'warn',
        title: `roboRIO CPU averaged ${stats.cpu.avg.toFixed(0)}%`,
        detail: 'Very high CPU makes loop overruns and lag more likely.',
        fix: 'Look for heavy logging, NetworkTables spam or busy loops.',
        t: stats.cpu.maxT,
        chart: 'cpu',
      });
  }

  if (file) {
    const meta = file.meta;
    const rails: [keyof EventsRail, string][] = [['v12', '12V'], ['v5', '5V'], ['v3_3', '3.3V']];
    for (const [key, name] of rails) {
      const d = counterDelta(meta.railFaults, key);
      if (d.delta > 0)
        out.push({
          id: `rail-${key}`,
          severity: 'bad',
          title: `roboRIO ${name} rail faulted ${d.delta}×`,
          detail: `The roboRIO's ${name} output shut off due to a short or overload${at(d.firstT)}.`,
          fix: 'Check devices powered from the roboRIO (encoders, sensors, LEDs) and their wiring for a short.',
          t: d.firstT,
          tag: 'rail',
        });
      else if (d.last > 0)
        out.push({ id: `rail-${key}`, severity: 'info', title: `roboRIO reports ${d.last} ${name} rail faults since boot`, detail: 'None happened during this log.', tag: 'rail' });
    }
    const bo = counterDelta(meta.powerCounters, 'brownouts');
    if (bo.delta > 0 && !out.some((p) => p.id === 'brownout'))
      out.push({
        id: 'brownout-counter',
        severity: 'bad',
        title: `roboRIO counted ${bo.delta} new brownout(s)`,
        detail: `Reported by the roboRIO${at(bo.firstT)}.`,
        fix: 'Swap in a fully charged battery and check the battery lead, Anderson connector and main breaker.',
        t: bo.firstT,
        chart: 'voltage',
      });
    else if (bo.last > 0 && !out.some((p) => p.id === 'brownout'))
      out.push({ id: 'brownout-counter', severity: 'info', title: `roboRIO reports ${bo.last} brownout(s) since boot`, detail: 'None were flagged during this log, so they happened earlier (maybe a previous match).' });

    const crashes = inRange.filter((e) => e.tags.includes('crash'));
    if (crashes.length)
      out.push({
        id: 'crash',
        severity: 'bad',
        title: 'Robot code crashed or restarted',
        detail: crashes[0].text.split('\n')[0].slice(0, 200),
        fix: 'Open the crash message for the stack trace. Fix or guard that code, and redeploy before queueing.',
        t: crashes[0].t,
        tag: 'crash',
      });

    const errors = inRange.filter((e) => e.kind === 'error');
    if (errors.length) {
      const groups = new Map<string, DSEvent[]>();
      errors.forEach((e) => groups.set(e.sig, [...(groups.get(e.sig) ?? []), e]));
      const top = [...groups.values()].sort((a, b) => b.length - a.length)[0];
      out.push({
        id: 'errors',
        severity: 'warn',
        title: `${errors.length} error message${errors.length === 1 ? '' : 's'} (${groups.size} unique)`,
        detail: `Most common (×${top.length}): ${top[0].text.split('\n')[0].slice(0, 160)}`,
        fix: 'Open Messages to see where they come from.',
        t: errors[0].t,
        tag: 'error',
      });
    }

    const overruns = inRange.filter((e) => e.tags.includes('loop') && !e.tags.includes('tracer') && e.kind !== 'print');
    if (overruns.length >= 3) {
      const culprit = analysis.loopCulprits.find((c) => !c.framework) ?? analysis.loopCulprits[0];
      out.push({
        id: 'loop',
        severity: 'warn',
        title: `Loop overran ${overruns.length}×`,
        detail: `Robot code took longer than its 20 ms loop.${culprit ? ` Slowest step seen: ${culprit.name} at ${(culprit.worst * 1000).toFixed(1)} ms.` : ''}`,
        fix: 'Speed up the slowest step, or move slow work (file I/O, vision, prints) off the main loop.',
        t: overruns[0].t,
        tag: 'loop',
      });
    }

    if (analysis.canDevices.length) {
      const total = analysis.canDevices.reduce((a, d) => a + d.count, 0);
      out.push({
        id: 'can-devices',
        severity: 'warn',
        title: `${total} CAN device message${total === 1 ? '' : 's'}`,
        detail: `From ${analysis.canDevices.slice(0, 4).map((d) => `${d.device} (×${d.count})`).join(', ')}${analysis.canDevices.length > 4 ? '…' : ''}.`,
        fix: 'Check CAN wiring, termination and power to those devices.',
        t: analysis.canDevices[0].firstT,
        tag: 'can',
      });
    }

    const ntDrops = new Map<string, number>();
    for (const e of inRange) {
      const m = /NT: DISCONNECTED NT4 client '([^'@]+)/.exec(e.text);
      if (m) ntDrops.set(m[1], (ntDrops.get(m[1]) ?? 0) + 1);
    }
    if (ntDrops.size)
      out.push({
        id: 'nt',
        severity: 'info',
        title: `NetworkTables clients dropped (${[...ntDrops.values()].reduce((a, b) => a + b, 0)}×)`,
        detail: [...ntDrops].map(([n, c]) => `${n} ×${c}`).join(', ') + '.',
        fix: 'Coprocessors or cameras reconnecting usually means power or network trouble. Check their power and cables.',
        tag: 'nt',
      });

    const radio = events.find((e) => /Please update Radio firmware/i.test(e.text));
    if (radio) {
      const version = /Radio Version:\s*(\S+?)(?:FRC:|\s|$)/.exec(radio.text)?.[1];
      out.push({
        id: 'radio-fw',
        severity: 'warn',
        title: 'Radio firmware is out of date',
        detail: `The Driver Station asked for a radio firmware update${version ? ` (radio reports ${version})` : ''}.`,
        fix: 'Update the radio firmware before the next event (not between matches).',
        tag: 'ds',
      });
    }

    const mem = meta.rioStats.map((s) => s.value.memMB).filter((m) => m > 0);
    if (mem.length && Math.min(...mem) < 50)
      out.push({
        id: 'rio-mem',
        severity: 'warn',
        title: `roboRIO memory low (${Math.min(...mem)} MB free)`,
        detail: 'Low memory can slow or crash robot code.',
        fix: 'Reduce logging or large buffers, or reboot the roboRIO.',
      });
    const batt = meta.rioStats.map((s) => s.value.laptopBatt).filter((b) => b > 0);
    if (batt.length && Math.min(...batt) < 25)
      out.push({
        id: 'laptop-batt',
        severity: 'warn',
        title: `DS laptop battery at ${Math.min(...batt)}%`,
        detail: 'Low power modes on the laptop can cause lag.',
        fix: 'Plug the driver station laptop in.',
      });
  }

  // Most severe first; within a severity, what most likely cost the match comes first.
  const order: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };
  const urgency = [
    'brownout', 'brownout-counter', 'crash', 'comms-enabled', 'rail-v12', 'rail-v5', 'rail-v3_3', 'code-stall',
    'volt-low', 'volt-start', 'watchdog', 'loop', 'can-devices', 'errors', 'volt-sag', 'comms', 'network',
    'can-util', 'cpu', 'rio-mem', 'laptop-batt', 'radio-fw',
  ];
  const rank = (p: Problem) => {
    const i = urgency.indexOf(p.id);
    return i < 0 ? urgency.length : i;
  };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || rank(a) - rank(b));
}

type EventsRail = { v12: number; v5: number; v3_3: number };

export function verdictOf(problems: Problem[]): 'ok' | 'warn' | 'bad' {
  if (problems.some((p) => p.severity === 'bad')) return 'bad';
  if (problems.some((p) => p.severity === 'warn')) return 'warn';
  return 'ok';
}

/** Compact per-log summary used by the library list. */
export interface LogSummary {
  startTime: number;
  duration: number;
  title: string;
  eventName?: string;
  matchType?: string;
  matchNumber?: number;
  isMatch: boolean;
  fms: boolean;
  team?: number;
  enabledTime: number;
  minVoltage: number;
  brownouts: number;
  commsDrops: number;
  errors: number;
  verdict: 'ok' | 'warn' | 'bad';
  problemCount: number;
  hasDslog: boolean;
  hasEvents: boolean;
}

export function summarize(log: DSLog | null, file: DSEventsFile | null): LogSummary {
  const analysis = analyze(log, file);
  const stats = computeStats(log, file, analysis, analysis.focus);
  const problems = findProblems(log, file, analysis, stats);
  const fms = file?.meta.fms;
  return {
    startTime: log?.startTime ?? file?.startTime ?? 0,
    duration: analysis.duration,
    title: analysis.title,
    eventName: file?.meta.eventName,
    matchType: fms?.matchType,
    matchNumber: fms?.matchNumber,
    isMatch: !!analysis.match,
    fms: !!fms && fms.matchType !== 'None',
    team: file?.meta.team,
    enabledTime: analysis.runs.reduce((a, r) => a + r.autoTime + r.teleopTime + r.testTime, 0),
    minVoltage: stats.voltage.min,
    brownouts: stats.brownouts.count,
    commsDrops: stats.comms.enabledDrops,
    errors: stats.events.error,
    verdict: verdictOf(problems),
    problemCount: problems.filter((p) => p.severity !== 'info').length,
    hasDslog: !!log,
    hasEvents: !!file,
  };
}
