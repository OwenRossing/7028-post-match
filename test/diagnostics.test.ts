import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/analysis';
import { diagnosticsText, robotGraphLines, robotLogDiagnostics } from '../src/lib/diagnostics';
import { describeExtra } from '../src/lib/extras';
import { parseDSEvents } from '../src/lib/dsevents';
import { parseDSLog } from '../src/lib/dslog';
import type { LogEntry } from '../src/lib/library';
import { WPILogWriter } from './helpers/wpilog-writer';

const dir = new URL('../public/sample/', import.meta.url);
const load = (ext: string) => new Uint8Array(readFileSync(new URL(`2026_05_16%2011_38_21%20Sat.${ext}`, dir)));
const ref = (name: string, size: number) => ({ name, size, mtime: 0, read: async () => new ArrayBuffer(0) });

describe('diagnosticsText', () => {
  const log = parseDSLog(load('dslog'));
  const events = parseDSEvents(load('dsevents'), log.startTime);
  const entry: LogEntry = { key: 'k', source: 'sample', startTime: log.startTime, dslog: ref('a.dslog', 10), dsevents: ref('a.dsevents', 20) };

  it('says how the power distribution data was read', () => {
    const text = diagnosticsText(entry, { log, events, analysis: analyze(log, events), extras: [], robot: [], warnings: [] });
    expect(text).toMatch(/power distribution: rev · CAN id 1 · records by type byte \{.*"33":\d+/);
    expect(text).toMatch(/channels at 1 A or more at some point: 23 of 24/);
    expect(text).toMatch(/connected to the robot: \d+\.\d% of records/);
    expect(text).toMatch(/first record with power data \(#\d+, 47 bytes\): [0-9a-f ]+/);
    expect(text).toContain('a.dslog (10 bytes)');
    // the messages themselves are not included
    expect(text).not.toMatch(/Loop time of/);
  });

  it('copes with a log that has no .dslog', () => {
    const text = diagnosticsText(entry, { log: null, events, analysis: analyze(null, events), extras: [], robot: [], warnings: [] });
    expect(text).toContain('.dslog: none');
    expect(text).toContain('.dsevents:');
  });

  it('records which type bytes the log carried', () => {
    expect(log.typeBytes[33]).toBeGreaterThan(0);
    expect(Object.values(log.typeBytes).reduce((a, b) => a + b, 0)).toBe(log.count);
    expect(log.pdSample!.bytes).toHaveLength(14 + 33); // base record + REV power distribution block
  });
});

describe('robotLogDiagnostics', () => {
  const buf = (w: WPILogWriter) => w.bytes().buffer.slice(0) as ArrayBuffer;

  it('lists every signal with its type, record count and what the logger said about it', () => {
    const w = new WPILogWriter();
    const pos = w.start('Phoenix6/TalonFX-1/Position', 'double', 0, '{"source":"Phoenix 6","unit":"rotations"}');
    const cur = w.start('Phoenix6/TalonFX-1/StatorCurrent', 'double', 0, '{"source":"Phoenix 6","unit":"amps"}');
    const sys = w.start('systemTime', 'int64', 0);
    const mn = w.start('NT:/FMSInfo/MatchNumber', 'int64', 0);
    const mt = w.start('NT:/FMSInfo/MatchType', 'int64', 0);
    w.int64(mt, 1, 2);
    w.int64(mn, 1, 22);
    w.int64(sys, 2, 1_767_225_600_000_000);
    for (let t = 0; t < 5; t++) {
      w.double(pos, t, t * 3);
      w.double(cur, t, 20);
    }
    const info = describeExtra('rio_2026-05-16_16-38-21.wpilog', 'wpilog', buf(w), null);
    const text = robotLogDiagnostics([info]);
    expect(text).toMatch(/robot log rio_2026-05-16_16-38-21\.wpilog: CTRE Phoenix/);
    expect(text).toContain('robot clock: yes, starts 2025-12-31T23:59:58.000Z'); // the reading came 2 s into the log, so the log began 2 s before it
    expect(text).toMatch(/field match name: Qualification 22/);
    expect(text).toContain('Phoenix6/TalonFX-1/Position | double | 5 | {"source":"Phoenix 6","unit":"rotations"}');
    expect(text).toContain('Phoenix6/TalonFX-1/StatorCurrent | double | 5 | {"source":"Phoenix 6","unit":"amps"}');
    expect(text).toMatch(/lined up with the match: not checked/);
  });

  it('describes a .hoot well enough to work out its layout, without including the file', () => {
    const bytes = new TextEncoder().encode('HOOT\x01\0\0\0' + 'TalonFX-1/Position\0'.repeat(3) + 'x'.repeat(5000)).buffer as ArrayBuffer;
    const info = describeExtra('rio_2026-05-16_16-38-21.hoot', 'hoot', bytes, null);
    const text = robotLogDiagnostics([info]);
    expect(text).toMatch(/robot log rio_2026-05-16_16-38-21\.hoot: CTRE Phoenix · 0\.0 MB/);
    expect(text).toMatch(/\.hoot: \d+ bytes · not decoded/);
    expect(text).toContain('first bytes: 48 4f 4f 54 01 00 00 00');
    expect(text).toMatch(/entropy bits\/byte/);
    expect(text).toContain('TalonFX-1/Position | 3');
    expect(text.length).toBeLessThan(30000); // small enough to paste
  });

  it('says so when a log is unreadable, and caps a very long signal list', () => {
    const bad = describeExtra('x.wpilog', 'wpilog', new TextEncoder().encode('nope nope nope').buffer as ArrayBuffer, null);
    expect(robotLogDiagnostics([bad])).toMatch(/unreadable: .*WPILOG/);
    const w = new WPILogWriter();
    for (let i = 0; i < 500; i++) w.start(`s${String(i).padStart(3, '0')}`, 'double');
    const text = robotLogDiagnostics([describeExtra('big.wpilog', 'wpilog', buf(w), null)], 400);
    expect(text).toMatch(/500 signals .*first 400/);
    expect(text).toContain('s399 | double | 0');
    expect(text).not.toContain('s400 | double');
  });
});

describe('robotGraphLines', () => {
  const arr = (...v: number[]) => Float32Array.from(v);
  const parsed = (over: object) => ({ log: null, events: null, analysis: {}, extras: [], robot: [], warnings: [], ...over }) as unknown as Parameters<typeof robotGraphLines>[0];

  it('says what was taken for motor currents and their peaks, biggest first, so a miss can be spotted from the names', () => {
    const lines = robotGraphLines(
      parsed({
        robot: [
          { log: 'a', name: 'Phoenix6/TalonFX-1/StatorCurrent', group: 'Phoenix6/TalonFX-1', short: 'StatorCurrent', kind: 'current', label: 'TalonFX 1 · Stator', arr: arr(5, 80, NaN) },
          { log: 'a', name: 'Phoenix6/TalonFX-2/StatorCurrent', group: 'Phoenix6/TalonFX-2', short: 'StatorCurrent', kind: 'current', label: 'TalonFX 2 · Stator', arr: arr(5, 120) },
          { log: 'a', name: 'Phoenix6/TalonFX-2/Position', group: 'Phoenix6/TalonFX-2', short: 'Position', kind: 'other', arr: arr(1, 2) },
        ],
      }),
    );
    expect(lines[0]).toBe('robot signals on the graphs: 3 · 2 taken for motor currents');
    expect(lines[1]).toBe('  TalonFX 2 · Stator | Phoenix6/TalonFX-2/StatorCurrent | peak 120.0 A');
    expect(lines[2]).toContain('TalonFX 1 · Stator');
    expect(lines).toHaveLength(3);
  });

  it('names the robot logs that are not on the graphs and why', () => {
    const lines = robotGraphLines(
      parsed({
        extras: [
          { name: 'rio.hoot.wpilog', ok: true, decoded: true, alignment: { confidence: 'none', detail: 'no shared messages, enabled periods or clock to go by', offset: 0, tried: {} } },
          { name: 'ok.wpilog', ok: true, decoded: true, alignment: { confidence: 'high', detail: '', offset: 3, tried: {} } },
          { name: 'kept.hoot', ok: true, decoded: false },
        ],
      }),
    );
    expect(lines).toEqual(['robot signals on the graphs: 0', 'not on the graphs: rio.hoot.wpilog: no shared messages, enabled periods or clock to go by']);
  });
});
