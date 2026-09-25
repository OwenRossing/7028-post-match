import { describe, expect, it } from 'vitest';
import { analyze, computeStats, findProblems } from '../src/lib/analysis';
import { parseDSEvents } from '../src/lib/dsevents';
import { FLAG, parseDSLog } from '../src/lib/dslog';
import { pairFiles, type FileRef } from '../src/lib/library';

const LV_OFFSET = 2082844800n;

function header(unix: number): number[] {
  const b = new DataView(new ArrayBuffer(20));
  b.setInt32(0, 4);
  b.setBigInt64(4, BigInt(unix) + LV_OFFSET);
  b.setBigUint64(12, 0n);
  return [...new Uint8Array(b.buffer)];
}

interface Rec {
  flags: number; // active-high
  volts?: number; // undefined = no comms
  trip?: number;
  pd?: 'rev' | 'ctre';
  currents?: number[];
}

function record(r: Rec): number[] {
  const b = new DataView(new ArrayBuffer(14));
  b.setUint8(0, Math.round((r.trip ?? 5) * 2));
  b.setInt8(1, 0);
  b.setUint16(2, r.volts === undefined ? 0xffff : Math.round(r.volts * 256));
  b.setUint8(4, 100);
  b.setUint8(5, ~r.flags & 0xff);
  b.setUint8(6, 40);
  b.setUint8(7, 0);
  b.setUint16(8, 0);
  b.setUint8(13, r.pd === 'rev' ? 33 : r.pd === 'ctre' ? 25 : 0);
  const out = [...new Uint8Array(b.buffer)];
  if (r.pd === 'rev') {
    const pd = new Uint8Array(33);
    const v = new DataView(pd.buffer);
    pd[0] = 1; // CAN id
    const cur = r.currents ?? [];
    for (let g = 0; g < 7; g++) {
      let word = 0;
      for (let k = 0; k < 3; k++) {
        const ch = g * 3 + k;
        if (ch < 20) word |= (Math.round((cur[ch] ?? 0) * 8) & 0x3ff) << (k * 10);
      }
      if (g < 6) v.setUint32(1 + g * 4, word >>> 0, true);
      else {
        pd[25] = word & 0xff;
        pd[26] = (word >>> 8) & 0xff;
        pd[27] = (word >>> 16) & 0xff;
      }
    }
    for (let ch = 20; ch < 24; ch++) pd[28 + ch - 20] = Math.round((cur[ch] ?? 0) * 16);
    out.push(...pd);
  } else if (r.pd === 'ctre') {
    const pd = new Uint8Array(25);
    pd[0] = 0; // CAN id
    const cur = r.currents ?? [];
    for (let ch = 0; ch < 16; ch++) {
      const value = Math.round((cur[ch] ?? 0) * 8) & 0x3ff;
      const bit0 = Math.floor(ch / 6) * 64 + (ch % 6) * 10;
      for (let b = 0; b < 10; b++) {
        if ((value >> (9 - b)) & 1) {
          const p = bit0 + b;
          pd[1 + (p >> 3)] |= 1 << (7 - (p & 7));
        }
      }
    }
    out.push(...pd);
  }
  return out;
}

const TELEOP = FLAG.DS_TELEOP | FLAG.ROBOT_TELEOP;
const AUTO = FLAG.DS_AUTO | FLAG.ROBOT_AUTO;
const DISABLED = FLAG.DS_DISABLED | FLAG.ROBOT_DISABLED;

describe('dslog decoding (synthetic)', () => {
  it('decodes REV PDH currents, including the 4 small channels', () => {
    const currents = Array.from({ length: 24 }, (_, i) => (i < 20 ? i * 2.5 + 0.125 : i / 16));
    const bytes = new Uint8Array([...header(1_700_000_000), ...record({ flags: TELEOP, volts: 12.5, pd: 'rev', currents })]);
    const log = parseDSLog(bytes);
    expect(log.count).toBe(1);
    expect(log.pdType).toBe('rev');
    expect(log.voltage[0]).toBeCloseTo(12.5, 2);
    for (let ch = 0; ch < 24; ch++) expect(log.currents[ch][0]).toBeCloseTo(currents[ch], 3);
  });

  it('decodes CTRE PDP currents packed most-significant-bit first', () => {
    const currents = Array.from({ length: 16 }, (_, i) => i * 7.25);
    const bytes = new Uint8Array([...header(1_700_000_000), ...record({ flags: TELEOP, volts: 12, pd: 'ctre', currents })]);
    const log = parseDSLog(bytes);
    expect(log.pdType).toBe('ctre');
    expect(log.channelCount).toBe(16);
    for (let ch = 0; ch < 16; ch++) expect(log.currents[ch][0]).toBeCloseTo(currents[ch], 3);
  });

  it('handles mixed record sizes and a partially written last record', () => {
    const recs = [
      ...record({ flags: FLAG.DS_DISABLED }), // no comms, no PD
      ...record({ flags: DISABLED, volts: 12.9, pd: 'rev' }),
      ...record({ flags: TELEOP, volts: 11.8, pd: 'rev', currents: [10] }),
    ];
    const partial = record({ flags: TELEOP, volts: 11, pd: 'rev' }).slice(0, 20);
    const log = parseDSLog(new Uint8Array([...header(1_700_000_000), ...recs, ...partial]));
    expect(log.count).toBe(3);
    expect(log.truncated).toBe(true);
    expect(log.comms[0]).toBe(0);
    expect(Number.isNaN(log.voltage[0])).toBe(true);
    expect(Number.isNaN(log.currents[0][0])).toBe(true);
    expect(log.currents[0][2]).toBeCloseTo(10, 3);
  });

  it('rejects old v3 logs with a helpful message', () => {
    const bytes = new Uint8Array(header(0));
    new DataView(bytes.buffer).setInt32(0, 3);
    expect(() => parseDSLog(bytes)).toThrow(/v3/);
  });
});

