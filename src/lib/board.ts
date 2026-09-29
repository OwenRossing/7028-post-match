// The match board: every number worth knowing about one match, as six columns of rows that can nest.
// Rows with a `better` direction are also saved per match (see boardMetrics) so later matches can be
// compared against the robot's own history (see baseline.ts).

import { computeStats, indexAt, modeOf, type Analysis, type Span, type Stats } from './analysis';
import type { DSLog } from './dslog';
import { parseTracer, type DSEvent, type DSEventsFile, type EventKind } from './dsevents';

export type ColumnId = 'power' | 'network' | 'rio' | 'code' | 'devices' | 'performance';

/** Which way is worse. Rows without one are not compared against history. */
export type Better = 'lower' | 'higher' | 'either';

export type Signal = 'voltage' | 'total' | 'channel' | 'loss' | 'trip' | 'cpu' | 'can';
export type SpanKind = 'brownouts' | 'noComms' | 'stalls';

/** What the inspector draws over the match for a row. */
export type Trace =
  { kind: 'series'; signal: Signal; ch?: number; spans?: SpanKind; threshold?: number } | { kind: 'events' } | { kind: 'points' };

export interface Instance {
  t: number;
  end?: number;
  value?: number;
  label?: string;
}

export interface Row {
  /** Stable across matches: also the metric key. */
  id: string;
  label: string;
  /** Power distribution channel; its team-given name replaces the label. */
  ch?: number;
  sub?: string;
  /** NaN for group headers without a number of their own. */
  value: number;
  unit: string;
  digits: number;
  /** A time this row points at (an instance row, or the moment of a peak). */
  at?: number;
  better?: Better;
  /** Smallest standard deviation used when judging against history, in the row's unit. */
  noise?: number;
  /** A match that never logged this row counts as 0 (message counts, per-device counts). */
  zeroIfMissing?: boolean;
  /** Hidden unless something makes it interesting (a channel that drew nothing). */
  quiet?: boolean;
  /** Findings (analysis.findProblems ids) that this row shows. */
  problems?: string[];
  children?: Row[];
  instances?: Instance[];
  /** Related messages, by event id. */
  eventIds?: number[];
  /** How to find this row's messages in the Messages list. */
  filter?: { tag?: string; kind?: EventKind; text?: string };
  trace?: Trace;
  /** One line on what the number means. */
  hint?: string;
}

export interface Column {
  id: ColumnId;
  title: string;
  rows: Row[];
}

export interface Board {
  columns: Column[];
  range: Span;
}

const count = (id: string, label: string, n: number, extra: Partial<Row> = {}): Row => ({
  id,
  label,
  value: n,
  unit: '',
  digits: 0,
  better: 'lower',
  noise: 1,
  zeroIfMissing: true,
  ...extra,
});

const secs = (id: string, label: string, s: number, extra: Partial<Row> = {}): Row => ({
  id,
  label,
  value: s,
  unit: 's',
  digits: 1,
  better: 'lower',
  noise: 0.5,
  zeroIfMissing: true,
  ...extra,
});

const spanRows = (prefix: string, spans: Span[]): Row[] =>
  spans.map((s, i) => ({ id: `${prefix}.i${i}`, label: 'At', value: s.end - s.start, unit: 's', digits: 1, at: s.start }));

