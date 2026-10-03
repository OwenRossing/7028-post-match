import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLAG, parseDSLog, type DSLog } from '../src/lib/dslog';
import { canStaleCount, drawAt, pdStatus, powerReport, powerSources, sortRows } from '../src/lib/power';
import type { RobotSignal } from '../src/lib/robotSeries';

const arr = (...v: number[]) => Float32Array.from(v);
const NaNs = (n: number) => new Float32Array(n).fill(NaN);

/** A log of `n` 20 ms records, enabled (teleop) from `from` to `to`. Only what the power report reads. */
function fake(n: number, enabled: [number, number], over: Partial<DSLog> = {}): DSLog {
  const flags = new Uint8Array(n);
  for (let i = enabled[0]; i <= enabled[1]; i++) flags[i] = FLAG.DS_TELEOP;
  return {
    count: n,
    period: 0.02,
    comms: new Uint8Array(n).fill(1),
    flags,
    voltage: new Float32Array(n).fill(12),
    totalCurrent: NaNs(n),
    currents: [],
    channelCount: 0,
    typeBytes: {},
    pdType: 'none',
    ...over,
  } as unknown as DSLog;
}

const robot = (name: string, group: string, short: string, label?: string, a = arr(1, 2), log = 'a.wpilog'): RobotSignal => ({ log, name, group, short, kind: 'current', label, arr: a });

describe('the battery low point and who drew what', () => {
  it('finds the lowest voltage while enabled, ignoring a deeper dip while disabled', () => {
    const log = fake(40, [10, 30], { voltage: Float32Array.from({ length: 40 }, (_, i) => (i === 3 ? 4 : i === 20 ? 6.2 : 12)) });
    const r = powerReport(log, []);
    expect(r.low).toEqual({ index: 20, volts: expect.closeTo(6.2, 5) });
  });

  it('reads each source at the low point (within 0.1 s), at its peak, on average and in charge', () => {
    const a = new Float32Array(40).fill(NaN);
    const b = new Float32Array(40).fill(NaN);
    for (let i = 10; i <= 30; i++) [a[i], b[i]] = [10, 0];
    a[20] = 50; // at the low point
    a[28] = 80; // its peak, later
    b[24] = 30; // 4 records after the low point: close enough to count
    const log = fake(40, [10, 30], { voltage: Float32Array.from({ length: 40 }, (_, i) => (i === 20 ? 6 : 12)) });
    const r = powerReport(log, [
      { id: 'ch0', name: 'Shooter', kind: 'channel', arr: a },
      { id: 'ch1', name: 'Intake', kind: 'channel', arr: b },
    ]);
    const [x, y] = r.rows;
    expect(x).toMatchObject({ peak: 80, peakAt: 28, atLow: 50 }); // its peak came later, 0.16 s after the low point: not counted as drawn then
    expect(y).toMatchObject({ peak: 30, peakAt: 24, atLow: 30 }); // 4 records (80 ms) away is close enough
    expect(x.mean).toBeCloseTo((10 * 19 + 50 + 80) / 21, 6); // the 21 enabled records
  });

  it('does not credit a draw that is more than 0.1 s from the low point', () => {
    const a = new Float32Array(40).fill(5);
    a[20] = 50;
    a[28] = 80; // 8 records = 0.16 s after the low point
    const log = fake(40, [10, 30], { voltage: Float32Array.from({ length: 40 }, (_, i) => (i === 20 ? 6 : 12)) });
    const r = powerReport(log, [{ id: 'ch0', name: 'Shooter', kind: 'channel', arr: a }]);
    expect(r.rows[0]).toMatchObject({ peak: 80, atLow: 50 });
  });

  it('says how much charge a source used while enabled, in amp-hours', () => {
    const a = new Float32Array(100).fill(36); // 36 A for the 51 enabled records
    const log = fake(100, [10, 60]);
    const r = powerReport(log, [{ id: 'ch0', name: 'x', kind: 'channel', arr: a }]);
    expect(r.rows[0].ah).toBeCloseTo((36 * 51 * 0.02) / 3600, 8);
    expect(r.rows[0].mean).toBe(36);
  });

  it("uses the board's own total at the low point, or the sum of what is listed, and says which", () => {
    const n = 40;
    const sources = [
      { id: 'a', name: 'a', kind: 'motor' as const, arr: new Float32Array(n).fill(20) },
      { id: 'b', name: 'b', kind: 'motor' as const, arr: new Float32Array(n).fill(15) },
    ];
    const volts = Float32Array.from({ length: n }, (_, i) => (i === 20 ? 6 : 12));
    const withTotal = powerReport(fake(n, [10, 30], { voltage: volts, totalCurrent: new Float32Array(n).fill(120) }), sources);
    expect(withTotal).toMatchObject({ total: 120, totalIsSum: false });
    const without = powerReport(fake(n, [10, 30], { voltage: volts }), sources);
    expect(without).toMatchObject({ total: 35, totalIsSum: true });
  });

  it('judges a pit check, with no enabled time, over everything the robot was connected for', () => {
    const log = fake(20, [1, 0], { voltage: Float32Array.from({ length: 20 }, (_, i) => (i === 8 ? 11 : 12.5)) });
    expect(powerReport(log, []).low).toEqual({ index: 8, volts: 11 });
  });

  it('sorts by what was asked for, with nothing known last', () => {
    const mk = (name: string, peak: number, ah: number, atLow: number) => ({ source: { id: name, name, kind: 'motor' as const, arr: arr() }, peak, peakAt: 0, mean: 0, ah, atLow });
    const rows = [mk('a', 10, 3, NaN), mk('b', 30, 1, 5), mk('c', 20, 2, 9)];
    expect(sortRows(rows, 'low').map((r) => r.source.name)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, 'peak').map((r) => r.source.name)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 'used').map((r) => r.source.name)).toEqual(['a', 'c', 'b']);
  });
});

