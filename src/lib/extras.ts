// Reading the logs attached to a match: what each one is, what it holds and how it lines up with the DS log.

import { alignAnchors, clockSpan, rioAnchors, type Alignment, type DsAnchor, type RioAnchors } from './aggregate';
import { probeHoot, type HootProbe } from './hoot';
import type { ExtraKind } from './library';
import { fileStamp, isWPILog, keepAnchors, parseWPILog, type WPILog, type WPILogKind } from './wpilog';

export interface ExtraSignal {
  name: string;
  type: string;
  kind: WPILogKind;
  count: number;
  /** What the logger said about the signal (units, source), shortened. */
  metadata?: string;
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
  /** Unix seconds of the first time the robot was enabled, else the log's start: where this log sits in the day. */
  startUnix?: number;
  /** What it takes to place this log on a match later. Kept with the log. */
  anchors?: RioAnchors;
  /** False for a log that was kept but cannot be read yet (a .hoot). */
  decoded?: boolean;
  /** For a .hoot: a description of the file, enough to work out its layout. */
  hoot?: HootProbe;
  /** Shown on the log's card. */
  note?: string;
  alignment?: Alignment;
  consoleLines?: number;
  signals?: ExtraSignal[];
}

export const HOOT_HELP =
  'A Phoenix .hoot log has to be converted to .wpilog first (CTRE Owlet, or export from Phoenix Tuner X). Then add the .wpilog.';

export const HOOT_NOTE =
  "This .hoot is saved with the match, but PitView can't read its signals yet: CTRE doesn't publish the format. Press Copy hoot diagnostics and paste the text to work out the layout. Or convert it to .wpilog (CTRE Owlet, or Phoenix Tuner X) and add that.";

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
      .map((e) => ({ name: e.name, type: e.type, kind: e.kind, count: e.count, metadata: e.metadata ? e.metadata.slice(0, 160) : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const clock = clockSpan(w);
  if (clock) info.clock = clock;
  const anchors = rioAnchors(w, name);
  info.anchors = anchors;
  const firstEnabled = anchors.enabled[0];
  if (anchors.clockOffset != null) info.startUnix = (firstEnabled ? firstEnabled.start : w.first) + anchors.clockOffset;
  else info.startUnix = fileStamp(name)?.unix;
  if (ds) info.alignment = alignAnchors(anchors, ds);
  return info;
}

/**
 * Reads one attached log. `ds` is what to line it up against; leave it out to only look inside the file. A .hoot is
 * only described (see hoot.ts); `known` is its description from when it was added, so the file need not be read again.
 */
export function describeExtra(name: string, kind: ExtraKind, bytes: ArrayBuffer, ds: DsAnchor | null, known?: HootProbe): ExtraInfo {
  if (kind === 'hoot') {
    const probe = known ?? probeHoot(new Uint8Array(bytes), name);
    return {
      name,
      kind,
      size: probe.size,
      ok: true,
      decoded: false,
      role: 'CTRE Phoenix',
      note: HOOT_NOTE,
      hoot: probe,
      // all there is to place it by is the match CTRE put in the name, if it did
      anchors: { first: 0, last: 0, enabled: [], lines: [], ids: probe.name.ids },
      signals: [],
    };
  }
  const size = bytes.byteLength;
  const u8 = new Uint8Array(bytes);
  if (!isWPILog(u8)) return { name, kind, size, ok: false, error: 'This is not a WPILib data log: it does not start with "WPILOG".' };
  try {
    return describe(name, kind, size, parseWPILog(u8, { keep: keepAnchors }), ds);
  } catch (err) {
    return { name, kind, size, ok: false, error: String((err as Error).message ?? err) };
  }
}
