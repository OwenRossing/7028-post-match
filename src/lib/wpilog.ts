// Decoder for WPILib DataLog files (.wpilog): what the roboRIO writes when robot code uses
// DataLogManager, and what CTRE's Owlet produces from a Phoenix 6 .hoot file.
//
// Layout (all integers little-endian):
//   header   "WPILOG", u16 version (0x0100), u32 extra-header length, extra-header string
//   record   1 byte: bits 0-1 entry-id length-1, bits 2-3 payload-size length-1, bits 4-6 timestamp length-1
//            entry id (1-4 bytes), payload size (1-4), timestamp in microseconds (1-8), payload
//   entry 0 holds control records: payload byte 0 = 0 start / 1 finish / 2 set metadata
//            start: u32 id, then name, type, metadata as (u32 length + UTF-8)

export type WPILogKind = 'number' | 'boolean' | 'string' | 'array' | 'raw';

export interface WPILogEntry {
  id: number;
  name: string;
  /** The type string the robot code declared: "double", "boolean", "string[]", "struct:Pose2d", … */
  type: string;
  metadata: string;
  kind: WPILogKind;
  /** Seconds, on the log's own clock. */
  start: number;
  end?: number;
  /** Number of data records. */
  count: number;
}

export interface WPILogSeries {
  /** Seconds, on the log's own clock. */
  t: Float64Array;
  /** Numbers as is, booleans as 0/1. */
  v: Float64Array;
}

export interface WPILogText {
  t: number;
  text: string;
}

export interface WPILog {
  version: number;
  extraHeader: string;
  entries: WPILogEntry[];
  /** Numeric and boolean entries by name. */
  series: Map<string, WPILogSeries>;
  /** String and JSON entries by name. */
  text: Map<string, WPILogText[]>;
  /** Timestamp of the first and last record, seconds. */
  first: number;
  last: number;
  /** The file ended in the middle of a record (still being written). */
  truncated: boolean;
  /** Records that could not be decoded and were skipped. */
  skipped: number;
}

const MAGIC = 'WPILOG';
const decoder = new TextDecoder('utf-8');

const KIND: Record<string, WPILogKind> = {
  boolean: 'boolean',
  int64: 'number',
  float: 'number',
  double: 'number',
  string: 'string',
  json: 'string',
  'boolean[]': 'array',
  'int64[]': 'array',
  'float[]': 'array',
  'double[]': 'array',
  'string[]': 'array',
};

export function kindOf(type: string): WPILogKind {
  return KIND[type] ?? 'raw';
}

/** Unsigned little-endian integer of 1-8 bytes (exact up to 2^53, far beyond any microsecond timestamp). */
function readUInt(view: DataView, at: number, len: number): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < len; i++) {
    const b = view.getUint8(at + i);
    if (i < 4) lo += b * 2 ** (8 * i);
    else hi += b * 2 ** (8 * (i - 4));
  }
  return lo + hi * 2 ** 32;
}