/** Short, stable id for free text (message signatures, step names, device names). */
export function slug(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function overlapping(spans: Span[], range: Span): Span[] {
  return spans
    .filter((s) => s.end > range.start && s.start < range.end)
    .map((s) => ({ start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));
}

const total = (spans: Span[]) => spans.reduce((a, s) => a + s.end - s.start, 0);

// ---------- Messages ----------

const METRIC_RE = /^\[(?:pv|metric)\]\s*(.+?)\s*[=:]\s*(-?\d+(?:\.\d+)?)\s*([^\s\d][^\s]*)?\s*$/i;
const UNPLUGGED_RE = /Joystick (?:Button|Axis|POV) \d+ on port (\d+) not available/i;

export function isMetricPrint(e: DSEvent): boolean {
  return e.kind === 'print' && METRIC_RE.test(e.text);
}

function isOverrun(e: DSEvent) {
  return e.tags.includes('loop') && !isTracer(e);
}

/** WPILib's Tracer output (per-step timings), as a tagged tracer print or a warning logged from Tracer. */
function isTracer(e: DSEvent) {
  return e.tags.includes('tracer') || /\bTracer\./.test(e.location ?? '');
}

function firstLine(text: string) {
  return text.split('\n')[0].trim();
}

/** The part of a location worth showing: "IterativeRobotBase.printLoopOverrunMessage". */
function shortLocation(loc?: string): string | undefined {
  if (!loc) return undefined;
  const m = /([\w$]+\.[\w$<>]+)\(/.exec(loc);
  if (m) return m[1];
  return loc.length > 48 ? loc.slice(0, 47) + '…' : loc;
}

/** Groups messages that repeat into one row each, most frequent first. */
function messageRows(prefix: string, events: DSEvent[]): Row[] {
  const groups = new Map<string, DSEvent[]>();
  for (const e of events) groups.set(e.sig, [...(groups.get(e.sig) ?? []), e]);
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([sig, list]) =>
      count(`${prefix}.${slug(sig)}`, firstLine(list[0].text).slice(0, 140) || '(empty message)', list.length, {
        sub: shortLocation(list[0].location),
        at: list[0].t,
        filter: { text: firstLine(list[0].text).slice(0, 60) },
        eventIds: list.map((e) => e.id),
        instances: list.map((e) => ({ t: e.t })),
        trace: { kind: 'events' },
      }),
    );
}

// ---------- CAN devices ----------

const MODELS: [RegExp, string][] = [
  [/^talon ?fxs?/i, 'Talon FX'],
  [/^talon ?srx/i, 'Talon SRX'],
  [/^victor ?spx/i, 'Victor SPX'],
  [/^pigeon ?2/i, 'Pigeon 2'],
  [/^pigeon/i, 'Pigeon'],
  [/^cancoder/i, 'CANcoder'],
  [/^candle/i, 'CANdle'],
  [/^canrange/i, 'CANrange'],
  [/^candi/i, 'CANdi'],
  [/^spark ?max/i, 'SPARK MAX'],
  [/^spark ?flex/i, 'SPARK Flex'],
];

export interface Device {
  key: string;
  name: string;
  bus?: string;
  signal?: string;
}

/** Which CAN device a message is about ("talon fx 5 ("canivore") Status Signal Velocity" → Talon FX 5). */
export function deviceOf(e: DSEvent): Device | null {
  const loc = (e.location ?? '').trim();
  for (const [re, model] of MODELS) {
    const m = re.exec(loc);
    if (!m) continue;
    const rest = loc.slice(m[0].length);
    const id = /^\s*(\d+)/.exec(rest)?.[1];
    const bus = /\("([^"]*)"\)/.exec(rest)?.[1];
    const signal = /Status Signal (\w+)/.exec(rest)?.[1];
    const name = `${model}${id !== undefined ? ` ${id}` : ''}`;
    return { key: `${name}@${bus ?? 'rio'}`, name, bus, signal };
  }
  const rev = /\b(SPARK ?(?:MAX|Flex)?)\b[^\d\n]{0,16}(\d+)/i.exec(e.text);
  if (rev) {
    const model = /flex/i.test(rev[1]) ? 'SPARK Flex' : 'SPARK MAX';
    return { key: `${model} ${rev[2]}@rio`, name: `${model} ${rev[2]}` };
  }
  if (/phoenix6?::|ctre|\[phoenix\]/i.test(`${loc} ${e.text}`))
    return { key: 'phoenix@', name: 'Phoenix (no device)', signal: /::(\w+)$/.exec(loc)?.[1] };
  return null;
}

function deviceRows(prefix: string, events: DSEvent[]): Row[] {
  const map = new Map<string, { dev: Device; list: DSEvent[]; signals: Set<string> }>();
  for (const e of events) {
    const dev = deviceOf(e) ?? { key: 'other@', name: 'Other CAN' };
    const g = map.get(dev.key) ?? { dev, list: [], signals: new Set<string>() };
    g.list.push(e);
    if (dev.signal) g.signals.add(dev.signal);
    map.set(dev.key, g);
  }
  return [...map.values()]
    .sort((a, b) => b.list.length - a.list.length)
    .map(({ dev, list, signals }) =>
      count(`${prefix}.${slug(dev.key)}`, dev.name, list.length, {
        sub: [dev.bus, [...signals].join(', ')].filter(Boolean).join(' · ') || undefined,
        at: list[0].t,
        filter: { tag: 'can', text: (list[0].location ?? '').split(' Status Signal')[0] || undefined },
        eventIds: list.map((e) => e.id),
        instances: list.map((e) => ({ t: e.t })),
        trace: { kind: 'events' },
      }),
    );
}

// ---------- Columns ----------

function powerColumn(log: DSLog | null, analysis: Analysis, stats: Stats, range: Span): Row[] {
  if (!log) return [];
  const rows: Row[] = [];
  if (stats.current.available) {
    const chans = stats.channels.filter((c) => Number.isFinite(c.avg));
    rows.push(
      {
        id: 'power.consumption',
        label: 'Consumption',
        value: stats.current.ah * 1000,
        unit: 'mAh',
        digits: 0,
        better: 'lower',
        noise: 60,
        trace: { kind: 'series', signal: 'total' },
        hint: 'Charge drawn from the battery, per power distribution channel.',
        children: [...chans]
          .sort((a, b) => b.ah - a.ah)
          .map((c) => ({
            id: `power.consumption.ch${c.ch}`,
            label: `Ch ${c.ch}`,
            ch: c.ch,
            value: c.ah * 1000,
            unit: 'mAh',
            digits: 0,
            better: 'either' as const,
            noise: 15,
            quiet: c.peak < 1,
            trace: { kind: 'series' as const, signal: 'channel' as const, ch: c.ch },
          })),
      },
      {
        id: 'power.peak',
        label: 'Peak draw',
        value: stats.current.peak,
        unit: 'A',
        digits: 0,
        at: stats.current.peakT,
        better: 'lower',
        noise: 10,
        trace: { kind: 'series', signal: 'total' },
        hint: 'Highest total current, and each channel’s own highest.',
        children: [...chans]
          .sort((a, b) => b.peak - a.peak)
          .map((c) => ({
            id: `power.peak.ch${c.ch}`,
            label: `Ch ${c.ch}`,
            ch: c.ch,
            value: c.peak,
            unit: 'A',
            digits: 0,
            at: c.peakT,
            better: 'either' as const,
            noise: 4,
            quiet: c.peak < 1,
            trace: { kind: 'series' as const, signal: 'channel' as const, ch: c.ch },
          })),
      },
    );
  }
  rows.push({
    id: 'power.minVoltage',
    label: 'Min voltage',
    value: stats.voltage.min,
    unit: 'V',
    digits: 2,
    at: stats.voltage.minT,
    better: 'higher',
    noise: 0.15,
    problems: ['volt-low', 'volt-sag'],
    trace: { kind: 'series', signal: 'voltage', spans: 'brownouts', threshold: 7 },
    hint: 'Lowest battery voltage. Brownouts start around 6.8 V.',
    children: [
      {
        id: 'power.minVoltage.resting',
        label: 'Starting battery',
        value: stats.voltage.resting,
        unit: 'V',
        digits: 2,
        better: 'higher',
        noise: 0.1,
        problems: ['volt-start'],
        trace: { kind: 'series', signal: 'voltage' },
        hint: 'Resting voltage just before enabling. A fresh battery reads 12.8–13.2 V.',
      },
      secs('power.minVoltage.below8', 'Time under 8 V', stats.voltage.below8, {
        trace: { kind: 'series', signal: 'voltage', threshold: 8 },
      }),
    ],
  });
  const bo = overlapping(analysis.brownouts, range);
  rows.push(
    count('power.brownouts', 'Brownouts', bo.length, {
      problems: ['brownout', 'brownout-counter'],
      instances: bo.map((s) => ({ t: s.start, end: s.end, value: s.end - s.start })),
      trace: { kind: 'series', signal: 'voltage', spans: 'brownouts', threshold: 6.8 },
      hint: 'The roboRIO cut motor output because voltage fell too low.',
      children: [secs('power.brownouts.seconds', 'Seconds', total(bo)), ...spanRows('power.brownouts', bo)],
    }),
  );
  return rows;
}

function commsDrops(log: DSLog, analysis: Analysis, range: Span) {
  // Same rule as computeStats: switching the robot off at the end of the log is not a drop.
  const dt = log.period;
  const enabledAt = (t: number) => modeOf(log.flags[Math.max(0, indexAt(log, t) - 1)]) !== 'disabled';
  const real = analysis.noComms.filter((s) => s.start > 0 && (s.end < analysis.duration - dt || enabledAt(s.start)));
  return overlapping(real, range).map((s) => ({ ...s, enabled: enabledAt(s.start) }));
}

function networkColumn(
  log: DSLog | null,
  file: DSEventsFile | null,
  analysis: Analysis,
  stats: Stats,
  range: Span,
  inRange: DSEvent[],
): Row[] {
  const rows: Row[] = [];
  if (log) {
    const i0 = indexAt(log, range.start);
    const i1 = indexAt(log, range.end);
    let lost = 0;
    for (let i = i0; i <= i1; i++) if (!Number.isNaN(log.packetLoss[i])) lost += log.packetLoss[i] / 100;
    rows.push({
      id: 'network.packetsLost',
      label: 'Packets lost',
      value: Math.round(lost),
      unit: '',
      digits: 0,
      better: 'lower',
      noise: 10,
      zeroIfMissing: true,
      problems: ['network'],
      trace: { kind: 'series', signal: 'loss' },
      hint: 'Estimated DS packets that got no answer (one packet every 20 ms).',
      children: [
        {
          id: 'network.packetsLost.avg',
          label: 'Average loss',
          value: stats.loss.avg,
          unit: '%',
          digits: 1,
          better: 'lower',
          noise: 1,
          trace: { kind: 'series', signal: 'loss' },
        },
        {
          id: 'network.packetsLost.max',
          label: 'Worst loss',
          value: stats.loss.max,
          unit: '%',
          digits: 0,
          at: stats.loss.maxT,
          better: 'lower',
          noise: 4,
          trace: { kind: 'series', signal: 'loss' },
        },
        {
          id: 'network.trip.avg',
          label: 'Trip time',
          value: stats.trip.avg,
          unit: 'ms',
          digits: 1,
          better: 'lower',
          noise: 1,
          trace: { kind: 'series', signal: 'trip' },
        },
        {
          id: 'network.trip.p95',
          label: 'Trip time p95',
          value: stats.trip.p95,
          unit: 'ms',
          digits: 1,
          better: 'lower',
          noise: 2,
          at: stats.trip.maxT,
          trace: { kind: 'series', signal: 'trip' },
        },
      ],
    });
  }

  if (file) {
    // The field disconnecting mid-match (not the normal disconnect after the match ends).
    const window = analysis.match ?? range;
    const fms: Span[] = [];
    const evs = file.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (!/^FMS Disconnect/i.test(e.text) || e.t < window.start || e.t > window.end) continue;
      const back = evs.slice(i + 1).find((x) => /^FMS Connected/i.test(x.text));
      fms.push({ start: e.t, end: Math.min(back?.t ?? window.end, window.end) });
    }
    rows.push(
      count('network.fmsDrops', 'FMS drops', fms.length, {
        instances: fms.map((s) => ({ t: s.start, end: s.end, value: s.end - s.start })),
        trace: log ? { kind: 'series', signal: 'trip', spans: 'noComms' } : { kind: 'events' },
        hint: 'The field connection dropped during the match.',
        children: [secs('network.fmsDrops.seconds', 'Seconds', total(fms)), ...spanRows('network.fmsDrops', fms)],
      }),
    );
  }

  if (log) {
    const drops = commsDrops(log, analysis, range);
    rows.push(
      count('network.dsDrops', 'DS drops', drops.length, {
        problems: ['comms-enabled', 'comms'],
        instances: drops.map((s) => ({ t: s.start, end: s.end, value: s.end - s.start, label: s.enabled ? 'enabled' : 'disabled' })),
        trace: { kind: 'series', signal: 'trip', spans: 'noComms' },
        hint: 'The Driver Station heard nothing from the robot.',
        children: [
          secs('network.dsDrops.seconds', 'Seconds', total(drops)),
          ...drops.map((s, i) => ({
            id: `network.dsDrops.i${i}`,
            label: 'At',
            sub: s.enabled ? 'enabled' : undefined,
            value: s.end - s.start,
            unit: 's',
            digits: 1,
            at: s.start,
          })),
        ],
      }),
    );
  }

  if (file) {
    const perPort = new Map<number, DSEvent[]>();
    for (const e of inRange) {
      const m = UNPLUGGED_RE.exec(e.text);
      if (m) perPort.set(+m[1], [...(perPort.get(+m[1]) ?? []), e]);
    }
    const ports = new Set<number>([
      ...file.meta.joysticks.filter((j) => j.axes + j.buttons + j.povs > 0).map((j) => j.slot),
      ...perPort.keys(),
    ]);
    const all = [...perPort.values()].flat().sort((a, b) => a.t - b.t);
    rows.push(
      count('network.controllerDrops', 'Controller drops', all.length, {
        eventIds: all.map((e) => e.id),
        instances: all.map((e) => ({ t: e.t })),
        filter: { text: 'not available, check if controller' },
        trace: { kind: 'events' },
        hint: 'Robot code asked for a controller input that was not there (unplugged, or wrong port).',
        children: [...ports]
          .sort((a, b) => a - b)
          .map((p) => {
            const list = perPort.get(p) ?? [];
            return count(`network.controllerDrops.p${p}`, `Port ${p}`, list.length, {
              sub: file.meta.joysticks.find((j) => j.slot === p)?.name,
              eventIds: list.map((e) => e.id),
              instances: list.map((e) => ({ t: e.t })),
              trace: { kind: 'events' },
              filter: { text: `on port ${p} not available` },
            });
          }),
      }),
    );
  }
  return rows;
}

