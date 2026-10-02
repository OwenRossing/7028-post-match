import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, STALL_MIN } from '../src/lib/analysis';
import {
  classifyHistory,
  demoBaseline,
  HISTORY_SIZE,
  judge,
  judgeBoard,
  MIN_HISTORY,
  shortLabel,
  usesDemoHistory,
  type Baseline,
} from '../src/lib/baseline';
import type { LogEntry } from '../src/lib/library';
import { boardMetrics, buildBoard, customMetrics, deviceOf, walkRows, type Row } from '../src/lib/board';
import { parseDSEvents, type DSEvent } from '../src/lib/dsevents';
import { parseDSLog } from '../src/lib/dslog';

const dir = new URL('../public/sample/', import.meta.url);
const load = (ext: string) => new Uint8Array(readFileSync(new URL(`2026_05_16%2011_38_21%20Sat.${ext}`, dir)));

function rowById(board: ReturnType<typeof buildBoard>, id: string): Row {
  for (const c of board.columns) for (const [r] of walkRows(c.rows)) if (r.id === id) return r;
  throw new Error(`no row ${id}`);
}

describe('board for the sample match', () => {
  const log = parseDSLog(load('dslog'));
  const events = parseDSEvents(load('dsevents'), log.startTime);
  const board = buildBoard(log, events, analyze(log, events));

  it('has the six columns in order', () => {
    expect(board.columns.map((c) => c.title)).toEqual(['Power', 'Network', 'RIO', 'Code', 'Devices', 'Performance']);
  });

  it('lists consumption per channel, biggest first', () => {
    const r = rowById(board, 'power.consumption');
    expect(r.children).toHaveLength(24);
    const mah = r.children!.map((c) => c.value);
    expect(mah).toEqual([...mah].sort((a, b) => b - a));
    expect(r.value).toBeCloseTo(
      mah.reduce((a, b) => a + b, 0),
      -1,
    );
    expect(rowById(board, 'power.peak').value).toBeGreaterThan(400);
  });

  it('counts CAN warnings per device', () => {
    const r = rowById(board, 'devices.canWarnings');
    const byName = Object.fromEntries(r.children!.map((c) => [c.label, c.value]));
    expect(byName['Pigeon 2 0']).toBe(6);
    expect(byName['Talon FX 0']).toBe(4);
    expect(r.children!.reduce((a, c) => a + c.value, 0)).toBe(r.value);
    expect(r.children![0].sub).toContain('canivore');
  });

  it('counts 12 V rail dropouts as brownouts, each with its time', () => {
    const r = rowById(board, 'power.brownouts');
    expect(r.value).toBe(9);
    const times = r.children!.filter((c) => c.label === 'At');
    expect(times).toHaveLength(9);
    expect(times.every((c) => c.at != null && c.sub === '12 V rail')).toBe(true);
    // not also listed as a roboRIO fault
    expect(rowById(board, 'rio.faults').value).toBe(0);
  });

  it('keeps processor and memory behind one row with no number, and puts CAN bus load under Devices', () => {
    const health = rowById(board, 'rio.health');
    expect(Number.isNaN(health.value)).toBe(true);
    expect(health.children!.map((c) => c.id)).toEqual(['rio.cpu', 'rio.cpu.max', 'rio.memory']);
    expect(health.children!.every((c) => c.hint)).toBe(true);
    const can = rowById(board, 'devices.canLoad');
    expect(Number.isNaN(can.value)).toBe(true);
    expect(can.label).toBe('CAN bus load');
    expect(board.columns.find((c) => c.id === 'rio')!.rows.some((r) => r.id.startsWith('rio.can'))).toBe(false);
  });

  it('has no separate row for a frozen program unless there was a real freeze', () => {
    expect(() => rowById(board, 'code.unresponsive')).toThrow();
    const frozen = rowById(board, 'code.overruns').children!.filter((c) => c.id === 'code.overruns.frozen');
    expect(frozen.length).toBeLessThanOrEqual(1);
  });

  it('keeps loop output out of Logs and cleans step names', () => {
    const logs = rowById(board, 'code.logs');
    expect(logs.children!.some((c) => /overrun|Tracer/i.test(c.label))).toBe(false);
    const steps = rowById(board, 'code.overruns').children!.map((c) => c.label);
    expect(steps).toContain('disabledInit()');
    expect(steps.some((s) => s.startsWith('Warning at'))).toBe(false);
  });

  it('saves a number for every comparable row, with stable ids', () => {
    const m = boardMetrics(board);
    expect(m['power.minVoltage']).toBeCloseTo(6.28, 1);
    expect(m['power.consumption.ch15']).toBeGreaterThan(0);
    expect(Object.keys(m).some((k) => /\.i\d+$/.test(k))).toBe(false); // instance rows are not compared
    expect(Object.keys(m).some((k) => k.startsWith('power.brownouts.i'))).toBe(false);
    expect(boardMetrics(buildBoard(log, events, analyze(log, events)))).toEqual(m);
  });

  it('makes the same demo history every time, and flags some of it', () => {
    const a = judgeBoard(board, demoBaseline(board));
    const b = judgeBoard(board, demoBaseline(board));
    const flagged = [...a.values()].filter((j) => j.flagged).length;
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBe([...b.values()].filter((j) => j.flagged).length);
  });
});

