// Client for the optional companion server (server/companion.mjs) that runs on the DS laptop.
import type { FileRef } from './library';

export interface CompanionInfo {
  name: string;
  dir: string;
  version: string;
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