function rioColumn(log: DSLog | null, file: DSEventsFile | null, analysis: Analysis, stats: Stats, range: Span): Row[] {
  const rows: Row[] = [];
  if (file) {
    const rails: ['v12' | 'v5' | 'v3_3', string][] = [
      ['v12', '12 V'],
      ['v5', '5 V'],
      ['v3_3', '3.3 V'],
    ];
    const faults: Instance[] = [];
    const samples = file.meta.railFaults;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (s.t < range.start || s.t > range.end) continue;
      for (const [k, name] of rails) {
        const d = s.value[k] - samples[i - 1].value[k];
        if (d > 0) faults.push({ t: s.t, value: d, label: name });
      }
    }
    const n = faults.reduce((a, f) => a + (f.value ?? 0), 0);
    rows.push(
      count('rio.faults', 'RIO faults', n, {
        problems: ['rail-v12', 'rail-v5', 'rail-v3_3'],
        filter: { tag: 'rail' },
        instances: faults,
        trace: log ? { kind: 'series', signal: 'voltage' } : { kind: 'events' },
        hint: 'The roboRIO shut off its 12 V / 5 V / 3.3 V output (a short or overload on something it powers).',
        children: faults.map((f, i) => ({
          id: `rio.faults.i${i}`,
          label: 'At',
          sub: `${f.label} rail`,
          value: f.value ?? 1,
          unit: '',
          digits: 0,
          at: f.t,
        })),
      }),
    );

    // A reboot: comms gone for a while, then the robot program starting up again.
    const starts = file.events.filter((e) => e.tags.includes('startup') || /No robot code is currently running/i.test(e.text));
    const reboots = log
      ? analysis.noComms.filter(
          (s) =>
            s.start > 0 &&
            s.end - s.start >= 8 &&
            s.start >= range.start - 60 &&
            s.start <= range.end &&
            starts.some((e) => e.t >= s.start && e.t <= s.end + 90),
        )
      : [];
    rows.push(
      count('rio.reboots', 'RIO reboots', reboots.length, {
        instances: reboots.map((s) => ({ t: s.start, end: s.end, value: s.end - s.start })),
        trace: log ? { kind: 'series', signal: 'voltage', spans: 'noComms' } : { kind: 'events' },
        hint: 'Comms went away and the robot program started up again afterwards.',
        children: reboots.map((s, i) => ({
          id: `rio.reboots.i${i}`,
          label: 'At',
          value: s.end - s.start,
          unit: 's',
          digits: 0,
          at: s.start,
        })),
      }),
    );
  }
  if (log) {
    rows.push(
      {
        id: 'rio.cpu',
        label: 'CPU',
        value: stats.cpu.avg,
        unit: '%',
        digits: 0,
        better: 'lower',
        noise: 3,
        problems: ['cpu'],
        trace: { kind: 'series', signal: 'cpu' },
        children: [
          {
            id: 'rio.cpu.max',
            label: 'Peak',
            value: stats.cpu.max,
            unit: '%',
            digits: 0,
            at: stats.cpu.maxT,
            better: 'lower',
            noise: 4,
            trace: { kind: 'series', signal: 'cpu' },
          },
        ],
      },
      {
        id: 'rio.can',
        label: 'CAN bus',
        value: stats.can.avg,
        unit: '%',
        digits: 0,
        better: 'lower',
        noise: 3,
        problems: ['can-util'],
        trace: { kind: 'series', signal: 'can' },
        hint: 'Utilization of the roboRIO CAN bus (not a CANivore).',
        children: [
          {
            id: 'rio.can.max',
            label: 'Peak',
            value: stats.can.max,
            unit: '%',
            digits: 0,
            at: stats.can.maxT,
            better: 'lower',
            noise: 4,
            trace: { kind: 'series', signal: 'can' },
          },
        ],
      },
    );
  }
  const mem = (file?.meta.rioStats ?? []).filter((s) => s.t >= range.start - 30 && s.t <= range.end + 30 && s.value.memMB > 0);
  if (mem.length) {
    const low = mem.reduce((a, s) => (s.value.memMB < a.value.memMB ? s : a));
    rows.push({
      id: 'rio.memory',
      label: 'Memory free',
      value: low.value.memMB,
      unit: 'MB',
      digits: 0,
      at: low.t,
      better: 'higher',
      noise: 5,
      problems: ['rio-mem'],
      instances: mem.map((s) => ({ t: s.t, value: s.value.memMB })),
      trace: { kind: 'points' },
    });
  }
  return rows;
}