describe('judging a row against history', () => {
  const points = (vals: (number | undefined)[]): Baseline => ({
    demo: false,
    points: vals.map((v, i) => ({
      key: `k${i}`,
      startTime: i,
      label: `Q${i}`,
      metrics: v === undefined ? {} : ({ x: v } as Record<string, number>),
    })),
  });
  const row = (value: number, extra: Partial<Row> = {}): Row => ({
    id: 'x',
    label: 'x',
    value,
    unit: 'A',
    digits: 0,
    better: 'lower',
    ...extra,
  });

  it('flags a value 2+ standard deviations out on the bad side', () => {
    const base = points([10, 11, 9, 10, 12, 8, 10]);
    expect(judge(row(10), base)!.flagged).toBe(false);
    expect(judge(row(20), base)!.flagged).toBe(true);
    expect(judge(row(0), base)!.flagged).toBe(false); // lower is better
    expect(judge(row(0, { better: 'either' }), base)!.flagged).toBe(true);
    expect(judge(row(5, { better: 'higher' }), base)!.flagged).toBe(true);
  });

  it('needs enough earlier matches', () => {
    const j = judge(row(100), points([10, 10, 10]))!;
    expect(j.n).toBeLessThan(MIN_HISTORY);
    expect(j.flagged).toBe(false);
  });

  it('uses the noise floor when history never varies', () => {
    const base = points([0, 0, 0, 0, 0, 0]);
    expect(judge(row(1, { noise: 1 }), base)!.flagged).toBe(false);
    expect(judge(row(2, { noise: 1 }), base)!.flagged).toBe(true);
  });

  it('counts missing history as zero only for counts', () => {
    const base = points([undefined, undefined, undefined, undefined, undefined]);
    expect(judge(row(3, { noise: 1, zeroIfMissing: true }), base)!.n).toBe(5);
    expect(judge(row(3), base)!.n).toBe(0);
  });

  it('shortens match titles for chart labels', () => {
    expect(shortLabel('Qualification 22')).toBe('Q22');
    expect(shortLabel('Playoff 4 (replay 2)')).toBe('P4');
  });
});

