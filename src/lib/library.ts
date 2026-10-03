import type { LogSummary } from './analysis';
import { parseLogName } from './time';

export type SourceKind = 'folder' | 'companion' | 'saved' | 'upload' | 'sample';

export interface FileRef {
  name: string;
  size: number;
  mtime: number;
  read: () => Promise<ArrayBuffer>;
}

/** Logs from outside the Driver Station that can be added to a match. A .hoot has to be converted to .wpilog first. */
export type ExtraKind = 'wpilog' | 'hoot';

export interface ExtraFile {
  kind: ExtraKind;
  file: FileRef;
}

/**
 * One match and everything known about it. The Driver Station's .dslog/.dsevents give it its identity (the key);
 * roboRIO and CTRE logs are attached to it, now or any time later, and are read together with them.
 */
export interface LogEntry {
  key: string;
  source: SourceKind;
  dslog?: FileRef;
  dsevents?: FileRef;
  /** Attached logs, oldest first. Kept apart from the DS files: they survive the DS folder being rescanned. */
  extras?: ExtraFile[];
  /** Unix seconds, from the file name (local time) or the file's modified time. */
  startTime: number;
  summary?: LogSummary;
  summaryKey?: string;
  summaryError?: string;
}

const SOURCE_RANK: Record<SourceKind, number> = { folder: 0, companion: 1, saved: 2, upload: 3, sample: 4 };

/** A Driver Station file: what gives a match its name. */
export function isLogFile(name: string): boolean {
  return /\.(dslog|dsevents)$/i.test(name);
}

/** What a dropped file is, by its extension. */
export function fileKind(name: string): 'ds' | ExtraKind | null {
  if (isLogFile(name)) return 'ds';
  if (/\.wpilog$/i.test(name)) return 'wpilog';
  if (/\.hoot$/i.test(name)) return 'hoot';
  return null;
}

export function baseName(name: string): string {
  return name.replace(/^.*[\/]/, '').replace(/\.(dslog|dsevents)$/i, '');
}

/** Groups .dslog/.dsevents files that share a base name into entries. */
export function pairFiles(files: FileRef[], source: SourceKind): LogEntry[] {
  const map = new Map<string, LogEntry>();
  for (const f of files) {
    if (!isLogFile(f.name)) continue;
    const key = baseName(f.name);
    const entry = map.get(key) ?? { key, source, startTime: parseLogName(key) ?? f.mtime / 1000 };
    if (/\.dslog$/i.test(f.name)) entry.dslog = f;
    else entry.dsevents = f;
    map.set(key, entry);
  }
  return [...map.values()];
}

export function fileRefFromFile(file: File): FileRef {
  return { name: file.name, size: file.size, mtime: file.lastModified, read: () => file.arrayBuffer() };
}

const fileSig = (r?: FileRef) => (r ? `${r.size}@${r.mtime}` : '-');

/** Identifies the Driver Station files of an entry (changes when a live log grows). Library summaries are keyed by this. */
export function summaryKeyOf(e: LogEntry): string {
  return `${e.key}|${fileSig(e.dslog)}|${fileSig(e.dsevents)}`;
}

/** Identifies everything read for an entry: the DS files and every attached log. Parsed data is cached under this. */
export function versionKey(e: LogEntry): string {
  const x = (e.extras ?? []).map((a) => `${a.file.name}:${fileSig(a.file)}`).join(',');
  return x ? `${summaryKeyOf(e)}|${x}` : summaryKeyOf(e);
}

/**
 * Merges incoming entries into the library. A higher priority source (a watched folder) replaces a
 * lower one; the same source replaces itself, and missing halves of a pair are filled in.
 */
export function mergeEntries(current: Map<string, LogEntry>, incoming: LogEntry[]): Map<string, LogEntry> {
  const next = new Map(current);
  for (const inc of incoming) {
    const cur = next.get(inc.key);
    if (!cur) {
      next.set(inc.key, inc);
      continue;
    }
    if (SOURCE_RANK[inc.source] <= SOURCE_RANK[cur.source]) {
      const merged: LogEntry = {
        ...cur,
        ...inc,
        dslog: inc.dslog ?? cur.dslog,
        dsevents: inc.dsevents ?? cur.dsevents,
      };
      if (summaryKeyOf(merged) === cur.summaryKey) {
        merged.summary = cur.summary;
        merged.summaryKey = cur.summaryKey;
      } else {
        merged.summary = cur.summary; // keep showing the old summary until the new one lands
        merged.summaryKey = undefined;
      }
      next.set(inc.key, merged);
    } else if ((!cur.dslog && inc.dslog) || (!cur.dsevents && inc.dsevents)) {
      next.set(inc.key, { ...cur, dslog: cur.dslog ?? inc.dslog, dsevents: cur.dsevents ?? inc.dsevents, summaryKey: undefined });
    }
  }
  return next;
}

export function sortEntries(entries: Iterable<LogEntry>): LogEntry[] {
  return [...entries].sort((a, b) => b.startTime - a.startTime);
}

export function sourceLabel(s: SourceKind): string {
  return { folder: 'DS folder', companion: 'Companion', saved: 'Saved', upload: 'Opened', sample: 'Sample' }[s];
}