function codeColumn(
  log: DSLog | null,
  file: DSEventsFile | null,
  analysis: Analysis,
  stats: Stats,
  range: Span,
  inRange: DSEvent[],
): Row[] {
  if (!file) return [];
  const rows: Row[] = [];
  const notDevice = (e: DSEvent) => !e.tags.includes('can');
  const errors = inRange.filter((e) => e.kind === 'error' && notDevice(e));
  const warnings = inRange.filter(
    (e) => e.kind === 'warning' && notDevice(e) && !isOverrun(e) && !isTracer(e) && !UNPLUGGED_RE.test(e.text),
  );
  // Java also prints overrun warnings and tracer lines to stdout; those are counted under Loop overruns.
  const prints = inRange.filter((e) => e.kind === 'print' && !e.tags.includes('loop') && !isMetricPrint(e));
  const overruns = inRange.filter((e) => isOverrun(e) && e.kind !== 'print');

  rows.push(
    count('code.errors', 'Errors', errors.length, {
      problems: ['errors'],
      filter: { kind: 'error' },
      eventIds: errors.map((e) => e.id),
      instances: errors.map((e) => ({ t: e.t })),
      trace: { kind: 'events' },
      hint: 'Errors from robot code (CAN device errors are under Devices).',
      children: messageRows('code.errors', errors),
    }),
    count('code.warnings', 'Warnings', warnings.length, {
      filter: { kind: 'warning' },
      eventIds: warnings.map((e) => e.id),
      instances: warnings.map((e) => ({ t: e.t })),
      trace: { kind: 'events' },
      children: messageRows('code.warnings', warnings),
    }),
    count('code.logs', 'Logs', prints.length, {
      noise: 5,
      filter: { kind: 'print' },
      eventIds: prints.map((e) => e.id),
      instances: prints.map((e) => ({ t: e.t })),
      trace: { kind: 'events' },
      hint: 'Lines the robot program printed.',
      children: messageRows('code.logs', prints),
    }),
  );

  // Slowest step per tracer printout, like analysis.loopCulprits but only for this match.
  const steps = new Map<string, { worst: number; n: number; t: number }>();
  for (const e of inRange) {
    if (!e.tags.includes('tracer')) continue;
    const epochs = parseTracer(e.text);
    if (!epochs.length) continue;
    const [raw, s] = epochs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const name = raw.replace(/^Warning at .*?:\s+/, '');
    const c = steps.get(name) ?? { worst: 0, n: 0, t: e.t };
    c.n++;
    if (s > c.worst) {
      c.worst = s;
      c.t = e.t;
    }
    steps.set(name, c);
  }
  rows.push(
    count('code.overruns', 'Loop overruns', overruns.length, {
      noise: 2,
      problems: ['loop'],
      filter: { tag: 'loop' },
      eventIds: overruns.map((e) => e.id),
      instances: overruns.map((e) => ({ t: e.t })),
      trace: log ? { kind: 'series', signal: 'cpu' } : { kind: 'events' },
      hint: 'The 20 ms robot loop ran late. Children are the slowest step each time.',
      children: [...steps.entries()]
        .sort((a, b) => b[1].worst - a[1].worst)
        .map(([name, c]) => ({
          id: `code.overruns.${slug(name)}`,
          label: name,
          sub: `slowest ${c.n}×`,
          value: c.worst * 1000,
          unit: 'ms',
          digits: 1,
          at: c.t,
          better: 'lower' as const,
          noise: 3,
        })),
    }),
  );

  if (log) {
    const stalls = overlapping(analysis.codeStalls, range);
    rows.push(
      secs('code.unresponsive', 'Unresponsive', stats.codeStalls.duration, {
        digits: 2,
        noise: 0.2,
        problems: ['code-stall'],
        instances: stalls.map((s) => ({ t: s.start, end: s.end, value: s.end - s.start })),
        trace: { kind: 'series', signal: 'cpu', spans: 'stalls' },
        hint: 'Seconds the robot was connected but its program did not report a mode (stuck or slow loop).',
        children: [
          secs('code.unresponsive.longest', 'Longest', stats.codeStalls.longest, { digits: 2, noise: 0.1, at: stats.codeStalls.longestT }),
          count('code.unresponsive.times', 'Times', stalls.length, { noise: 10 }),
        ],
      }),
    );
  }

  const crashes = inRange.filter((e) => e.tags.includes('crash'));
  rows.push(
    count('code.crashes', 'Crashes', crashes.length, {
      problems: ['crash'],
      filter: { tag: 'crash' },
      eventIds: crashes.map((e) => e.id),
      instances: crashes.map((e) => ({ t: e.t })),
      trace: { kind: 'events' },
      children: messageRows('code.crashes', crashes),
    }),
  );
  return rows;
}

