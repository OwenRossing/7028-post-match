import { useEffect, useState } from 'react';
import type { ExtraInfo } from './extras';
import { versionKey, type LogEntry } from './library';
import { probeExtras } from './workerClient';

const cache = new Map<string, Promise<ExtraInfo[]>>();

/** What is inside a match's robot logs, for a match that has no Driver Station log to read (so nothing is lined up). */
export function useProbe(entry: LogEntry): ExtraInfo[] | null {
  const key = versionKey(entry);
  const [info, setInfo] = useState<ExtraInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    let p = cache.get(key);
    if (!p) {
      p = Promise.all(
        (entry.extras ?? []).map(async (x) =>
          x.kind === 'hoot' && x.hoot ? { name: x.file.name, kind: x.kind, data: new ArrayBuffer(0), hoot: x.hoot } : { name: x.file.name, kind: x.kind, data: await x.file.read() },
        ),
      ).then(probeExtras);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
      while (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    p.then((r) => !cancelled && setInfo(r), () => !cancelled && setInfo([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return info;
}
