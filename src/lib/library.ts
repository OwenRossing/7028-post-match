import type { LogSummary } from './analysis';
import { parseLogName } from './time';

export type SourceKind = 'folder' | 'companion' | 'saved' | 'upload' | 'sample';

export interface FileRef {
  name: string;
  size: number;
  mtime: number;
  read: () => Promise<ArrayBuffer>;
}

export interface LogEntry {
  key: string;
  source: SourceKind;
  dslog?: FileRef;
  dsevents?: FileRef;
  /** Unix seconds, from the file name (local time) or the file's modified time. */
  startTime: number;
  summary?: LogSummary;
  summaryKey?: string;
  summaryError?: string;
}

const SOURCE_RANK: Record<SourceKind, number> = { folder: 0, companion: 1, saved: 2, upload: 3, sample: 4 };

export function isLogFile(name: string): boolean {
  return /\.(dslog|dsevents)$/i.test(name);
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

/** Identifies a specific version of an entry's files (changes when a live log grows). */
export function versionKey(e: LogEntry): string {
  const f = (r?: FileRef) => (r ? `${r.size}@${r.mtime}` : '-');
  return `${e.key}|${f(e.dslog)}|${f(e.dsevents)}`;
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
      if (versionKey(merged) === cur.summaryKey) {
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
