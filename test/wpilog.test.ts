import { describe, expect, it } from 'vitest';
import { clockOffset, consoleLines, enabledWindows, findSeries, isWPILog, parseWPILog } from '../src/lib/wpilog';
import { WPILogWriter } from './helpers/wpilog-writer';

describe('parseWPILog', () => {
  it('reads every scalar type with its time', () => {
    const w = new WPILogWriter('extra');
    const d = w.start('NT:/Robot/speed', 'double', 0.5, '{"unit":"m/s"}');
    const f = w.start('f', 'float', 0.5);
    const i = w.start('i', 'int64', 0.5);
    const b = w.start('b', 'boolean', 0.5);
    const s = w.start('s', 'string', 0.5);
    w.double(d, 1.25, 3.5);
    w.double(d, 2.5, -4.25);
    w.float(f, 1, 0.5);
    w.int64(i, 1, 123456789012);
    w.boolean(b, 1, true);
    w.boolean(b, 2, false);
    w.string(s, 3, 'héllo ✓');
    const log = parseWPILog(w.bytes());

    expect(log.extraHeader).toBe('extra');
    expect(log.entries.map((e) => [e.name, e.type, e.count])).toEqual([
      ['NT:/Robot/speed', 'double', 2],
      ['f', 'float', 1],
      ['i', 'int64', 1],
      ['b', 'boolean', 2],
      ['s', 'string', 1],
    ]);
    expect(log.entries[0].metadata).toBe('{"unit":"m/s"}');
    expect([...log.series.get('NT:/Robot/speed')!.t]).toEqual([1.25, 2.5]);
    expect([...log.series.get('NT:/Robot/speed')!.v]).toEqual([3.5, -4.25]);
    expect([...log.series.get('f')!.v]).toEqual([0.5]);
    expect([...log.series.get('i')!.v]).toEqual([123456789012]);
    expect([...log.series.get('b')!.v]).toEqual([1, 0]);
    expect(log.text.get('s')).toEqual([{ t: 3, text: 'héllo ✓' }]);
    expect(log.first).toBe(0.5);
    expect(log.last).toBe(3);
    expect(log.truncated).toBe(false);
  });

  it('handles multi-byte ids, sizes and timestamps', () => {
    const w = new WPILogWriter();
    let id = 0;
    for (let n = 0; n < 300; n++) id = w.start(`e${n}`, 'double', 0);
    w.double(id, 4000.123456, 7); // id 300 needs 2 bytes, timestamp needs 4
    w.string(w.start('big', 'string', 0), 4000.5, 'x'.repeat(70000)); // size needs 3 bytes
    const log = parseWPILog(w.bytes());
    expect(log.series.get('e299')!.t[0]).toBeCloseTo(4000.123456, 6);
    expect(log.text.get('big')![0].text.length).toBe(70000);
  });

  it('counts but does not store arrays, structs and raw data', () => {
    const w = new WPILogWriter();
    const a = w.start('arr', 'double[]');
    const st = w.start('pose', 'struct:Pose2d');
    const r = w.start('blob', 'raw');
    w.raw(a, 1, [0, 0, 0, 0, 0, 0, 0, 0]);
    w.raw(st, 1, [1, 2, 3]);
    w.raw(r, 1, [9]);
    const log = parseWPILog(w.bytes());
    expect(log.entries.map((e) => [e.name, e.kind, e.count])).toEqual([
      ['arr', 'array', 1],
      ['pose', 'raw', 1],
      ['blob', 'raw', 1],
    ]);
    expect(log.series.size).toBe(0);
  });

  it('respects the keep filter but still counts records', () => {
    const w = new WPILogWriter();
    const a = w.start('keep', 'double');
    const b = w.start('drop', 'double');
    w.double(a, 1, 1);
    w.double(b, 1, 2);
    const log = parseWPILog(w.bytes(), { keep: (n) => n === 'keep' });
    expect(log.series.has('drop')).toBe(false);
    expect(log.entries.find((e) => e.name === 'drop')!.count).toBe(1);
  });

  it('applies finish and metadata updates', () => {
    const w = new WPILogWriter();
    const a = w.start('a', 'double', 1);
    w.setMetadata(a, 2, '{"x":1}');
    w.finish(a, 5);
    const log = parseWPILog(w.bytes());
    expect(log.entries[0]).toMatchObject({ start: 1, end: 5, metadata: '{"x":1}' });
  });

  it('merges a name that was started twice', () => {
    const w = new WPILogWriter();
    const a = w.start('x', 'double');
    w.double(a, 1, 1);
    w.finish(a, 2);
    const b = w.start('x', 'double', 3);
    w.double(b, 4, 2);
    const log = parseWPILog(w.bytes());
    expect([...log.series.get('x')!.t]).toEqual([1, 4]);
    expect([...log.series.get('x')!.v]).toEqual([1, 2]);
  });

  it('flags a file cut off mid-record and keeps what came before', () => {
    const w = new WPILogWriter();
    const a = w.start('a', 'double');
    w.double(a, 1, 1);
    w.double(a, 2, 2);
    const bytes = w.bytes();
    const log = parseWPILog(bytes.subarray(0, bytes.length - 3));
    expect(log.truncated).toBe(true);
    expect([...log.series.get('a')!.v]).toEqual([1]);
  });

  it('skips data for an entry that was never started', () => {
    const w = new WPILogWriter();
    w.raw(77, 1, [1]);
    const log = parseWPILog(w.bytes());
    expect(log.skipped).toBe(1);
  });

  it('rejects things that are not wpilogs', () => {
    expect(isWPILog(new TextEncoder().encode('not a log at all'))).toBe(false);
    expect(() => parseWPILog(new TextEncoder().encode('not a log at all'))).toThrow(/WPILOG/);
    const bad = new WPILogWriter().bytes();
    bad[6] = 0;
    bad[7] = 2; // version 2.0
    expect(() => parseWPILog(bad)).toThrow(/version/);
  });

  it('reads an empty log', () => {
    const log = parseWPILog(new WPILogWriter().bytes());
    expect(log.entries).toEqual([]);
    expect(log.first).toBe(0);
    expect(log.last).toBe(0);
  });
});

