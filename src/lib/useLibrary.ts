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
import { matchesForSpan, type Candidate } from './aggregate';
import { HOOT_HELP } from './extras';
import {
  fileKind,
  fileRefFromFile,
  mergeEntries,
  pairFiles,
  summaryKeyOf,
  type ExtraFile,
  type ExtraKind,
  type FileRef,
  type LogEntry,
  type SourceKind,
} from './library';
import { getSettings } from './settings';
import { probeExtras, summarizeLog } from './workerClient';

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

/** A log attached to a match, as remembered between visits. The bytes sit in the `files` store under `name`. */
interface SavedExtra extends SavedMeta {
  kind: ExtraKind;
}

/** What happened to files offered to `attachExtras`. */
export interface AttachResult {
  /** Logs that were added, with the matches they went to. */
  attached: { name: string; keys: string[] }[];
  /** Logs that cannot be used, and why. */
  rejected: { name: string; reason: string }[];
  /** Readable logs that could not be matched to any match (no clock to go by). */
  unplaced: string[];
}

const POLL_MS = 2000;
const LIVE_SUMMARY_MIN_MS = 10000;
const SAMPLE_NAME = '2026_05_16 11_38_21 Sat';
/** Bump when LogSummary gains fields, so cached summaries are recomputed. */
const SUMMARY_VERSION = 3;

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

