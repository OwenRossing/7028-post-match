// Client for the optional companion server (server/companion.mjs) that runs on the DS laptop.
import type { FileRef } from './library';
import { fmtSpan } from './time';

export interface CompanionInfo {
  name: string;
  dir: string;
  version: string;
  /** Older companions have no robot-log folder. */
  robot?: boolean;
  /** The desktop app is running it. */
  desktop?: boolean;
}

export type RobotState = 'ready' | 'queued' | 'converting' | 'failed' | 'needs-owlet';

/** A .wpilog or .hoot in the companion's robot-log folder. A hoot is `ready` once Owlet has converted it. */
export interface RobotItem {
  id: string;
  name: string;
  path: string;
  kind: 'wpilog' | 'hoot';
  size: number;
  mtime: number;
  state: RobotState;
  /** Owlet's own words when it failed. */
  error?: string;
  /** For a hoot Owlet converted: what the whole converted .wpilog was read back and found to hold. */
  converted?: { signals: number; records: number; seconds: number; bytes: number; /** Anything Owlet printed. */ said?: string };
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * What to tell the user about a hoot Owlet converted: that what it wrote was read back from start to end, how much
 * came out, what Owlet itself said, and why signals might still be missing (CTRE's licensing, which is theirs to enforce).
 */
export function convertedNote(item: RobotItem): string | undefined {
  const c = item.converted;
  if (item.kind !== 'hoot' || item.state !== 'ready' || !c) return undefined;
  const lines = [`Converted from the .hoot by Owlet. The .wpilog it wrote was read back from start to end and is complete: ${plural(c.signals, 'signal')} over ${fmtSpan(c.seconds)}.`];
  if (c.said) lines.push(`Owlet said: ${c.said}`);
  lines.push(
    "CTRE exports only the signals your device licences allow, and its licence check reads just the start of a long log unless a Deep Scan is run (Phoenix Tuner X has one). If a signal you expect is missing, that is the likely reason.",
  );
  return lines.join('\n');
}

export interface RobotListing {
  dir: string | null;
  owlet: { path: string | null; configured: string | null; found: boolean };
  items: RobotItem[];
}

function join(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

export async function probeCompanion(base: string, timeoutMs = 1500): Promise<CompanionInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(join(base, '/api/info'), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    return info?.name === 'pitview-companion' ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function listCompanion(base: string): Promise<FileRef[]> {
  const res = await fetch(join(base, '/api/logs'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Companion returned ${res.status}`);
  const files: { name: string; path: string; size: number; mtime: number }[] = await res.json();
  return files.map((f) => ({
    name: f.name,
    size: f.size,
    mtime: f.mtime,
    read: async () => {
      const r = await fetch(join(base, `/api/file?path=${encodeURIComponent(f.path)}`), { cache: 'no-store' });
      if (!r.ok) throw new Error(`Could not download ${f.name}`);
      return r.arrayBuffer();
    },
  }));
}

/** Calls onChange whenever the companion sees the log folder change. Returns an unsubscribe function. */
export function watchCompanion(base: string, onChange: () => void): () => void {
  const es = new EventSource(join(base, '/api/watch'));
  es.addEventListener('change', onChange);
  return () => es.close();
}

/** The robot-log folder, or null when the companion is too old to have one. */
export async function listRobot(base: string): Promise<RobotListing | null> {
  const res = await fetch(join(base, '/api/robot'), { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

/** A robot-folder file read from the companion each time: the converted .wpilog (or the .wpilog itself), or with `source` the original. */
export function robotRef(base: string, item: RobotItem, which: 'default' | 'source' = 'default'): FileRef {
  return {
    name: item.name,
    size: item.size,
    mtime: item.mtime,
    read: async () => {
      const r = await fetch(join(base, `/api/robot/file?id=${encodeURIComponent(item.id)}${which === 'source' ? '&which=source' : ''}`), { cache: 'no-store' });
      if (!r.ok) throw new Error(`Could not download ${item.name}`);
      return r.arrayBuffer();
    },
  };
}