describe('helpers', () => {
  it('finds names ignoring case and punctuation', () => {
    const w = new WPILogWriter();
    const a = w.start('/DriverStation/Enabled', 'boolean');
    w.boolean(a, 1, true);
    const log = parseWPILog(w.bytes());
    expect(findSeries(log, 'DS:enabled')).toBeUndefined();
    expect(findSeries(log, 'DriverStation/Enabled')).toBeDefined();
  });

  it('turns the DS enabled flag into windows', () => {
    const w = new WPILogWriter();
    const e = w.start('DS:enabled', 'boolean');
    w.boolean(e, 0, false);
    w.boolean(e, 5, true);
    w.boolean(e, 20, false);
    w.boolean(e, 30, true);
    const x = w.start('end', 'double');
    w.double(x, 40, 0);
    expect(enabledWindows(parseWPILog(w.bytes()))).toEqual([
      { start: 5, end: 20 },
      { start: 30, end: 40 }, // still enabled when the log ends
    ]);
  });

  it('collects console lines', () => {
    const w = new WPILogWriter();
    const m = w.start('messages', 'string');
    w.string(m, 1, 'Robot code started');
    w.string(m, 2, 'Auto selected: two piece');
    expect(consoleLines(parseWPILog(w.bytes())).map((l) => l.text)).toEqual(['Robot code started', 'Auto selected: two piece']);
  });

  it('reads the robot clock, ignoring an unset 1970 clock', () => {
    const w = new WPILogWriter();
    const c = w.start('systemTime', 'int64');
    w.int64(c, 1, 5_000_000); // 1970, before the DS set the clock
    w.int64(c, 10, 1_767_225_600_000_000 + 10_000_000); // 2026-01-01 plus the 10 s since log start
    const off = clockOffset(parseWPILog(w.bytes()));
    expect(off).toBeCloseTo(1_767_225_600, 3); // unix = logTime + offset
  });

  it('has no clock when systemTime is missing', () => {
    expect(clockOffset(parseWPILog(new WPILogWriter().bytes()))).toBeUndefined();
  });
});