describe('which currents count as what the battery supplies', () => {
  it('prefers the supply current to the stator current of the same motor, but keeps a stator-only motor with a warning', () => {
    const sig = [
      robot('Phoenix6/TalonFX-1/StatorCurrent', 'Phoenix6/TalonFX-1', 'StatorCurrent', 'TalonFX 1 · Stator'),
      robot('Phoenix6/TalonFX-1/SupplyCurrent', 'Phoenix6/TalonFX-1', 'SupplyCurrent', 'TalonFX 1 · Supply'),
      robot('Phoenix6/TalonFX-2/StatorCurrent', 'Phoenix6/TalonFX-2', 'StatorCurrent', 'TalonFX 2 · Stator'),
    ];
    const out = powerSources(fake(10, [0, 9]), sig, (c) => `Ch ${c}`);
    expect(out.map((s) => s.name)).toEqual(['TalonFX 1 · Supply', 'TalonFX 2 · Stator']);
    expect(out[0].note).toBeUndefined();
    expect(out[1].note).toMatch(/not what the battery supplies/);
    expect(out.map((s) => s.id)).toEqual(['m:1', 'm:2']); // the Graphs rows, by position in the robot signals
  });

  it("lists the Driver Station's channels with the user's names, and leaves out a robot log's copy of the same channels", () => {
    const log = fake(10, [0, 9], { channelCount: 2, currents: [new Float32Array(10).fill(3), new Float32Array(10).fill(4)] });
    const sig = [robot('PowerDistribution/ChannelCurrent[0]', 'PowerDistribution', 'ChannelCurrent[0]', 'PowerDistribution ch 0'), robot('Shooter/Current', 'Shooter', 'Current', 'Shooter')];
    const out = powerSources(log, sig, (c) => (c === 1 ? 'Intake' : `Ch ${c}`));
    expect(out.map((s) => [s.id, s.name, s.kind])).toEqual([
      ['ch0', 'Ch 0', 'channel'],
      ['ch1', 'Intake', 'channel'],
      ['m:1', 'Shooter', 'motor'],
    ]);
  });

  it("keeps a robot log's power channels when the Driver Station log has none", () => {
    const sig = [robot('PowerDistribution/ChannelCurrent[3]', 'PowerDistribution', 'ChannelCurrent[3]', 'PowerDistribution ch 3')];
    expect(powerSources(fake(10, [0, 9]), sig, () => '').map((s) => [s.id, s.kind])).toEqual([['m:0', 'channel']]);
  });
});

describe('what is drawing at one moment', () => {
  it('lists the biggest draws within 40 ms, ignoring anything under 1 A', () => {
    const src = (name: string, v: number) => ({ id: name, name, kind: 'motor' as const, arr: new Float32Array(20).fill(v) });
    const out = drawAt([src('a', 0.4), src('b', 90), src('c', 12), src('d', 55), src('e', 30)], 10, 3);
    expect(out.map((d) => [d.source.name, d.amps])).toEqual([['b', 90], ['d', 55], ['e', 30]]);
  });
});

