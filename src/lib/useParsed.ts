import { useEffect, useState } from 'react';
import { versionKey, type LogEntry } from './library';
import { parseLog, type ParsedLog } from './workerClient';

const cache = new Map<string, Promise<ParsedLog>>();
const MAX_CACHED = 8;

export function loadParsed(entry: LogEntry): Promise<ParsedLog> {
  const key = versionKey(entry);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const [a, b, x] = await Promise.all([
        entry.dslog?.read(),
        entry.dsevents?.read(),
        Promise.all((entry.extras ?? []).map(async (e) => ({ name: e.file.name, kind: e.kind, data: await e.file.read() }))),
      ]);
      return parseLog(a, b, x);
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  } else {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, p);
  }
  return p;
}

export interface ParsedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: ParsedLog;
  /** Which entry key the data belongs to. */
  key?: string;
  error?: string;
  /** True while a newer version of the same log (live file) is loading. */
  refreshing?: boolean;
}

export function useParsed(entry: LogEntry | undefined): ParsedState {
  const [state, setState] = useState<ParsedState>({ status: 'idle' });
  const vkey = entry ? versionKey(entry) : '';

  useEffect(() => {
    if (!entry) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState((prev) =>
      prev.key === entry.key && prev.data ? { ...prev, refreshing: true } : { status: 'loading', key: entry.key },
    );
    loadParsed(entry).then(
      (data) => !cancelled && setState({ status: 'ready', data, key: entry.key }),
      (err) =>
        !cancelled &&
        setState((prev) =>
          prev.key === entry.key && prev.data
            ? { ...prev, refreshing: false }
            : { status: 'error', key: entry.key, error: String((err as Error).message ?? err) },
        ),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vkey]);

  return state;
}