function extraRef(meta: SavedMeta): FileRef {
  return savedRef(meta);
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

  // Logs attached to matches, by match key. Kept apart from the entries so they survive a folder rescan.
  const attachments = useRef(new Map<string, ExtraFile[]>());

  const setEntries = useCallback((fn: (m: Map<string, LogEntry>) => Map<string, LogEntry>) => {
    let next = fn(entriesRef.current);
    let copied = false;
    for (const [key, e] of next) {
      const x = attachments.current.get(key);
      if (e.extras === x) continue;
      if (!copied) (next = new Map(next), (copied = true));
      next.set(key, { ...e, extras: x });
    }
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

  /** Writes what is attached to which match, and deletes stored files nothing refers to any more. */
  const saveAttachments = useCallback(async (dropped: string[] = []) => {
    try {
      const out: Record<string, SavedExtra[]> = {};
      const inUse = new Set<string>();
      for (const [key, list] of attachments.current) {
        if (entriesRef.current.get(key)?.source === 'sample') continue; // the sample is not saved, so nothing attached to it is either
        out[key] = list.map((x) => ({ kind: x.kind, name: x.file.name, size: x.file.size, mtime: x.file.mtime }));
        list.forEach((x) => inUse.add(x.file.name));
      }
      await idb.set('kv', 'attachments', out);
      for (const name of dropped) if (!inUse.has(name)) await idb.del('files', name);
    } catch {
      /* browser storage unavailable: attachments stay for this visit only */
    }
  }, []);

  /**
   * Adds roboRIO / CTRE logs to matches. With a `target` they all go to that match. Without one, each log goes to
   * every match its own clock says it covers (a run of robot code can span several DS logs).
   */
  const attachExtras = useCallback(
    async (files: File[], target?: string): Promise<AttachResult> => {
      const result: AttachResult = { attached: [], rejected: [], unplaced: [] };
      const wanted: File[] = [];
      for (const f of files) {
        const kind = fileKind(f.name);
        if (kind === 'hoot') result.rejected.push({ name: f.name, reason: HOOT_HELP });
        else if (kind === 'wpilog') wanted.push(f);
      }
      if (!wanted.length) return result;

      // Look inside each log first: refuses unreadable ones and finds the matches a clock puts it in.
      const payloads = await Promise.all(wanted.map(async (f) => ({ name: f.name, kind: 'wpilog' as const, data: await f.arrayBuffer() })));
      const probed = await probeExtras(payloads.map((p) => ({ ...p, data: p.data.slice(0) })));
      if (!target) {
        // a match dropped together with its robot log is still being read, and its length is needed to place the log
        const deadline = Date.now() + 8000;
        const reading = () => [...entriesRef.current.values()].some((e) => (e.dslog || e.dsevents) && e.summaryKey !== summaryKeyOf(e) && !e.summaryError);
        while (reading() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      }
      const candidates: Candidate[] = [...entriesRef.current.values()]
        .filter((e) => e.summary && e.summary.startTime > 0)
        .map((e) => ({ key: e.key, startUnix: e.summary!.startTime, duration: e.summary!.duration }));

      const saved = getSettings().persistUploads;
      for (const [i, f] of wanted.entries()) {
        const info = probed[i];
        if (!info?.ok) {
          result.rejected.push({ name: f.name, reason: info?.error ?? 'Could not read this file.' });
          continue;
        }
        const keys = target ? [target] : matchesForSpan(info.clock, candidates);
        if (!keys.length) {
          result.unplaced.push(f.name);
          continue;
        }
        let ref = fileRefFromFile(f);
        if (saved) {
          try {
            await idb.set('files', f.name, payloads[i].data);
            ref = extraRef({ name: f.name, size: f.size, mtime: f.lastModified });
          } catch {
            optsRef.current.onError('Could not save the log offline', 'Browser storage is full or unavailable. It is attached for this visit only.');
          }
        }
        for (const key of keys) {
          // adding a log with the same name again replaces the earlier copy
          const list = (attachments.current.get(key) ?? []).filter((x) => x.file.name !== f.name);
          attachments.current.set(key, [...list, { kind: 'wpilog', file: ref }]);
        }
        result.attached.push({ name: f.name, keys });
      }
      setEntries((cur) => new Map(cur));
      if (saved) await saveAttachments();
      return result;
    },
    [setEntries, saveAttachments],
  );

  /** Takes one attached log off a match. */
  const detachExtra = useCallback(
    async (key: string, name: string) => {
      const rest = (attachments.current.get(key) ?? []).filter((x) => x.file.name !== name);
      if (rest.length) attachments.current.set(key, rest);
      else attachments.current.delete(key);
      setEntries((cur) => new Map(cur));
      await saveAttachments([name]);
    },
    [setEntries, saveAttachments],
  );

  const removeEntry = useCallback(
    async (key: string) => {
      const e = entriesRef.current.get(key);
      const dropped = (attachments.current.get(key) ?? []).map((x) => x.file.name);
      attachments.current.delete(key);
      setEntries((cur) => {
        const next = new Map(cur);
        next.delete(key);
        return next;
      });
      if (dropped.length) await saveAttachments(dropped);
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
    await idb.set('kv', 'attachments', {});
    attachments.current.clear();
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
      const remembered = (await idb.get<Record<string, SavedExtra[]>>('kv', 'attachments')) ?? {};
      for (const [key, list] of Object.entries(remembered))
        attachments.current.set(key, list.map((m) => ({ kind: m.kind, file: extraRef(m) })));
      if (!cancelled && (index.length || attachments.current.size))
        setEntries((cur) => mergeEntries(cur, pairFiles(index.map(savedRef), 'saved')));
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
    const pending = [...entries.values()].filter((e) => e.summaryKey !== summaryKeyOf(e) && !e.summaryError);
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
    const vkey = summaryKeyOf(next);
    inFlight.current.add(vkey);
    lastRun.current.set(next.key, now);
    (async () => {
      let summary: LogSummary | undefined;
      let error: string | undefined;
      const cacheable = next.source !== 'sample' && next.source !== 'upload';
      const cacheKey = `${vkey}#${SUMMARY_VERSION}`;
      try {
        summary = cacheable ? await idb.get<LogSummary>('summaries', cacheKey) : undefined;
        if (!summary) {
          const [a, b] = await Promise.all([next.dslog?.read(), next.dsevents?.read()]);
          summary = await summarizeLog(a, b);
          if (cacheable) await idb.set('summaries', cacheKey, summary).catch(() => undefined);
        }
      } catch (err) {
        error = String((err as Error).message ?? err);
      }
      inFlight.current.delete(vkey);
      setEntries((cur) => {
        const e = cur.get(next.key);
        if (!e) return new Map(cur);
        const m = new Map(cur);
        if (summaryKeyOf(e) === vkey) m.set(e.key, { ...e, summary: summary ?? e.summary, summaryKey: vkey, summaryError: error });
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
    attachExtras,
    detachExtra,
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
