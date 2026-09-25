import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogSummary } from './analysis';
import { listCompanion, probeCompanion, watchCompanion, type CompanionInfo } from './companion';
import {
  folderSupported,
  forgetFolder,
  pickFolder,
  rememberFolder,
  requestFolderPermission,
  savedFolder,
  scanFolder,
} from './folder';
import { idb } from './idb';
import {
  fileRefFromFile,
  mergeEntries,
  pairFiles,
  versionKey,
  type FileRef,
  type LogEntry,
  type SourceKind,
} from './library';
import { getSettings } from './settings';
import { summarizeLog } from './workerClient';

export interface FolderState {
  status: 'none' | 'unsupported' | 'needs-permission' | 'connected' | 'error';
  name?: string;
  error?: string;
}

export interface CompanionState {
  status: 'none' | 'connecting' | 'connected' | 'error';
  url?: string;
  info?: CompanionInfo;
  error?: string;
}

interface SavedMeta {
  name: string;
  size: number;
  mtime: number;
}

const POLL_MS = 2000;
const LIVE_SUMMARY_MIN_MS = 10000;
const SAMPLE_NAME = '2026_05_16 11_38_21 Sat';

function savedRef(meta: SavedMeta): FileRef {
  return {
    ...meta,
    read: async () => {
      const data = await idb.get<ArrayBuffer>('files', meta.name);
      if (!data) throw new Error(`${meta.name} is no longer saved in this browser`);
      return data;
    },
  };
}

function signature(files: FileRef[]): string {
  return files
    .map((f) => `${f.name}:${f.size}:${f.mtime}`)
    .sort()
    .join('|');
}