function devicesColumn(inRange: DSEvent[]): Row[] {
  const can = inRange.filter((e) => e.tags.includes('can') && (e.kind === 'error' || e.kind === 'warning'));
  const errors = can.filter((e) => e.level === 'error');
  const warnings = can.filter((e) => e.level === 'warning');
  const faults = inRange.filter((e) => e.tags.includes('can') && /\bfault/i.test(e.text));
  const parent = (id: string, label: string, list: DSEvent[], hint: string) =>
    count(id, label, list.length, {
      problems: ['can-devices'],
      filter: { tag: 'can' },
      eventIds: list.map((e) => e.id),
      instances: list.map((e) => ({ t: e.t })),
      trace: { kind: 'events' },
      hint,
      children: deviceRows(id, list),
    });
  return [
    parent('devices.canErrors', 'CAN errors', errors, 'Errors reported about a CAN device, per device.'),
    parent('devices.canWarnings', 'CAN warnings', warnings, 'Warnings reported about a CAN device, per device.'),
    parent('devices.faults', 'Faults', faults, 'Device faults the robot code or vendor library reported.'),
  ];
}

export interface CustomMetric {
  name: string;
  group?: string;
  unit: string;
  values: Instance[];
}

/** Team metrics printed by robot code: `[pv] Flywheel/Spinup = 0.42 s`. */
export function customMetrics(events: DSEvent[]): CustomMetric[] {
  const map = new Map<string, CustomMetric>();
  for (const e of events) {
    if (e.kind !== 'print') continue;
    const m = METRIC_RE.exec(e.text);
    if (!m) continue;
    const full = m[1].trim();
    const cut = full.search(/[/.](?=[^/.]+$)/);
    const group = cut > 0 ? full.slice(0, cut) : undefined;
    const name = cut > 0 ? full.slice(cut + 1) : full;
    const c = map.get(full) ?? { name, group, unit: m[3] ?? '', values: [] };
    c.values.push({ t: e.t, value: Number(m[2]) });
    map.set(full, c);
  }
  return [...map.values()];
}