describe('what the Driver Station log says about the board', () => {
  it('says so when the log has no power distribution records at all', () => {
    const s = pdStatus(fake(1000, [0, 999], { typeBytes: { 0: 1000 } }));
    expect(s.kind).toBe('none');
    expect(s.text).toMatch(/None of this log's 1,000 records carry power distribution data/);
  });

  it('says so when the type is one it does not decode, and which', () => {
    const s = pdStatus(fake(1000, [0, 999], { typeBytes: { 0: 100, 40: 900 } }));
    expect(s.kind).toBe('unknown');
    expect(s.text).toMatch(/900 of this log's 1,000 records carry a power distribution type PitView does not decode \(type 40 ×900\)/);
  });

  it('says so when the board was recorded but nothing drew a full amp', () => {
    const log = fake(10, [0, 9], { typeBytes: { 33: 10 }, pdType: 'rev', channelCount: 1, currents: [new Float32Array(10).fill(0.3)] });
    expect(pdStatus(log).kind).toBe('idle');
  });

  it('says a board that never changed is a placeholder, with the battery range and the board', () => {
    const volts = Float32Array.from({ length: 1000 }, (_, i) => 13.5 - (i / 999) * 7.7);
    const s = pdStatus(fake(1000, [0, 999], { typeBytes: { 33: 1000 }, pdType: 'rev', pdCanId: 1, voltage: volts, pdFrozen: { records: 1000, temp: 255 } }));
    expect(s.kind).toBe('frozen');
    expect(s.text).toMatch(/identical PDH reading \(CAN ID 1\) in all 1,000 records while connected: every channel 0 A and board temperature 255 °C, even while the battery went from 13\.5 V down to 5\.8 V/);
    expect(s.text).toMatch(/leaves the channels out instead of drawing zeros/);
  });

  it('does not mention a battery swing that was not there', () => {
    const s = pdStatus(fake(1000, [0, 999], { pdType: 'ctre', pdCanId: 0, pdFrozen: { records: 1000, temp: NaN } }));
    expect(s.text).toMatch(/identical PDP reading \(CAN ID 0\) in all 1,000 records while connected: every channel 0 A\. A live board/);
  });

  it('counts the CAN reads that timed out', () => {
    const ev = (text: string) => ({ text }) as never;
    expect(canStaleCount([ev('CAN message is stale, data is valid but old. Check the CAN bus wiring'), ev('CAN frame not received/too-stale. Check'), ev('Loop time of 0.02s overrun')])).toBe(2);
    expect(canStaleCount(undefined)).toBe(0);
  });

  const shop = '2026_10_03 13_09_44 Sat.dslog';
  it.skipIf(!existsSync(shop))('reads the 2026-10-03 shop log (a PDH that never answered) as a placeholder, not as 0 A', () => {
    const log = parseDSLog(new Uint8Array(readFileSync(shop)));
    expect(log.typeBytes[33]).toBe(log.count);
    expect(log.pdFrozen).toMatchObject({ records: 17404, temp: 255 });
    expect(log.channelCount).toBe(0);
    const s = pdStatus(log);
    expect(s.kind).toBe('frozen');
    expect(s.text).toMatch(/down to 5\.8 V/);
  });

  it('reads the real sample as recorded and used, and its low point and biggest draws are real', () => {
    const log = parseDSLog(new Uint8Array(readFileSync('public/sample/2026_05_16 11_38_21 Sat.dslog')));
    expect(pdStatus(log)).toMatchObject({ kind: 'ok', text: expect.stringMatching(/REV PDH/) });
    const sources = powerSources(log, [], (c) => `Ch ${c}`);
    expect(sources).toHaveLength(24);
    const r = powerReport(log, sources);
    expect(r.low!.volts).toBeGreaterThan(5);
    expect(r.low!.volts).toBeLessThan(8);
    expect(r.total).toBeGreaterThan(50);
    const top = sortRows(r.rows, 'low')[0];
    expect(top.atLow).toBeGreaterThan(5);
    expect(sortRows(r.rows, 'used')[0].ah).toBeGreaterThan(0);
  });
});