export function isWPILog(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

export interface WPILogOptions {
  /** Return false to count an entry's records without storing its values. */
  keep?: (name: string, type: string) => boolean;
}

interface Live {
  entry: WPILogEntry;
  t: number[];
  v: number[];
  text: WPILogText[];
}

export function parseWPILog(bytes: Uint8Array, opts: WPILogOptions = {}): WPILog {
  if (!isWPILog(bytes)) throw new Error('Not a WPILib data log (.wpilog): the file does not start with "WPILOG"');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(6, true);
  if (version >> 8 !== 1) throw new Error(`Unsupported .wpilog version ${version >> 8}.${version & 0xff}`);
  const extraLen = view.getUint32(8, true);
  if (12 + extraLen > bytes.length) throw new Error('The .wpilog header is cut off');
  const extraHeader = decoder.decode(bytes.subarray(12, 12 + extraLen));

  const live = new Map<number, Live>();
  const all: Live[] = [];
  let pos = 12 + extraLen;
  let first = Infinity;
  let last = -Infinity;
  let truncated = false;
  let skipped = 0;

  const str = (at: number, end: number): [string, number] | null => {
    if (at + 4 > end) return null;
    const n = view.getUint32(at, true);
    if (at + 4 + n > end) return null;
    return [decoder.decode(bytes.subarray(at + 4, at + 4 + n)), at + 4 + n];
  };

  while (pos < bytes.length) {
    const flags = bytes[pos];
    const idLen = (flags & 3) + 1;
    const sizeLen = ((flags >> 2) & 3) + 1;
    const tsLen = ((flags >> 4) & 7) + 1;
    const head = 1 + idLen + sizeLen + tsLen;
    if (pos + head > bytes.length) {
      truncated = true;
      break;
    }
    const id = readUInt(view, pos + 1, idLen);
    const size = readUInt(view, pos + 1 + idLen, sizeLen);
    const ts = readUInt(view, pos + 1 + idLen + sizeLen, tsLen) / 1e6;
    const p0 = pos + head;
    const p1 = p0 + size;
    if (p1 > bytes.length) {
      truncated = true;
      break;
    }
    pos = p1;
    if (ts < first) first = ts;
    if (ts > last) last = ts;

    if (id === 0) {
      const ctl = size > 0 ? bytes[p0] : -1;
      if (ctl === 0 && size >= 5) {
        const eid = view.getUint32(p0 + 1, true);
        const name = str(p0 + 5, p1);
        const type = name && str(name[1], p1);
        const meta = type && str(type[1], p1);
        if (!name || !type || !meta) {
          skipped++;
          continue;
        }
        const entry: WPILogEntry = { id: eid, name: name[0], type: type[0], metadata: meta[0], kind: kindOf(type[0]), start: ts, count: 0 };
        const l: Live = { entry, t: [], v: [], text: [] };
        live.set(eid, l);
        all.push(l);
      } else if (ctl === 1 && size >= 5) {
        const l = live.get(view.getUint32(p0 + 1, true));
        if (l) l.entry.end = ts;
      } else if (ctl === 2 && size >= 5) {
        const l = live.get(view.getUint32(p0 + 1, true));
        const meta = str(p0 + 5, p1);
        if (l && meta) l.entry.metadata = meta[0];
      } else skipped++;
      continue;
    }

    const l = live.get(id);
    if (!l) {
      skipped++;
      continue;
    }
    const e = l.entry;
    e.count++;
    if (opts.keep && !opts.keep(e.name, e.type)) continue;
    switch (e.type) {
      case 'boolean':
        if (size >= 1) (l.t.push(ts), l.v.push(bytes[p0] ? 1 : 0));
        break;
      case 'int64':
        if (size >= 8) (l.t.push(ts), l.v.push(Number(view.getBigInt64(p0, true))));
        break;
      case 'float':
        if (size >= 4) (l.t.push(ts), l.v.push(view.getFloat32(p0, true)));
        break;
      case 'double':
        if (size >= 8) (l.t.push(ts), l.v.push(view.getFloat64(p0, true)));
        break;
      case 'string':
      case 'json':
        l.text.push({ t: ts, text: decoder.decode(bytes.subarray(p0, p1)) });
        break;
      default:
        break; // arrays, structs, protobuf and raw bytes are counted but not stored
    }
  }

  const series = new Map<string, WPILogSeries>();
  const text = new Map<string, WPILogText[]>();
  for (const l of all) {
    // A name can be started more than once (a restarted entry): keep them together.
    if (l.t.length) {
      const prev = series.get(l.entry.name);
      const t = prev ? Float64Array.from([...prev.t, ...l.t]) : Float64Array.from(l.t);
      const v = prev ? Float64Array.from([...prev.v, ...l.v]) : Float64Array.from(l.v);
      series.set(l.entry.name, { t, v });
    }
    if (l.text.length) text.set(l.entry.name, [...(text.get(l.entry.name) ?? []), ...l.text]);
  }
  const hasData = Number.isFinite(first);
  return {
    version,
    extraHeader,
    entries: all.map((l) => l.entry),
    series,
    text,
    first: hasData ? first : 0,
    last: hasData ? last : 0,
    truncated,
    skipped,
  };
}

// ---------- Finding the things the analysis needs ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const ENABLED_NAMES = ['DS:enabled', 'DriverStation/Enabled', 'NT:/AdvantageKit/DriverStation/Enabled', 'AdvantageKit/DriverStation/Enabled'];
// The Driver Station publishes the field's match info under /FMSInfo; DataLogManager logs it as "NT:/FMSInfo/...".
const FMS_EVENT = ['NT:/FMSInfo/EventName', 'FMSInfo/EventName', 'NT:/AdvantageKit/DriverStation/EventName'];
const FMS_NUMBER = ['NT:/FMSInfo/MatchNumber', 'FMSInfo/MatchNumber', 'NT:/AdvantageKit/DriverStation/MatchNumber'];
const FMS_TYPE = ['NT:/FMSInfo/MatchType', 'FMSInfo/MatchType', 'NT:/AdvantageKit/DriverStation/MatchType'];
const ANCHORS = new Set([...ENABLED_NAMES, ...FMS_EVENT, ...FMS_NUMBER, ...FMS_TYPE, 'systemTime', 'messages'].map(norm));

/** Entries that lining a log up needs. Passed to `parseWPILog` as `keep` to avoid holding every signal in memory. */
export const keepAnchors = (name: string) => ANCHORS.has(norm(name));

/** Looks an entry up by its name, ignoring case and punctuation, e.g. "DS:enabled" == "/DriverStation/Enabled". */
export function findSeries(log: WPILog, ...names: string[]): WPILogSeries | undefined {
  const want = new Set(names.map(norm));
  for (const [name, s] of log.series) if (want.has(norm(name))) return s;
  return undefined;
}

/** Windows (log seconds) where the robot was enabled, from the DS data DataLogManager records. */
export function enabledWindows(log: WPILog): { start: number; end: number }[] {
  const s = findSeries(log, ...ENABLED_NAMES);
  if (!s) return [];
  const out: { start: number; end: number }[] = [];
  let begin: number | null = null;
  for (let i = 0; i < s.t.length; i++) {
    if (s.v[i] > 0.5 && begin == null) begin = s.t[i];
    else if (s.v[i] <= 0.5 && begin != null) {
      out.push({ start: begin, end: s.t[i] });
      begin = null;
    }
  }
  if (begin != null) out.push({ start: begin, end: log.last });
  return out;
}

/** The console lines DataLogManager captured (entry "messages"), with their log time. */
export function consoleLines(log: WPILog): WPILogText[] {
  for (const [name, lines] of log.text) if (norm(name) === 'messages') return lines;
  return [];
}

/**
 * The robot's wall clock, when the log carries it: DataLogManager writes "systemTime" (int64, microseconds
 * since 1970) once the Driver Station has set the roboRIO's clock. Returns the offset to add to log seconds
 * to get Unix seconds, or undefined.
 */
export function clockOffset(log: WPILog): number | undefined {
  const s = findSeries(log, 'systemTime');
  if (!s || !s.t.length) return undefined;
  // The first reading after the clock was set; earlier ones can be the roboRIO's unset 1970 clock.
  for (let i = 0; i < s.t.length; i++) {
    const unix = s.v[i] / 1e6;
    if (unix > 1.4e9) return unix - s.t[i];
  }
  return undefined;
}

// ---------- Which match is this? ----------

export type MatchKind = 'practice' | 'qualification' | 'elimination';

/** A match as the field names it. The same identity on two logs means they are of the same match. */
export interface MatchId {
  /** FMS event code, when known ("MNST"). */
  event?: string;
  type: MatchKind;
  number: number;
}

export const MATCH_LABEL: Record<MatchKind, string> = { practice: 'Practice', qualification: 'Qualification', elimination: 'Playoff' };

export function matchLabel(id: MatchId): string {
  return `${MATCH_LABEL[id.type]} ${id.number}`;
}

export function sameMatch(a: MatchId, b: MatchId): boolean {
  return a.type === b.type && a.number === b.number && (!a.event || !b.event || a.event.toLowerCase() === b.event.toLowerCase());
}

/** "Qualification", "practice", "Elimination" … to a kind. */
export function matchKindOf(name: string): MatchKind | undefined {
  const n = name.trim().toLowerCase();
  if (n.startsWith('pract')) return 'practice';
  if (n.startsWith('qual') || n === 'q') return 'qualification';
  if (n.startsWith('elim') || n.startsWith('play') || n === 'e') return 'elimination';
  if (n === 'p') return 'practice';
  return undefined;
}

/**
 * The matches the field said this log was running: from the FMSInfo entries (MatchType 1 = practice,
 * 2 = qualification, 3 = elimination), one per match number seen, in the order they came.
 */
export function matchIds(log: WPILog): MatchId[] {
  const numbers = findSeries(log, ...FMS_NUMBER);
  const types = findSeries(log, ...FMS_TYPE);
  if (!numbers || !types) return [];
  let event: string | undefined;
  for (const [name, lines] of log.text) if (FMS_EVENT.some((n) => norm(n) === norm(name))) event = [...lines].reverse().find((l) => l.text.trim())?.text.trim() || event;
  const out: MatchId[] = [];
  for (let i = 0; i < numbers.t.length; i++) {
    const number = numbers.v[i];
    if (!(number > 0)) continue;
    let code = 0;
    for (let j = 0; j < types.t.length && types.t[j] <= numbers.t[i] + 0.5; j++) code = types.v[j];
    const type = ({ 1: 'practice', 2: 'qualification', 3: 'elimination' } as Record<number, MatchKind>)[code];
    if (type && !out.some((m) => m.type === type && m.number === number)) out.push({ event, type, number });
  }
  return out;
}

/**
 * What a robot log's file name says. DataLogManager names logs FRC_yyyyMMdd_HHmmss and, once the field has told it
 * which match this is, adds _EVENT_q22 (p practice, q qualification, e elimination). The time is the roboRIO's clock,
 * which is UTC unless it was set otherwise.
 */
export function fileStamp(name: string): { unix: number; id?: MatchId } | undefined {
  const m = /FRC_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_([A-Za-z0-9]+?)_([pqe])(\d+))?(?:\D|$)/i.exec(name.replace(/^.*[\/\\]/, ''));
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const unix = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  const type = m[8] ? matchKindOf(m[8]) : undefined;
  return { unix, id: type ? { event: m[7], type, number: Number(m[9]) } : undefined };
}