function performanceColumn(inRange: DSEvent[]): Row[] {
  const metrics = customMetrics(inRange);
  const metricRow = (c: CustomMetric): Row => {
    const vals = c.values.map((v) => v.value!);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const digits = vals.some((v) => !Number.isInteger(v)) ? (Math.abs(avg) < 10 ? 2 : 1) : avg % 1 ? 1 : 0;
    return {
      id: `perf.${slug(`${c.group ?? ''}/${c.name}`)}`,
      label: c.name,
      sub:
        vals.length > 1 ? `avg of ${vals.length} · ${Math.min(...vals).toFixed(digits)}–${Math.max(...vals).toFixed(digits)}` : undefined,
      value: avg,
      unit: c.unit,
      digits,
      at: c.values[0].t,
      better: 'either',
      instances: c.values,
      trace: { kind: 'points' },
    };
  };
  const groups = new Map<string, CustomMetric[]>();
  const loose: Row[] = [];
  for (const c of metrics) {
    if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    else loose.push(metricRow(c));
  }
  return [
    ...[...groups.entries()].map(([g, list]) => ({
      id: `perf.group.${slug(g)}`,
      label: g,
      value: NaN,
      unit: '',
      digits: 0,
      children: list.map(metricRow),
    })),
    ...loose,
  ];
}