export function useLibrary(opts: { onNewLog: (e: LogEntry) => void; onError: (title: string, msg: string) => void }) {
  const [entries, setEntriesState] = useState<Map<string, LogEntry>>(new Map());
  const entriesRef = useRef(entries);
  const [folder, setFolder] = useState<FolderState>({ status: folderSupported() ? 'none' : 'unsupported' });
  const [companion, setCompanion] = useState<CompanionState>({ status: 'none' });
  const [indexing, setIndexing] = useState(0);
  const [ready, setReady] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const folderHandle = useRef<FileSystemDirectoryHandle | null>(null);
  const folderSig = useRef('');
  const companionSig = useRef('');
  const stopCompanion = useRef<(() => void) | null>(null);

  const setEntries = useCallback((fn: (m: Map<string, LogEntry>) => Map<string, LogEntry>) => {
    const next = fn(entriesRef.current);
    entriesRef.current = next;
    setEntriesState(next);
  }, []);

  /** Replaces every entry of one source with a fresh listing, reporting brand new logs. */
  const syncSource = useCallback(
    (source: SourceKind, files: FileRef[], announce: boolean) => {
      const incoming = pairFiles(files, source);
      const before = new Set(entriesRef.current.keys());
      setEntries((cur) => {
        const kept = new Map([...cur].filter(([key, e]) => e.source !== source || incoming.some((i) => i.key === key)));
        return mergeEntries(kept, incoming);
      });
      if (announce) {
        const fresh = incoming.filter((e) => !before.has(e.key) && e.dslog).sort((a, b) => b.startTime - a.startTime);
        if (fresh.length) optsRef.current.onNewLog(entriesRef.current.get(fresh[0].key) ?? fresh[0]);
      }
    },
    [setEntries],
  );

  // ---------- Uploads ----------

  const addFiles = useCallback(
    async (files: File[]): Promise<LogEntry[]> => {
      const refs = files.map(fileRefFromFile);
      const incoming = pairFiles(refs, 'upload');
      if (!incoming.length) return [];
      setEntries((cur) => mergeEntries(cur, incoming));
      if (getSettings().persistUploads) {
        try {
          const index = (await idb.get<SavedMeta[]>('kv', 'savedIndex')) ?? [];
          for (const f of files) {
            await idb.set('files', f.name, await f.arrayBuffer());
            const meta = { name: f.name, size: f.size, mtime: f.lastModified };
            const i = index.findIndex((m) => m.name === f.name);
            if (i >= 0) index[i] = meta;
            else index.push(meta);
          }
          await idb.set('kv', 'savedIndex', index);
        } catch {
          optsRef.current.onError('Could not save logs offline', 'Browser storage is full or unavailable. The logs are still open.');
        }
      }
      return incoming.map((e) => entriesRef.current.get(e.key) ?? e);
    },
    [setEntries],
  );

  const removeEntry = useCallback(
    async (key: string) => {
      const e = entriesRef.current.get(key);
      setEntries((cur) => {
        const next = new Map(cur);
        next.delete(key);
        return next;
      });
      if (e && (e.source === 'saved' || e.source === 'upload')) {
        const names = [e.dslog?.name, e.dsevents?.name].filter(Boolean) as string[];
        const index = ((await idb.get<SavedMeta[]>('kv', 'savedIndex')) ?? []).filter((m) => !names.includes(m.name));
        await idb.set('kv', 'savedIndex', index);
        for (const n of names) await idb.del('files', n);
      }
    },
    [setEntries],
  );

  const clearSaved = useCallback(async () => {
    await idb.clear('files');
    await idb.set('kv', 'savedIndex', []);
    await idb.clear('summaries');
    setEntries((cur) => new Map([...cur].filter(([, e]) => e.source !== 'saved' && e.source !== 'upload')));
  }, [setEntries]);

  const loadSample = useCallback(async (): Promise<LogEntry | null> => {
    const make = (ext: string): FileRef => ({
      name: `${SAMPLE_NAME}.${ext}`,
      size: 0,
      mtime: 0,
      read: async () => {
        const res = await fetch(`./sample/${encodeURIComponent(`${SAMPLE_NAME}.${ext}`)}`);
        if (!res.ok) throw new Error('Sample log not found');
        return res.arrayBuffer();
      },
    });
    const [entry] = pairFiles([make('dslog'), make('dsevents')], 'sample');
    setEntries((cur) => mergeEntries(cur, [entry]));
    return entriesRef.current.get(entry.key) ?? entry;
  }, [setEntries]);

  // ---------- DS folder ----------

  const scanNow = useCallback(
    async (announce: boolean) => {
      const dir = folderHandle.current;
      if (!dir) return;
      try {
        const files = await scanFolder(dir);
        const sig = signature(files);
        if (sig === folderSig.current) return;
        const first = folderSig.current === '';
        folderSig.current = sig;
        syncSource('folder', files, announce && !first);
      } catch (err) {
        setFolder({ status: 'error', name: dir.name, error: String((err as Error).message ?? err) });
        folderHandle.current = null;
      }
    },
    [syncSource],
  );

  const startWatching = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      folderHandle.current = handle;
      folderSig.current = '';
      setFolder({ status: 'connected', name: handle.name });
      await scanNow(false);
    },
    [scanNow],
  );

  const connectFolder = useCallback(
    async (handle?: FileSystemDirectoryHandle) => {
      try {
        const h = handle ?? (await pickFolder());
        if (handle) {
          await rememberFolder(handle);
          if (!(await requestFolderPermission(handle))) return;
        }
        await startWatching(h);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') optsRef.current.onError('Could not open folder', String((err as Error).message ?? err));
      }
    },
    [startWatching],
  );

  const reconnectFolder = useCallback(async () => {
    const saved = await savedFolder();
    if (!saved) return connectFolder();
    try {
      if (await requestFolderPermission(saved.handle)) await startWatching(saved.handle);
    } catch (err) {
      optsRef.current.onError('Could not reconnect folder', String((err as Error).message ?? err));
    }
  }, [connectFolder, startWatching]);

  const disconnectFolder = useCallback(async () => {
    folderHandle.current = null;
    folderSig.current = '';
    await forgetFolder();
    setFolder({ status: 'none' });
    setEntries((cur) => new Map([...cur].filter(([, e]) => e.source !== 'folder')));
  }, [setEntries]);

  useEffect(() => {
    if (folder.status !== 'connected') return;
    const id = setInterval(() => void scanNow(true), POLL_MS);
    return () => clearInterval(id);
  }, [folder.status, scanNow]);

  // ---------- Companion ----------

  const refreshCompanion = useCallback(
    async (url: string, announce: boolean) => {
      const files = await listCompanion(url);
      const sig = signature(files);
      if (sig === companionSig.current) return;
      const first = companionSig.current === '';
      companionSig.current = sig;
      syncSource('companion', files, announce && !first);
    },
    [syncSource],
  );

  const connectCompanion = useCallback(
    async (url: string, quiet = false) => {
      setCompanion({ status: 'connecting', url });
      const info = await probeCompanion(url);
      if (!info) {
        setCompanion({ status: quiet ? 'none' : 'error', url, error: `No companion server answered at ${url}` });
        return false;
      }
      stopCompanion.current?.();
      companionSig.current = '';
      setCompanion({ status: 'connected', url, info });
      try {
        await refreshCompanion(url, false);
      } catch (err) {
        optsRef.current.onError('Companion error', String((err as Error).message ?? err));
      }
      let timer = 0;
      const unwatch = watchCompanion(url, () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => void refreshCompanion(url, true).catch(() => undefined), 300);
      });
      // Poll as well, in case the event stream is blocked by a proxy.
      const poll = window.setInterval(() => void refreshCompanion(url, true).catch(() => undefined), POLL_MS * 2);
      stopCompanion.current = () => {
        unwatch();
        clearInterval(poll);
        clearTimeout(timer);
      };
      return true;
    },
    [refreshCompanion],
  );

  const disconnectCompanion = useCallback(() => {
    stopCompanion.current?.();
    stopCompanion.current = null;
    companionSig.current = '';
    setCompanion({ status: 'none' });
    setEntries((cur) => new Map([...cur].filter(([, e]) => e.source !== 'companion')));
  }, [setEntries]);

  // ---------- Startup ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const index = (await idb.get<SavedMeta[]>('kv', 'savedIndex')) ?? [];
      if (!cancelled && index.length) setEntries((cur) => mergeEntries(cur, pairFiles(index.map(savedRef), 'saved')));
      if (folderSupported()) {
        const saved = await savedFolder();
        if (!cancelled && saved) {
          if (saved.granted) await startWatching(saved.handle);
          else setFolder({ status: 'needs-permission', name: saved.handle.name });
        }
      }
      // When the app is served by the companion itself, use it automatically.
      const here = new URL('./', location.href).href.replace(/\/$/, '');
      if (!cancelled && location.protocol.startsWith('http')) await connectCompanion(here, true);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      stopCompanion.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Background indexing ----------

  const inFlight = useRef(new Set<string>());
  const lastRun = useRef(new Map<string, number>());
  const queueTimer = useRef(0);

  useEffect(() => {
    const pending = [...entries.values()].filter((e) => e.summaryKey !== versionKey(e) && !e.summaryError);
    setIndexing(pending.length);
    if (!pending.length || inFlight.current.size) return;
    pending.sort((a, b) => b.startTime - a.startTime);
    const now = Date.now();
    const next = pending.find((e) => now - (lastRun.current.get(e.key) ?? 0) > LIVE_SUMMARY_MIN_MS) ?? null;
    if (!next) {
      clearTimeout(queueTimer.current);
      queueTimer.current = window.setTimeout(() => setEntries((m) => new Map(m)), 2000);
      return;
    }
    const vkey = versionKey(next);
    inFlight.current.add(vkey);
    lastRun.current.set(next.key, now);
    (async () => {
      let summary: LogSummary | undefined;
      let error: string | undefined;
      const cacheable = next.source !== 'sample' && next.source !== 'upload';
      try {
        summary = cacheable ? await idb.get<LogSummary>('summaries', vkey) : undefined;
        if (!summary) {
          const [a, b] = await Promise.all([next.dslog?.read(), next.dsevents?.read()]);
          summary = await summarizeLog(a, b);
          if (cacheable) await idb.set('summaries', vkey, summary).catch(() => undefined);
        }
      } catch (err) {
        error = String((err as Error).message ?? err);
      }
      inFlight.current.delete(vkey);
      setEntries((cur) => {
        const e = cur.get(next.key);
        if (!e) return new Map(cur);
        const m = new Map(cur);
        if (versionKey(e) === vkey) m.set(e.key, { ...e, summary: summary ?? e.summary, summaryKey: vkey, summaryError: error });
        return m;
      });
    })();
  }, [entries, setEntries]);

  return {
    entries,
    ready,
    folder,
    companion,
    indexing,
    addFiles,
    removeEntry,
    clearSaved,
    loadSample,
    connectFolder,
    reconnectFolder,
    disconnectFolder,
    rescanFolder: () => scanNow(true),
    connectCompanion,
    disconnectCompanion,
  };
}

export type Library = ReturnType<typeof useLibrary>;
