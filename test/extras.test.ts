import { describe, expect, it } from 'vitest';
import type { DsAnchor } from '../src/lib/aggregate';
import { describeExtra, HOOT_NOTE, logRole } from '../src/lib/extras';
import { probeHoot } from '../src/lib/hoot';
import { parseWPILog } from '../src/lib/wpilog';
import { WPILogWriter } from './helpers/wpilog-writer';

const buf = (w: WPILogWriter) => w.bytes().buffer.slice(0) as ArrayBuffer;

function roboRio() {
  const w = new WPILogWriter();
  const e = w.start('DS:enabled', 'boolean', 0);
  const m = w.start('messages', 'string', 0);
  const v = w.start('NT:/SmartDashboard/flywheel/rpm', 'double', 0);
  const big = w.start('NT:/Pose', 'struct:Pose2d', 0);
  w.boolean(e, 10, true);
  w.boolean(e, 25, false);
  w.string(m, 11, 'Auto selected: two piece left\n');
  w.double(v, 12, 4800);
  w.raw(big, 12, [1, 2, 3]);
  return w;
}

describe('describeExtra', () => {
  it('lists signals and labels the log without needing the DS side', () => {
    const info = describeExtra('FRC_1.wpilog', 'wpilog', buf(roboRio()), null);
    expect(info.ok).toBe(true);
    expect(info.role).toBe('roboRIO');
    expect(info.signals!.map((s) => s.name)).toEqual(['DS:enabled', 'messages', 'NT:/Pose', 'NT:/SmartDashboard/flywheel/rpm']);
    expect(info.signals!.find((s) => s.name === 'NT:/Pose')).toMatchObject({ kind: 'raw', count: 1 });
    expect(info.consoleLines).toBe(1);
    expect(info.duration).toBeCloseTo(25, 6);
    expect(info.alignment).toBeUndefined();
  });

  it('lines the log up when given the DS side', () => {
    const ds: DsAnchor = { duration: 60, enabled: [{ start: 3, end: 18 }], messages: [] }; // robot log is 7 s ahead
    const info = describeExtra('FRC_1.wpilog', 'wpilog', buf(roboRio()), ds);
    expect(info.alignment!.method).toBe('enabled');
    expect(info.alignment!.offset).toBeCloseTo(-7, 6);
  });

  it('keeps a .hoot and describes it instead of guessing at its contents', () => {
    const bytes = new TextEncoder().encode('HOOT\0\0\0\0TalonFX-1/Position\0\0\0').buffer as ArrayBuffer;
    const info = describeExtra('MNST_Q22_rio_2026.hoot', 'hoot', bytes, null);
    expect(info).toMatchObject({ ok: true, decoded: false, role: 'CTRE Phoenix', note: HOOT_NOTE, signals: [] });
    expect(info.hoot!.strings.map((s) => s.text)).toContain('TalonFX-1/Position');
    expect(HOOT_NOTE).toMatch(/Owlet/);
    // the only thing to place it by is the match CTRE put in the name
    expect(info.anchors!.ids).toEqual([{ type: 'qualification', number: 22 }]);
  });

  it('does not read a .hoot again once it has been described', () => {
    const known = probeHoot(new TextEncoder().encode('some hoot bytes here, long enough'), 'x.hoot');
    const info = describeExtra('x.hoot', 'hoot', new ArrayBuffer(0), null, known);
    expect(info.hoot).toBe(known);
    expect(info.size).toBe(known.size);
  });

  it('refuses files that are not wpilogs', () => {
    const info = describeExtra('x.wpilog', 'wpilog', new TextEncoder().encode('hello hello hello').buffer as ArrayBuffer, null);
    expect(info.ok).toBe(false);
    expect(info.error).toMatch(/WPILOG/);
  });

  it('reports a log that is still being written', () => {
    const bytes = roboRio().bytes();
    const info = describeExtra('live.wpilog', 'wpilog', bytes.subarray(0, bytes.length - 2).slice().buffer as ArrayBuffer, null);
    expect(info.ok).toBe(true);
    expect(info.truncated).toBe(true);
  });
});

describe('logRole', () => {
  const role = (setup: (w: WPILogWriter) => void) => {
    const w = new WPILogWriter();
    setup(w);
    return logRole(parseWPILog(w.bytes()));
  };
  it('recognises where a log came from', () => {
    expect(role((w) => w.start('Phoenix6/TalonFX-3/Position', 'double'))).toBe('CTRE Phoenix');
    expect(role((w) => w.start('x', 'double', 0, '{"source":"Phoenix 6"}'))).toBe('CTRE Phoenix');
    expect(role((w) => w.start('/RealOutputs/Drive/Pose', 'double'))).toBe('AdvantageKit');
    expect(role((w) => w.start('messages', 'string'))).toBe('roboRIO');
    expect(role((w) => w.start('something', 'double'))).toBe('Robot log');
  });
});