describe('which logs make up the comparison', () => {
  const entry = (key: string, startTime: number, summary: Partial<NonNullable<LogEntry['summary']>> | null): LogEntry => ({
    key,
    source: 'folder',
    startTime,
    summary: summary
      ? ({ title: `Qualification ${startTime}`, isMatch: true, team: 7028, metrics: { x: 1 }, ...summary } as LogEntry['summary'])
      : undefined,
  });

  it('uses the newest 15 earlier matches of the same team and says why the rest are left out', () => {
    const logs: LogEntry[] = [
      ...Array.from({ length: 17 }, (_, i) => entry(`m${i}`, 100 + i, {})),
      entry('practice', 150, { isMatch: false }),
      entry('other-team', 151, { team: 254 }),
      entry('unread', 152, null),
      entry('later', 500, {}),
      entry('now', 300, {}),
    ];
    const { points, status } = classifyHistory(logs, { key: 'now', startTime: 300, team: 7028 });
    expect(points).toHaveLength(HISTORY_SIZE);
    expect(points.map((p) => p.key)).toEqual(Array.from({ length: 15 }, (_, i) => `m${i + 2}`)); // oldest first
    expect(status.get('m2')).toEqual({ used: true });
    expect(status.get('m0')).toMatchObject({ used: false, reason: expect.stringMatching(/15 most recent/) });
    expect(status.get('practice')).toMatchObject({ used: false, reason: expect.stringMatching(/Not a match/) });
    expect(status.get('other-team')).toMatchObject({ used: false, reason: expect.stringMatching(/254/) });
    expect(status.get('unread')).toMatchObject({ used: false, reason: expect.stringMatching(/Still being read/) });
    expect(status.get('later')).toMatchObject({ used: false, reason: expect.stringMatching(/after this match/) });
    expect(status.get('now')).toMatchObject({ used: false });
  });

  it('only shows made-up history for the sample, and only when there is no real history', () => {
    expect(usesDemoHistory({ source: 'sample' }, 0)).toBe(true);
    expect(usesDemoHistory({ source: 'sample' }, 5)).toBe(false);
    expect(usesDemoHistory({ source: 'folder' }, 0)).toBe(false);
  });
});

describe('frozen program detection', () => {
  it('ignores single-packet gaps and the ones at mode changes in the sample', () => {
    const log = parseDSLog(load('dslog'));
    const events = parseDSEvents(load('dsevents'), log.startTime);
    const a = analyze(log, events);
    const changes = a.modes.slice(1).map((m) => m.start);
    for (const s of a.codeStalls) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(STALL_MIN);
      expect(changes.every((t) => Math.abs(s.start - t) > 0.5)).toBe(true);
    }
  });
});

describe('parsing messages', () => {
  const ev = (text: string, extra: Partial<DSEvent> = {}): DSEvent => ({
    id: 0,
    t: 1,
    kind: 'print',
    level: 'info',
    text,
    tags: [],
    sig: text,
    ...extra,
  });

  it('reads team metrics printed by robot code', () => {
    const m = customMetrics([
      ev('[pv] Flywheel/Spinup = 0.42 s', { t: 10 }),
      ev('[pv] Flywheel/Spinup = 0.50 s', { t: 20 }),
      ev('[metric] cycles: 8'),
      ev('not a metric = 3'),
    ]);
    expect(m).toHaveLength(2);
    const spin = m.find((x) => x.name === 'Spinup')!;
    expect(spin.group).toBe('Flywheel');
    expect(spin.unit).toBe('s');
    expect(spin.values.map((v) => v.value)).toEqual([0.42, 0.5]);
    expect(m.find((x) => x.name === 'cycles')!.group).toBeUndefined();
  });

  it('names CAN devices from message locations', () => {
    expect(deviceOf(ev('x', { location: 'talon fx 5 ("canivore") Status Signal Velocity' }))).toMatchObject({
      name: 'Talon FX 5',
      bus: 'canivore',
      signal: 'Velocity',
    });
    expect(deviceOf(ev('x', { location: 'pigeon 2 0 ("canivore") Status Signal Yaw' }))).toMatchObject({ name: 'Pigeon 2 0' });
    expect(deviceOf(ev('x', { location: 'ctre::phoenix6::BaseStatusSignal::WaitForAll' }))?.name).toBe('Phoenix (no device)');
    expect(deviceOf(ev('SPARK MAX 12: CAN timeout'))?.name).toBe('SPARK MAX 12');
    expect(deviceOf(ev('x', { location: 'Robot.java:12' }))).toBeNull();
  });
});
