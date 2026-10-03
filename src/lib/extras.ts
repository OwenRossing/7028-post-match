// Reading the logs attached to a match: what each one is, what it holds and how it lines up with the DS log.

import { alignWPILog, clockSpan, type Alignment, type DsAnchor } from './aggregate';
import type { ExtraKind } from './library';
import { isWPILog, keepAnchors, parseWPILog, type WPILog, type WPILogKind } from './wpilog';

export interface ExtraSignal {
  name: string;
  type: string;
  kind: WPILogKind;
  count: number;
}

export interface ExtraInfo {
  name: string;
  kind: ExtraKind;
  size: number;
  ok: boolean;
  /** Why it could not be read. */
  error?: string;
  /** "roboRIO", "CTRE Phoenix", … a guess from what is inside, for labelling. */
  role?: string;
  /** Length of the log, seconds. */
  duration?: number;
  /** The log's own wall clock span, Unix seconds, when it has one. */
  clock?: { start: number; end: number };
  truncated?: boolean;
  alignment?: Alignment;
  consoleLines?: number;
  signals?: ExtraSignal[];
}

export const HOOT_HELP =
  'A Phoenix .hoot log has to be converted to .wpilog first (CTRE Owlet, or export from Phoenix Tuner X). Then add the .wpilog.';

/** A best guess at who wrote the log, from the names inside it. */
export function logRole(w: WPILog): string {
  const names = w.entries.map((e) => e.name);
  const has = (re: RegExp) => names.some((n) => re.test(n)) || w.entries.some((e) => re.test(e.metadata));
  if (has(/phoenix|ctre/i)) return 'CTRE Phoenix';
  if (has(/^\/?RealOutputs\//) || has(/^\/?AdvantageKit\//i)) return 'AdvantageKit';
  if (has(/^(DS:|NT:)/) || names.includes('messages')) return 'roboRIO';
  return 'Robot log';
}

function describe(name: string, kind: ExtraKind, size: number, w: WPILog, ds: DsAnchor | null): ExtraInfo {
  const info: ExtraInfo = {
    name,
    kind,
    size,
    ok: true,
    role: logRole(w),
    duration: Math.max(0, w.last - w.first),
    truncated: w.truncated,
    consoleLines: w.text.get('messages')?.length,
    signals: w.entries
      .map((e) => ({ name: e.name, type: e.type, kind: e.kind, count: e.count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const clock = clockSpan(w);
  if (clock) info.clock = clock;
  if (ds) info.alignment = alignWPILog(w, ds);
  return info;
}

/** Reads one attached log. `ds` is what to line it up against; leave it out to only look inside the file. */
export function describeExtra(name: string, kind: ExtraKind, bytes: ArrayBuffer, ds: DsAnchor | null): ExtraInfo {
  const size = bytes.byteLength;
  if (kind === 'hoot') return { name, kind, size, ok: false, error: HOOT_HELP };
  const u8 = new Uint8Array(bytes);
  if (!isWPILog(u8)) return { name, kind, size, ok: false, error: 'This is not a WPILib data log: it does not start with "WPILOG".' };
  try {
    return describe(name, kind, size, parseWPILog(u8, { keep: keepAnchors }), ds);
  } catch (err) {
    return { name, kind, size, ok: false, error: String((err as Error).message ?? err) };
  }
}
