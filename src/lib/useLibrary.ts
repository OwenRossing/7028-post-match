import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogSummary } from './analysis';
import { convertedNote, listCompanion, listRobot, probeCompanion, robotRef, watchCompanion, type CompanionInfo, type RobotItem, type RobotListing } from './companion';
import {
  folderSupported,
  forgetFolder,
  pickFolder,
  rememberFolder,
  requestFolderPermission,
  savedFolder,
  scanFolder,
} from './folder';
import { desktopBridge } from './desktop';
import { idb } from './idb';
import { planPlacements, robotMatchTitle, type RioAnchors } from './aggregate';
import type { HootProbe } from './hoot';
import {
  candidateOf,
  fileKind,
  fileRefFromFile,
  hasDS,
  mergeEntries,
  pairFiles,
  shortHash,
  summaryKeyOf,
  type ExtraKind,
  type FileRef,
  type LogEntry,
  type SourceKind,
} from './library';
import { planDelete } from './manage';
import { robotKey, RobotLogStore } from './robotLogs';
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

/** What is remembered about a robot-folder file so it need not be read again next visit. */
interface CachedProbe {
  role?: string;
  anchors: RioAnchors;
  startUnix?: number;
  decoded?: boolean;
  hoot?: HootProbe;
}

/** What happened to files offered to `attachExtras`. */
export interface AttachResult {
  /** Logs that were added, with the matches they went to. `created` is a new match started for a log that fit none. */
  attached: { name: string; keys: string[]; created: boolean }[];
  /** Logs that cannot be used, and why. */
  rejected: { name: string; reason: string }[];
}

const POLL_MS = 2000;
const LIVE_SUMMARY_MIN_MS = 10000;
const SAMPLE_NAME = '2026_05_16 11_38_21 Sat';
/** Bump when LogSummary gains fields, so cached summaries are recomputed. */
const SUMMARY_VERSION = 4;

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

