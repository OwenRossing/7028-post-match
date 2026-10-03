// CTRE Phoenix signal logs (.hoot). The layout is not published, so this does NOT decode them. It describes a file
// well enough (header bytes, readable text, how compressed it looks) that its layout can be worked out from a short
// text summary, without having to send the file. Once the layout is known, a decoder goes here.

import { matchKindOf, type MatchId } from './wpilog';

export interface HootName {
  /** "rio" or the CANivore serial the log came from, when the name starts with one. */
  device?: string;
  /** The event the name says it was recorded at (CTRE puts the event, then the match, at the start of the name during a field match). */
  event?: string;
  /** The match the name says it was recorded in. Only the match it started in: a log runs on through the ones after it. */
  ids: MatchId[];
  /** When the name says the log began, Unix seconds, read as UTC like the roboRIO's own clock (see `RioAnchors.stamp`). */
  stamp?: number;
}

export interface HootProbe {
  size: number;
  /** First 8 bytes: hex and text. */
  magic: string;
  /** Hex dump of the first 256 bytes. */
  head: string[];
  /** Hex dump of the last 64 bytes. */
  tail: string[];
  /** 48 bytes from the file at 10, 30, 50, 70 and 90 percent. */
  samples: { at: number; hex: string }[];
  /** Bits per byte (8 = looks random, such as compressed or encrypted data; low = structured). */
  entropy: { head: number; middle: number; tail: number };
  /** Fraction of zero bytes in the first 64 KB. */
  zeroFraction: number;
  /** Readable text runs of 6+ characters, in order of first appearance, with how often each occurs. */
  strings: { text: string; count: number }[];
  name: HootName;
}

const WINDOW = 65536;

const WORD_KIND = /^(practice|qualification|qual|qualifier|elimination|playoff|playoffs)$/i;

/** What a hoot's file name says. CTRE starts it with the CANivore serial or "rio" and a timestamp, and during a field match renames it to start with the event, match type and number. */
export function hootName(fileName: string): HootName {
  const base = fileName.replace(/^.*[/\\]/, '').replace(/\.(hoot|wpilog)$/i, '');
  const tokens = base.split(/[_\-. ]+/).filter(Boolean);
  const when = /(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})-(\d{2})-(\d{2})/.exec(base) ?? /(\d{4})(\d{2})(\d{2})[_T](\d{2})(\d{2})(\d{2})/.exec(base);
  const stamp = when ? Date.UTC(+when[1], +when[2] - 1, +when[3], +when[4], +when[5], +when[6]) / 1000 : undefined;
  const isSerial = (t: string) => /^[0-9a-f]{6,}$/i.test(t) && /[a-f]/i.test(t); // hex with a letter: not a date like 20260516
  const isDevice = (t: string) => /^rio$/i.test(t) || isSerial(t);
  const device = tokens.find(isDevice);
  const ids: MatchId[] = [];
  let event: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const compact = /^([pqe])(\d{1,3})$/i.exec(tokens[i]);
    const word = WORD_KIND.exec(tokens[i]);
    const kind = compact ? matchKindOf(compact[1]) : word ? matchKindOf(word[1]) : undefined;
    const number = compact ? Number(compact[2]) : word && /^\d{1,3}$/.test(tokens[i + 1] ?? '') ? Number(tokens[i + 1]) : undefined;
    if (!kind || number == null) continue;
    // what comes before the match, up to the device, is the event ("MNST_Q22_rio_…")
    if (!ids.length) event = tokens.slice(0, i).filter((t) => !isDevice(t) && /^[A-Za-z0-9]+$/.test(t) && !/^\d{8}$/.test(t)).join('_') || undefined;
    if (!ids.some((m) => m.type === kind && m.number === number)) ids.push({ ...(event ? { event } : {}), type: kind, number });
  }
  return { device, event, ids, stamp };
}

function entropy(b: Uint8Array): number {
  if (!b.length) return 0;
  const counts = new Float64Array(256);
  for (let i = 0; i < b.length; i++) counts[b[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (!counts[i]) continue;
    const p = counts[i] / b.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function dump(b: Uint8Array, base: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const row = b.subarray(i, i + 16);
    const text = [...row].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${hex(row).padEnd(47)}  |${text}|`);
  }
  return lines;
}

/** Readable runs of ASCII, in the order they first appear. */
function strings(b: Uint8Array, limit = 300): { text: string; count: number }[] {
  const seen = new Map<string, number>();
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i] : 0;
    if (c >= 0x20 && c < 0x7f) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 6) {
        const t = String.fromCharCode(...b.subarray(start, Math.min(i, start + 80)));
        if (seen.has(t)) seen.set(t, seen.get(t)! + 1);
        else if (seen.size < 2000) seen.set(t, 1);
      }
      start = -1;
    }
  }
  return [...seen].slice(0, limit).map(([text, count]) => ({ text, count }));
}

export function probeHoot(bytes: Uint8Array, fileName: string): HootProbe {
  const n = bytes.length;
  const mid = Math.max(0, Math.floor(n / 2) - WINDOW / 2);
  return {
    size: n,
    magic: `${hex(bytes.subarray(0, 8))}  |${[...bytes.subarray(0, 8)].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('')}|`,
    head: dump(bytes.subarray(0, 256), 0),
    tail: dump(bytes.subarray(Math.max(0, n - 64)), Math.max(0, n - 64)),
    samples: [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => {
      const at = Math.floor(n * f);
      return { at, hex: hex(bytes.subarray(at, at + 48)) };
    }),
    entropy: {
      head: entropy(bytes.subarray(0, WINDOW)),
      middle: entropy(bytes.subarray(mid, mid + WINDOW)),
      tail: entropy(bytes.subarray(Math.max(0, n - WINDOW))),
    },
    zeroFraction: bytes.subarray(0, WINDOW).reduce((a, x) => a + (x === 0 ? 1 : 0), 0) / Math.max(1, Math.min(n, WINDOW)),
    strings: strings(bytes),
    name: hootName(fileName),
  };
}

/** The probe as plain text, for pasting. */
export function hootProbeLines(p: HootProbe, maxStrings = 300): string[] {
  const out = [
    `  .hoot: ${p.size} bytes · not decoded (the layout is not published)`,
    `  name says: device ${p.name.device ?? '?'} · match ${p.name.ids.length ? p.name.ids.map((m) => `${m.type} ${m.number}`).join(', ') : 'none'}`,
    `  first bytes: ${p.magic}`,
    `  entropy bits/byte (8 = looks compressed or encrypted): start ${p.entropy.head.toFixed(2)} · middle ${p.entropy.middle.toFixed(2)} · end ${p.entropy.tail.toFixed(2)} · zero bytes in the first 64 KB: ${(100 * p.zeroFraction).toFixed(1)}%`,
    '  first 256 bytes:',
    ...p.head.map((l) => `    ${l}`),
    '  samples through the file (offset: 48 bytes):',
    ...p.samples.map((s) => `    ${s.at}: ${s.hex}`),
    '  last 64 bytes:',
    ...p.tail.map((l) => `    ${l}`),
    `  readable text (${p.strings.length} runs${p.strings.length > maxStrings ? `, first ${maxStrings}` : ''}; text | times seen):`,
    ...p.strings.slice(0, maxStrings).map((s) => `    ${s.text} | ${s.count}`),
  ];
  return out;
}
