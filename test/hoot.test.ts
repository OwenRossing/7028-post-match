import { describe, expect, it } from 'vitest';
import { hootName, hootProbeLines, probeHoot } from '../src/lib/hoot';

const enc = new TextEncoder();

/** Something shaped like a structured binary log: a text header, a table of names, then repetitive records. */
function structured(): Uint8Array {
  const parts: number[] = [...enc.encode('HOOT\x01\x00'), 0, 0];
  for (const name of ['TalonFX-1/Position', 'TalonFX-1/StatorCurrent', 'Pigeon2-2/Yaw']) parts.push(...enc.encode(name), 0, 0, 0);
  for (let i = 0; i < 40000; i++) parts.push(i & 0xff, 0, (i >> 8) & 0xff, 0x40, 0, 0, 0, 0);
  return Uint8Array.from(parts);
}

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

describe('probeHoot', () => {
  it('shows the header, the text inside and how repetitive the data is', () => {
    const p = probeHoot(structured(), 'rio_2026-05-16_16-38-21.hoot');
    expect(p.magic).toMatch(/^48 4f 4f 54 01 00 00 00  \|HOOT\.\.\.\.\|$/);
    expect(p.head[0]).toMatch(/^00000000  48 4f 4f 54 01 00 00 00 .* \|HOOT/);
    expect(p.head).toHaveLength(16);
    expect(p.strings.map((s) => s.text)).toEqual(expect.arrayContaining(['TalonFX-1/Position', 'TalonFX-1/StatorCurrent', 'Pigeon2-2/Yaw']));
    expect(p.entropy.middle).toBeLessThan(4); // structured: nowhere near random
    expect(p.zeroFraction).toBeGreaterThan(0.4);
    expect(p.samples).toHaveLength(5);
    expect(p.samples[2].at).toBe(Math.floor(p.size * 0.5));
  });

  it('can tell data that looks compressed or encrypted', () => {
    const p = probeHoot(random(300000), 'x.hoot');
    expect(p.entropy.head).toBeGreaterThan(7.9);
    expect(p.entropy.middle).toBeGreaterThan(7.9);
    expect(p.zeroFraction).toBeLessThan(0.02);
  });

  it('counts repeats and caps the list', () => {
    const b = enc.encode(Array.from({ length: 500 }, (_, i) => `signal-name-${i}\0`).join('') + 'repeated-text\0'.repeat(7));
    const p = probeHoot(b, 'x.hoot');
    expect(p.strings).toHaveLength(300);
    expect(probeHoot(enc.encode('repeated-text\0'.repeat(7)), 'x.hoot').strings).toEqual([{ text: 'repeated-text', count: 7 }]);
  });

  it('copes with tiny and empty files', () => {
    expect(() => probeHoot(new Uint8Array(0), 'e.hoot')).not.toThrow();
    const p = probeHoot(new Uint8Array([1, 2, 3]), 't.hoot');
    expect(p.size).toBe(3);
    expect(p.head).toHaveLength(1);
    expect(p.tail).toHaveLength(1);
  });

  it('writes a readable text summary', () => {
    const text = hootProbeLines(probeHoot(structured(), 'MNST_Q22_rio_2026-05-16.hoot')).join('\n');
    expect(text).toMatch(/\.hoot: \d+ bytes · not decoded/);
    expect(text).toMatch(/name says: device rio · match qualification 22/);
    expect(text).toMatch(/entropy bits\/byte/);
    expect(text).toContain('TalonFX-1/Position | 1');
  });
});

describe('hootName', () => {
  it('keeps the event CTRE puts before the match, so a match number is not mistaken for the same number at another event', () => {
    const n = hootName('MNST_Q22_rio_2026-05-16_16-38-21.hoot');
    expect(n.event).toBe('MNST');
    expect(n.ids).toEqual([{ event: 'MNST', type: 'qualification', number: 22 }]);
    expect(hootName('2026mnst_E3_A1B2C3D4_2026-05-16_16-38-21.hoot').ids).toEqual([{ event: '2026mnst', type: 'elimination', number: 3 }]);
    expect(hootName('rio_Practice_3_2026.hoot').event).toBeUndefined(); // no event named: nothing is invented
    expect(hootName('rio_2026-05-16_16-38-21.hoot').event).toBeUndefined();
  });

  it('reads when the log began from the timestamp in the name', () => {
    const t = Date.UTC(2026, 4, 16, 16, 38, 21) / 1000;
    expect(hootName('rio_2026-05-16_16-38-21.hoot').stamp).toBe(t);
    expect(hootName('MNST_Q22_rio_2026-05-16_16-38-21.hoot').stamp).toBe(t);
    expect(hootName('rio_20260516_163821.hoot').stamp).toBe(t);
    expect(hootName('notes.hoot').stamp).toBeUndefined();
  });

  it('reads the device from the start of the name', () => {
    expect(hootName('rio_2026-05-16_16-38-21.hoot')).toEqual({ device: 'rio', ids: [], stamp: Date.UTC(2026, 4, 16, 16, 38, 21) / 1000 });
    expect(hootName('A1B2C3D4_2026-05-16_16-38-21.hoot').device).toBe('A1B2C3D4');
    expect(hootName('rio_20260516_163821.hoot').device).toBe('rio'); // a compact date is not a serial
  });

  it('reads the match CTRE puts in the name during a field match', () => {
    expect(hootName('MNST_Q22_rio_2026-05-16_16-38-21.hoot').ids).toEqual([{ event: 'MNST', type: 'qualification', number: 22 }]);
    expect(hootName('rio_Practice_3_2026.hoot').ids).toEqual([{ type: 'practice', number: 3 }]);
    expect(hootName('E4_rio.hoot').ids).toEqual([{ type: 'elimination', number: 4 }]);
    expect(hootName('rio_2026-05-16_16-38-21.hoot').ids).toEqual([]);
    expect(hootName('notes.hoot').ids).toEqual([]);
  });
});