export function useLibrary(opts: {
  onNewLog: (e: LogEntry) => void;
  onError: (title: string, msg: string) => void;
  onInfo?: (title: string, msg: string) => void;
}) {
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

  // Robot logs and the matches made only of them. Kept apart from the entries so they survive a folder rescan.
  const store = useRef(new RobotLogStore()).current;

  // Matches from a watched folder that the user deleted. Deleting never touches the folder, so they are hidden instead,
  // and stay hidden through rescans and restarts until shown again.
  const hidden = useRef(new Set<string>()).current;
  const [hiddenMatches, setHiddenMatches] = useState(0);

  const setEntries = useCallback(
    (fn: (m: Map<string, LogEntry>) => Map<string, LogEntry>) => {
      let next = store.applyTo(fn(entriesRef.current));
      if (hidden.size && [...hidden].some((k) => next.has(k))) next = new Map([...next].filter(([k]) => !hidden.has(k)));
      entriesRef.current = next;
      setEntriesState(next);
    },
    [store, hidden],
  );

  const saveHidden = useCallback(async () => {
    setHiddenMatches(hidden.size);
    await idb.set('kv', 'hiddenMatches', [...hidden]).catch(() => undefined);
  }, [hidden]);

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
      // adding a match by hand is asking for it, even if it was deleted from a watched folder before
      if (incoming.some((e) => hidden.delete(e.key))) void saveHidden();
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
    [setEntries, hidden, saveHidden],
  );

  const skipSaving = (key: string) => entriesRef.current.get(key)?.source === 'sample'; // the sample is not saved, so nothing attached to it is either

  /** A match dropped together with its robot log is still being read, and its length is needed to place the log. */
  const waitForIndexing = useCallback(async () => {
    const deadline = Date.now() + 8000;
    const reading = () => [...entriesRef.current.values()].some((e) => hasDS(e) && e.summaryKey !== summaryKeyOf(e) && !e.summaryError);
    while (reading() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
  }, []);

  /**
   * Adds roboRIO / CTRE logs. With a `target` they all go to that match. Without one, each log goes to the matches it
   * fits (the field's own name for the match, the two clocks, or what happened); a log that fits none starts a new
   * match of its own, which takes the Driver Station log when that turns up.
   */
  const attachExtras = useCallback(
    async (files: File[], target?: string): Promise<AttachResult> => {
      const result: AttachResult = { attached: [], rejected: [] };
      const wanted = files.filter((f) => fileKind(f.name) === 'wpilog' || fileKind(f.name) === 'hoot');
      if (!wanted.length) return result;

      // Look inside each log first: refuses unreadable ones and gets what is needed to place them.
      const payloads = await Promise.all(
        wanted.map(async (f) => ({ name: f.name, kind: fileKind(f.name) === 'hoot' ? ('hoot' as const) : ('wpilog' as const), data: await f.arrayBuffer() })),
      );
      const probed = await probeExtras(payloads.map((p) => ({ ...p, data: p.data.slice(0) })));
      if (!target) await waitForIndexing();

      const saved = getSettings().persistUploads;
      for (const [i, f] of wanted.entries()) {
        const info = probed[i];
        if (!info?.ok || !info.anchors) {
          result.rejected.push({ name: f.name, reason: info?.error ?? 'Could not read this file.' });
          continue;
        }
        let file: FileRef = fileRefFromFile(f);
        if (saved) {
          try {
            file = await store.keep(f.name, f.size, f.lastModified, payloads[i].data);
          } catch {
            optsRef.current.onError('Could not save the log offline', 'Browser storage is full or unavailable. It is attached for this visit only.');
          }
        }
        const extra = {
          kind: payloads[i].kind,
          file,
          role: info.role,
          anchors: info.anchors,
          // a log with no time of its own is put in the day its file was written
          startUnix: info.startUnix ?? (payloads[i].kind === 'hoot' ? f.lastModified / 1000 : undefined),
          decoded: info.decoded,
          hoot: info.hoot,
        };

        let keys: string[];
        let created = false;
        if (target) keys = [target];
        else {
          const entries = [...entriesRef.current.values()];
          const cands = [...entries.map(candidateOf), ...store.robotCandidates(entries)].filter((c) => !!c) as NonNullable<ReturnType<typeof candidateOf>>[];
          keys = planPlacements([{ name: f.name, anchors: info.anchors }], cands, () => false, () => false).map((m) => m.key);
          if (!keys.length) {
            // fits nothing: it is a match of its own until a Driver Station log for it arrives
            const key = robotKey(f.name);
            store.addRobotMatch(key, { startTime: info.startUnix ?? f.lastModified / 1000, title: robotMatchTitle(info.anchors.ids, f.name) });
            keys = [key];
            created = true;
          }
        }
        for (const key of keys) store.add(key, extra);
        result.attached.push({ name: f.name, keys, created });
      }
      setEntries((cur) => new Map(cur));
      if (saved) await store.save(skipSaving);
      return result;
    },
    [setEntries, store, waitForIndexing],
  );

  // ---------- Robot logs from the companion's robot-log folder ----------

  const [robot, setRobot] = useState<RobotListing | null>(null);
  const companionUrl = useRef<string | null>(null);
  const robotBusy = useRef(false);
  const robotAgain = useRef(false);
  const robotSeen = useRef(new Set<string>()); // progress and failures already reported
  const robotBad = useRef(new Set<string>()); // files that could not be read: not tried again

  /** Which version of a listed file to attach: the converted .wpilog, or the original of a hoot that could not be converted. */
  // The id says which version and why: a hoot that failed is a different thing to show than one still waiting for Owlet,
  // or one that failed for another reason, and each must replace the last.
  const wantOf = (i: RobotItem): string | null =>
    i.state === 'ready'
      ? `${i.id}:default`
      : i.kind === 'hoot' && (i.state === 'failed' || i.state === 'needs-owlet')
        ? `${i.id}:source:${i.state}${i.error ? `:${shortHash(i.error)}` : ''}`
        : null;

  const attachRemote = useCallback(
    async (url: string, item: RobotItem, remoteId: string) => {
      const which = remoteId.includes(':source') ? 'source' : 'default';
      const kind: ExtraKind = which === 'source' ? 'hoot' : 'wpilog';
      const file = robotRef(url, item, which);
      // what the file looks like does not depend on why it is shown, so one description per file and version
      const probeKey = `probe|${item.id}:${which}|1`;
      let info = await idb.get<CachedProbe>('summaries', probeKey);
      if (!info) {
        const data = await file.read();
        const [r] = await probeExtras([{ name: item.name, kind, data }]);
        if (!r?.ok || !r.anchors) {
          robotBad.current.add(remoteId);
          optsRef.current.onError(`Couldn't read ${item.name}`, r?.error ?? 'The file could not be read.');
          return;
        }
        info = { role: r.role, anchors: r.anchors, startUnix: r.startUnix, decoded: r.decoded, hoot: r.hoot };
        await idb.set('summaries', probeKey, info).catch(() => undefined);
      }
      const note =
        item.state === 'failed'
          ? `Owlet couldn't convert this .hoot: ${item.error ?? 'no reason given'}`
          : item.state === 'needs-owlet'
            ? "This .hoot is waiting for Owlet, which wasn't found. Locate it from the ⋯ menu and it converts by itself."
            : convertedNote(item);
      const extra = { kind, file, role: info.role, anchors: info.anchors, startUnix: info.startUnix ?? item.mtime / 1000, decoded: info.decoded, hoot: info.hoot, remote: true, remoteId, note };
      const entries = [...entriesRef.current.values()];
      const cands = [...entries.map(candidateOf), ...store.robotCandidates(entries)].filter((c) => !!c) as NonNullable<ReturnType<typeof candidateOf>>[];
      let keys = planPlacements([{ name: item.name, anchors: info.anchors }], cands, () => false, (n, k) => store.isDismissed(n, k)).map((m) => m.key);
      if (!keys.length) {
        const key = robotKey(item.name);
        store.addRobotMatch(key, { startTime: extra.startUnix, title: robotMatchTitle(info.anchors.ids, item.name) });
        keys = [key];
      }
      for (const key of keys) store.add(key, extra);
    },
    [store],
  );

  /** Brings the library in line with the robot-log folder: new logs are attached, ones that went away or changed are taken off. */
  const syncRobot = useCallback(
    async (url: string) => {
      if (robotBusy.current) {
        robotAgain.current = true;
        return;
      }
      robotBusy.current = true;
      try {
        do {
          robotAgain.current = false;
          const listing = await listRobot(url);
          setRobot(listing);
          if (!listing) break;
          const keep = new Set(listing.items.map(wantOf).filter((w): w is string => !!w));
          if (store.removeRemoteExcept(keep)) setEntries((cur) => new Map(cur));

          for (const i of listing.items) {
            const sig = `${i.id}:${i.state}${i.error ? `:${shortHash(i.error)}` : ''}`;
            if (robotSeen.current.has(sig)) continue;
            if (i.state === 'converting') optsRef.current.onInfo?.(`Converting ${i.name}`, 'Owlet is turning this .hoot into a .wpilog. It joins its match when it is done.');
            else if (i.state === 'failed') optsRef.current.onError(`Owlet couldn't convert ${i.name}`, i.error ?? 'No reason given.');
            else if (i.state === 'needs-owlet' && !robotSeen.current.has('needs-owlet')) {
              robotSeen.current.add('needs-owlet');
              optsRef.current.onInfo?.(
                'Owlet not found',
                `${i.name} can't be converted until PitView knows where Owlet is. ${desktopBridge() ? 'In the ⋯ menu, use Get Owlet to download it, or Locate Owlet.' : 'Use Locate Owlet in the ⋯ menu.'}`,
              );
            } else continue;
            robotSeen.current.add(sig);
          }

          const todo = listing.items.filter((i) => {
            const w = wantOf(i);
            return w && !robotBad.current.has(w) && !store.hasRemote(w) && !store.isDismissed(i.name, 'remote');
          });
          if (!todo.length) continue;
          await waitForIndexing();
          for (const item of todo) {
            try {
              await attachRemote(url, item, wantOf(item)!);
            } catch (err) {
              robotBad.current.add(wantOf(item)!);
              optsRef.current.onError(`Couldn't read ${item.name}`, String((err as Error).message ?? err));
            }
          }
          setEntries((cur) => new Map(cur));
        } while (robotAgain.current);
      } finally {
        robotBusy.current = false;
      }
    },
    [store, setEntries, waitForIndexing, attachRemote],
  );

  /** Shows robot-folder logs the user hid with Remove. */
  const showHiddenRobotLogs = useCallback(async () => {
    store.showHiddenRemote();
    await store.save(skipSaving);
    if (companionUrl.current) void syncRobot(companionUrl.current);
  }, [store, syncRobot]);

  /** Takes one attached log off a match. */
  const detachExtra = useCallback(
    async (key: string, name: string) => {
      store.remove(key, name);
      setEntries((cur) => new Map(cur));
      await store.save(skipSaving, [name]);
    },
    [setEntries, store],
  );

  // When matches appear (their DS logs have been read), robot logs that belong to them are added, and robot matches that
  // can now join their DS log do so.
  const joinSig = useRef('');
  useEffect(() => {
    const sig = [...entries.values()].map((e) => (candidateOf(e) ? e.key : '')).join('|') + `#${store.known().length}`;
    if (sig === joinSig.current) return;
    joinSig.current = sig;
    const plan = store.joinPlan(entries.values());
    if (!plan.adds.length && !plan.absorbed.length) return;
    const title = (k: string) => entriesRef.current.get(k)?.summary?.title ?? k;
    const gained = store.applyJoin(plan);
    setEntries((cur) => new Map(cur));
    void store.save(skipSaving);
    if (gained.length)
      optsRef.current.onInfo?.(
        gained.length === 1 ? `Robot logs joined ${title(gained[0])}` : `Robot logs joined ${gained.length} matches`,
        [...new Set(plan.adds.map((a) => a.name))].join(', '),
      );
  }, [entries, store, setEntries]);

  /**
   * Deletes matches from the library: saved copies and attached robot logs are removed from this browser, and matches that
   * come from a watched folder are hidden (the folder's files are never touched). Resolves with how many went.
   */
  const deleteEntries = useCallback(
    async (keys: string[]): Promise<number> => {
      const plan = planDelete(entriesRef.current.values(), keys);
      if (!plan.keys.length) return 0;
      for (const k of plan.hide) hidden.add(k);
      const dropped = plan.keys.flatMap((k) => store.dropMatch(k));
      setEntries((cur) => {
        const next = new Map(cur);
        for (const k of plan.keys) next.delete(k);
        return next;
      });
      try {
        await saveHidden();
        await store.save(skipSaving, dropped);
        if (plan.saved.length) {
          const index = ((await idb.get<SavedMeta[]>('kv', 'savedIndex')) ?? []).filter((m) => !plan.saved.includes(m.name));
          await idb.set('kv', 'savedIndex', index);
          for (const n of plan.saved) await idb.del('files', n);
        }
        for (const k of plan.summaryKeys) await idb.del('summaries', `${k}#${SUMMARY_VERSION}`);
      } catch {
        optsRef.current.onError('Could not finish deleting', 'Browser storage was not available. The matches are gone for this visit and may reappear next time.');
      }
      return plan.keys.length;
    },
    [setEntries, store, hidden, saveHidden],
  );

  const removeEntry = useCallback((key: string) => deleteEntries([key]), [deleteEntries]);

  /** Empties the library: everything saved here is removed, and what a watched folder holds now is hidden, so only matches that arrive from now on appear. */
  const clearAll = useCallback(async () => {
    const plan = planDelete(entriesRef.current.values(), [...entriesRef.current.keys()]);
    for (const k of plan.hide) hidden.add(k);
    store.dropAll();
    setEntries(() => new Map());
    try {
      await saveHidden();
      await idb.clear('files');
      await idb.set('kv', 'savedIndex', []);
      await idb.clear('summaries');
      await store.save(skipSaving);
    } catch {
      optsRef.current.onError('Could not finish clearing', 'Browser storage was not available. The library is empty for this visit and may refill next time.');
    }
    return plan.counts.total;
  }, [setEntries, store, hidden, saveHidden]);

  const clearSaved = useCallback(async () => {
    await idb.clear('files');
    await idb.set('kv', 'savedIndex', []);
    await store.clear();
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
      void syncRobot(url).catch(() => undefined);
      const sig = signature(files);
      if (sig === companionSig.current) return;
      const first = companionSig.current === '';
      companionSig.current = sig;
      syncSource('companion', files, announce && !first);
    },
    [syncSource, syncRobot],
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
      companionUrl.current = url;
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
    companionUrl.current = null;
    setCompanion({ status: 'none' });
    store.removeRemoteExcept(new Set());
    setRobot(null);
    setEntries((cur) => new Map([...cur].filter(([, e]) => e.source !== 'companion')));
  }, [setEntries, store]);

  /** Brings back everything that was hidden: matches deleted from watched folders, and robot-folder logs taken off a match. */
  const showHidden = useCallback(async () => {
    hidden.clear();
    await saveHidden();
    store.showHiddenRemote();
    await store.save(skipSaving);
    // read the watched sources again, so what was hidden is listed again
    folderSig.current = '';
    void scanNow(false);
    companionSig.current = '';
    if (companionUrl.current) {
      void refreshCompanion(companionUrl.current, false);
      void syncRobot(companionUrl.current);
    }
  }, [hidden, saveHidden, store, scanNow, refreshCompanion, syncRobot]);

  // ---------- Startup ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const index = (await idb.get<SavedMeta[]>('kv', 'savedIndex')) ?? [];
      await store.load();
      for (const k of (await idb.get<string[]>('kv', 'hiddenMatches')) ?? []) hidden.add(k);
      setHiddenMatches(hidden.size);
      if (!cancelled) setEntries((cur) => mergeEntries(cur, pairFiles(index.map(savedRef), 'saved')));
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
    const pending = [...entries.values()].filter((e) => hasDS(e) && e.summaryKey !== summaryKeyOf(e) && !e.summaryError);
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
    robot,
    hiddenRobotLogs: store.hiddenRemote(),
    hiddenMatches,
    showHiddenRobotLogs,
    showHidden,
    removeEntry,
    deleteEntries,
    clearAll,
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
