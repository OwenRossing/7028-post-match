import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/analysis';
import { demoBaseline, judge, judgeBoard, MIN_HISTORY, shortLabel, type Baseline } from '../src/lib/baseline';
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

  it('lists each rail fault with its time', () => {
    const r = rowById(board, 'rio.faults');
    expect(r.value).toBe(9);
    expect(r.children).toHaveLength(9);
    expect(r.children!.every((c) => c.at != null && c.sub === '12 V rail')).toBe(true);
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
