import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/analysis';
import { diagnosticsText } from '../src/lib/diagnostics';
import { parseDSEvents } from '../src/lib/dsevents';
import { parseDSLog } from '../src/lib/dslog';
import type { LogEntry } from '../src/lib/library';

const dir = new URL('../public/sample/', import.meta.url);
const load = (ext: string) => new Uint8Array(readFileSync(new URL(`2026_05_16%2011_38_21%20Sat.${ext}`, dir)));
const ref = (name: string, size: number) => ({ name, size, mtime: 0, read: async () => new ArrayBuffer(0) });

describe('diagnosticsText', () => {
  const log = parseDSLog(load('dslog'));
  const events = parseDSEvents(load('dsevents'), log.startTime);
  const entry: LogEntry = { key: 'k', source: 'sample', startTime: log.startTime, dslog: ref('a.dslog', 10), dsevents: ref('a.dsevents', 20) };

  it('says how the power distribution data was read', () => {
    const text = diagnosticsText(entry, { log, events, analysis: analyze(log, events), extras: [], warnings: [] });
    expect(text).toMatch(/power distribution: rev · CAN id 1 · records by type byte \{.*"33":\d+/);
    expect(text).toMatch(/channels at 1 A or more at some point: 23 of 24/);
    expect(text).toMatch(/connected to the robot: \d+\.\d% of records/);
    expect(text).toMatch(/first record with power data \(#\d+, 47 bytes\): [0-9a-f ]+/);
    expect(text).toContain('a.dslog (10 bytes)');
    // the messages themselves are not included
    expect(text).not.toMatch(/Loop time of/);
  });

  it('copes with a log that has no .dslog', () => {
    const text = diagnosticsText(entry, { log: null, events, analysis: analyze(null, events), extras: [], warnings: [] });
    expect(text).toContain('.dslog: none');
    expect(text).toContain('.dsevents:');
  });

  it('records which type bytes the log carried', () => {
    expect(log.typeBytes[33]).toBeGreaterThan(0);
    expect(Object.values(log.typeBytes).reduce((a, b) => a + b, 0)).toBe(log.count);
    expect(log.pdSample!.bytes).toHaveLength(14 + 33); // base record + REV power distribution block
  });
});