export function buildBoard(log: DSLog | null, file: DSEventsFile | null, analysis: Analysis, stats?: Stats): Board {
  const range = analysis.focus;
  const s = stats ?? computeStats(log, file, analysis, range);
  const inRange = (file?.events ?? []).filter((e) => e.t >= range.start && e.t <= range.end);
  return {
    range,
    columns: [
      { id: 'power', title: 'Power', rows: powerColumn(log, analysis, s, range) },
      { id: 'network', title: 'Network', rows: networkColumn(log, file, analysis, s, range, inRange) },
      { id: 'rio', title: 'RIO', rows: rioColumn(log, file, analysis, s, range) },
      { id: 'code', title: 'Code', rows: codeColumn(log, file, analysis, s, range, inRange) },
      { id: 'devices', title: 'Devices', rows: file ? devicesColumn(inRange) : [] },
      { id: 'performance', title: 'Performance', rows: performanceColumn(inRange) },
    ],
  };
}

export function* walkRows(rows: Row[], parent?: Row): Generator<[Row, Row | undefined]> {
  for (const r of rows) {
    yield [r, parent];
    if (r.children) yield* walkRows(r.children, r);
  }
}

/** The numbers saved per match for comparing later matches against. */
export function boardMetrics(board: Board): Record<string, number> {
  const out: Record<string, number> = {};
  for (const col of board.columns) for (const [r] of walkRows(col.rows)) if (r.better && Number.isFinite(r.value)) out[r.id] = r.value;
  return out;
}