describe('analysis (synthetic)', () => {
  // 3 s disabled, 15 s auto, 1 s disabled, 30 s teleop with a 0.5 s comms drop, 2 s disabled.
  const recs: number[] = [];
  const push = (n: number, r: Rec) => {
    for (let i = 0; i < n; i++) recs.push(...record(r));
  };
  push(150, { flags: DISABLED, volts: 12.6 });
  push(750, { flags: AUTO, volts: 11.5 });
  push(50, { flags: DISABLED, volts: 12.2 });
  push(700, { flags: TELEOP, volts: 10.5 });
  push(25, { flags: FLAG.DS_DISABLED }); // comms lost mid-teleop
  push(775, { flags: TELEOP, volts: 6.5 }); // deep sag
  push(5, { flags: TELEOP | FLAG.BROWNOUT, volts: 6.4 });
  push(100, { flags: DISABLED, volts: 12.1 });
  const log = parseDSLog(new Uint8Array([...header(1_700_000_000), ...recs]));
  const analysis = analyze(log, null);
  const stats = computeStats(log, null, analysis, analysis.focus);
  const ids = findProblems(log, null, analysis, stats).map((p) => p.id);

  it('merges auto and teleop into one practice match', () => {
    expect(analysis.runs.length).toBe(1);
    expect(analysis.match?.label).toMatch(/Practice match/);
    expect(analysis.match!.autoTime).toBeCloseTo(15, 1);
  });

  it('counts a comms drop during teleop as an enabled drop', () => {
    expect(stats.comms.enabledDrops).toBe(1);
    expect(stats.comms.dropTime).toBeCloseTo(0.5, 2);
    expect(ids).toContain('comms-enabled');
  });

  it('flags the brownout and the sag', () => {
    expect(stats.brownouts.count).toBe(1);
    expect(ids).toContain('brownout');
    expect(ids).toContain('volt-low');
    expect(stats.voltage.resting).toBeCloseTo(12.6, 1);
  });
});

describe('dsevents parsing (synthetic)', () => {
  function eventsFile(texts: string[]): Uint8Array {
    const parts: number[] = [...header(1_700_000_000)];
    texts.forEach((t, i) => {
      const enc = new TextEncoder().encode(t);
      const b = new DataView(new ArrayBuffer(20));
      b.setBigInt64(0, 1_700_000_000n + LV_OFFSET + BigInt(i));
      b.setBigUint64(8, 0n);
      b.setInt32(16, enc.length);
      parts.push(...new Uint8Array(b.buffer), ...enc);
    });
    return new Uint8Array(parts);
  }

  it('splits multi-message records, orders them and classifies them', () => {
    const file = parseDSEvents(
      eventsFile([
        'FMS Connected:   Playoff - 7:2, Field Time: 26/4/1 12:00:00\n -- FRC Driver Station - Version 26.0',
        '<TagVersion>1 <time> 00:12.500 <message> second <TagVersion>1 <time> 00:12.400 <message> first ',
        '<TagVersion>1 <time> 00:13.000 <count> 1 <flags> 1 <Code> -1003 <details> CAN frame not received <location> talon fx 4 ("canivore") Status Signal Position <stack> ',
        '<TagVersion>1 <time> 00:14.000 <count> 1 <flags> 0 <Code> 1 <details> \tFoo.periodic(): 0.050000s\n\tBar.periodic(): 0.001000s <location> edu.wpi.first.wpilibj.Tracer <stack> ',
        'Info roboRIO-1234-FRC connected',
      ]),
    );
    const texts = file.events.map((e) => e.text);
    expect(texts.indexOf('first')).toBeLessThan(texts.indexOf('second'));
    expect(file.meta.fms).toMatchObject({ matchType: 'Playoff', matchNumber: 7, replay: 2 });
    expect(file.meta.team).toBe(1234);
    const can = file.events.find((e) => e.code === -1003)!;
    expect(can.kind).toBe('error');
    expect(can.tags).toContain('can');
    const tracer = file.events.find((e) => e.tags.includes('tracer'))!;
    expect(tracer.kind).toBe('warning');
    const analysis = analyze(null, file);
    expect(analysis.loopCulprits[0]).toMatchObject({ name: 'Foo.periodic()', worst: 0.05 });
    expect(analysis.canDevices[0].device).toMatch(/talon fx 4/);
  });
});

describe('library pairing', () => {
  it('pairs files by name and reads the start time from the name', () => {
    const ref = (name: string): FileRef => ({ name, size: 1, mtime: 0, read: async () => new ArrayBuffer(0) });
    const entries = pairFiles(
      [ref('2026_03_07 09_15_02 Sat.dslog'), ref('2026_03_07 09_15_02 Sat.dsevents'), ref('notes.txt'), ref('2026_03_07 10_00_00 Sat.dslog')],
      'upload',
    );
    expect(entries.length).toBe(2);
    const first = entries.find((e) => e.key === '2026_03_07 09_15_02 Sat')!;
    expect(first.dslog && first.dsevents).toBeTruthy();
    expect(new Date(first.startTime * 1000).getHours()).toBe(9);
  });
});
