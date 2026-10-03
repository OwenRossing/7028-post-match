import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compare } from './components/Compare';
import { HelpModal } from './components/HelpModal';
import { Icon } from './components/Icon';
import { Library as LibraryPanel } from './components/Library';
import { TopBar } from './components/TopBar';
import { Viewer } from './components/Viewer';
import type { Tab } from './components/viewer/types';
import { Welcome } from './components/Welcome';
import { classifyHistory, usesDemoHistory } from './lib/baseline';
import { desktopBridge } from './lib/desktop';
import { filesFromDrop } from './lib/folder';
import { fileKind, isLogFile, sortEntries, type LogEntry } from './lib/library';
import { updateSettings, useSettings } from './lib/settings';
import { readChartTheme, resolvedDark, type ChartTheme } from './lib/theme';
import { useLibrary } from './lib/useLibrary';
import { useParsed } from './lib/useParsed';

interface Toast {
  id: number;
  title: string;
  msg?: string;
  kind: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export default function App() {
  const settings = useSettings();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('board');
  const [view, setView] = useState<'main' | 'compare'>('main');
  const [compareSelecting, setCompareSelecting] = useState(false);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [headSlot, setHeadSlot] = useState<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const extraInput = useRef<HTMLInputElement>(null);
  const eventInput = useRef<HTMLInputElement>(null); // files to add to one event
  const eventTarget = useRef<string | null>(null);

  // ---------- Theme ----------
  const [dark, setDark] = useState(() => resolvedDark(settings.theme));
  useEffect(() => {
    const apply = () => setDark(resolvedDark(settings.theme));
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);
  const [chartTheme, setChartTheme] = useState<ChartTheme | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d1015' : '#ffffff');
    setChartTheme(readChartTheme());
  }, [dark]);

  // ---------- Toasts ----------
  const toast = useCallback((title: string, msg?: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, title, msg, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 9000 : 5000);
  }, []);

  // ---------- Library ----------
  const openKey = useCallback((key: string, nextTab?: Tab) => {
    setSelectedKey(key);
    setView('main');
    setMobileSidebar(false);
    if (nextTab) setTab(nextTab);
  }, []);

  const onNewLog = useCallback(
    (e: LogEntry) => {
      if (settings.autoFollow) {
        openKey(e.key, 'board');
        toast('New log from the Driver Station', `Opened ${e.key}. It updates live while the DS is recording.`, 'success');
      } else {
        toast('New log from the Driver Station', e.key, 'info', { label: 'Open', run: () => openKey(e.key, 'board') });
      }
    },
    [settings.autoFollow, openKey, toast],
  );
  const library = useLibrary({ onNewLog, onError: (title, msg) => toast(title, msg, 'error'), onInfo: (title, msg) => toast(title, msg, 'success') });
  const entries = useMemo(() => sortEntries(library.entries.values()), [library.entries]);
  const selected = selectedKey ? library.entries.get(selectedKey) : undefined;
  const parsed = useParsed(view === 'main' ? selected : undefined);

  // Which logs the open match is compared against. The Board uses the same function, so this is the real list.
  const baseline = useMemo(() => {
    if (!selected || view !== 'main' || selected.robot) return null; // a robot-only match has no Board to compare
    const team = selected.summary?.team ?? (parsed.key === selected.key ? parsed.data?.events?.meta.team : undefined);
    const { points, status } = classifyHistory(entries, { key: selected.key, startTime: selected.startTime, team });
    return { title: selected.summary?.title ?? selected.key, demo: usesDemoHistory(selected, points.length), status };
  }, [entries, selected, view, parsed.key, parsed.data]);

  /** Adds roboRIO / CTRE logs: to `target` when given, otherwise to the matches they fit, or to a new match of their own. */
  const addExtras = useCallback(
    async (all: File[], target?: string, eventId?: string) => {
      // In the desktop app a hoot goes to the robot-log folder, where Owlet converts it and it finds its match by itself.
      const bridge = desktopBridge();
      const hoots = bridge ? all.filter((f) => fileKind(f.name) === 'hoot') : [];
      const files = hoots.length ? all.filter((f) => !hoots.includes(f)) : all;
      if (bridge && hoots.length) {
        // the hoots are copied into the robot-log folder and found there by name: say now which event they belong to
        if (eventId) await library.assignLogsToEvent(hoots.map((f) => f.name), eventId);
        const r = await bridge
          .addRobotFiles(hoots)
          .catch((err) => ({ copied: [], skipped: [], failed: hoots.map((f) => ({ name: f.name, error: String((err as Error).message ?? err) })) }));
        for (const f of r.failed.slice(0, 2)) toast(f.name, f.error, 'error');
        let now = await bridge.settings().catch(() => null);
        // Owlet not set up but one sits in Downloads: the app asks, in its own dialog, whether to use that one
        if (r.copied.length && now && !now.owlet.found && now.owlet.suggested) now = await bridge.useDownloadedOwlet('once').catch(() => now);
        const owletFound = now?.owlet.found ?? true;
        if (r.copied.length)
          toast(
            r.copied.length === 1 ? `Copied ${r.copied[0]} to the robot-log folder` : `Copied ${r.copied.length} hoots to the robot-log folder`,
            `${owletFound ? 'Owlet converts it in the background, and it joins its match by itself.' : "Owlet isn't set up yet. In the ⋯ menu, use Get Owlet to download it from CTRE (or Locate Owlet if you have it), and the hoot converts by itself."}${target ? " It is placed by its name and clock, not on the match you picked." : ''}`,
            'success',
          );
        else if (r.skipped.length && !r.failed.length) toast('Already in the robot-log folder', r.skipped.join(', '), 'info');
      }
      if (!files.length) return;
      const res = await library.attachExtras(files, target, eventId);
      for (const r of res.rejected.slice(0, 2)) toast(r.name, r.reason, 'error');
      const title = (k: string) => library.entries.get(k)?.summary?.title ?? library.entries.get(k)?.robot?.title ?? k;
      const created = res.attached.filter((a) => a.created);
      const joined = res.attached.filter((a) => !a.created);
      const keys = [...new Set(res.attached.flatMap((a) => a.keys))];
      if (joined.length) {
        const where = [...new Set(joined.flatMap((a) => a.keys))];
        toast(
          where.length === 1 ? `Added to ${title(where[0])}` : `Added to ${where.length} matches`,
          where.length === 1 ? joined.map((a) => a.name).join(', ') : 'The log covers all of them.',
          'success',
        );
      }
      if (created.length)
        toast(
          created.length === 1 ? 'Started a new match for this robot log' : `Started ${created.length} new matches for these robot logs`,
          'It fits no Driver Station log yet. Add the .dslog and .dsevents any time and they will join it if they belong together.',
          'success',
        );
      if (res.attached.some((a) => /\.hoot$/i.test(a.name)))
        toast('Saved the .hoot', "PitView can't read its signals yet. On the match's Info page, press Copy hoot diagnostics and paste the text in the chat.", 'info');
      if (keys.length && (!selectedKey || !keys.includes(selectedKey))) openKey(keys[0], 'info');
    },
    [library, selectedKey, openKey, toast],
  );

  const addFiles = useCallback(
    async (files: File[], eventId?: string) => {
      const logs = files.filter((f) => isLogFile(f.name));
      const extras = files.filter((f) => fileKind(f.name) === 'wpilog' || fileKind(f.name) === 'hoot');
      if (!logs.length && !extras.length) {
        toast('No logs found', 'Pick .dslog / .dsevents files from the Driver Station, or .wpilog files from the robot.', 'error');
        return;
      }
      if (logs.length) {
        const added = await library.addFiles(logs, eventId);
        const newest = [...added].sort((a, b) => b.startTime - a.startTime)[0];
        if (newest) openKey(newest.key, 'board');
        if (added.length > 1) toast(`Added ${added.length} logs`, 'They are listed in the library on the left.', 'success');
        const unpaired = added.filter((e) => !e.dslog || !e.dsevents);
        if (added.length === 1 && unpaired.length === 1)
          toast(
            `Only the ${unpaired[0].dslog ? '.dslog' : '.dsevents'} was opened`,
            `Add ${unpaired[0].key}.${unpaired[0].dslog ? 'dsevents' : 'dslog'} too for ${unpaired[0].dslog ? 'messages and match info' : 'graphs'}.`,
          );
      }
      // after the DS logs, so a log dropped together with its match can find it
      if (extras.length) await addExtras(extras, undefined, eventId);
    },
    [library, openKey, toast, addExtras],
  );

  const openLatestMatch = useCallback(() => {
    const m = entries.find((e) => e.summary?.isMatch) ?? entries.find((e) => e.summary?.enabledTime) ?? entries[0];
    if (m) openKey(m.key, 'board');
    else toast('No logs yet', 'Open some logs or connect the DS folder first.');
  }, [entries, openKey, toast]);

  const openSample = useCallback(async () => {
    const e = await library.loadSample();
    if (e) openKey(e.key, 'board');
  }, [library, openKey]);

  // ---------- Drag & drop anywhere ----------
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      try {
        const { files, folder } = await filesFromDrop(e.dataTransfer);
        if (folder) {
          await library.connectFolder(folder);
          toast(`Watching “${folder.name}”`, 'New logs in this folder will appear automatically.', 'success');
        } else await addFiles(files);
      } catch (err) {
        toast('Could not read the dropped files', String((err as Error).message ?? err), 'error');
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles, library, toast]);

  // ---------- Installed app: open .dslog files from the OS ----------
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer: (fn: (p: { files: FileSystemFileHandle[] }) => void) => void } })
      .launchQueue;
    lq?.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      await addFiles(files);
    });
  }, [addFiles]);

  // ---------- Global shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') setHelp((h) => !h);
      else if (e.key === 'd') updateSettings((s) => ({ theme: resolvedDark(s.theme) ? 'light' : 'dark' }));
      else if (e.key === 'o') fileInput.current?.click();
      else if (e.key === 'l') openLatestMatch();
      else if (e.key === 's') setMobileSidebar((m) => !m);
      else if (e.key === 'Escape') setMobileSidebar(false);
      else if ((e.key === '[' || e.key === ']') && entries.length) {
        const i = entries.findIndex((x) => x.key === selectedKey);
        const next = e.key === ']' ? Math.min(entries.length - 1, i + 1) : Math.max(0, i - 1);
        openKey(entries[i < 0 ? 0 : next].key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries, selectedKey, openKey, openLatestMatch]);

  // On the DS laptop, start on the newest match instead of the home screen.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !settings.autoFollow || selectedKey || !library.ready) return;
    if (library.folder.status !== 'connected' && library.companion.status !== 'connected') return;
    const newest = entries.find((e) => e.summary?.isMatch);
    if (!newest) return;
    autoOpened.current = true;
    openKey(newest.key, 'board');
  }, [settings.autoFollow, selectedKey, library.ready, library.folder.status, library.companion.status, entries, openKey]);

  // Drop a selection that disappeared (e.g. folder disconnected).
  useEffect(() => {
    if (selectedKey && library.ready && !library.entries.has(selectedKey)) setSelectedKey(null);
  }, [selectedKey, library.entries, library.ready]);

  const compareEntries = compareKeys.map((k) => library.entries.get(k)).filter(Boolean) as LogEntry[];

  // The library is a drawer on every screen size: out of the way until you want another log.
  const toggleSidebar = () => setMobileSidebar((m) => !m);

  if (!chartTheme) return null;

  return (
    <div className="app">
      <TopBar
        library={library}
        settings={settings}
        onOpenFiles={() => fileInput.current?.click()}
        onLatestMatch={openLatestMatch}
        onHelp={() => setHelp(true)}
        onToggleSidebar={toggleSidebar}
        onHome={() => {
          setSelectedKey(null);
          setView('main');
        }}
        hasMatches={entries.some((e) => e.summary?.isMatch)}
        logCount={entries.length}
        drawerOpen={mobileSidebar}
        slotRef={setHeadSlot}
        viewing={view === 'main' && !!selected}
      />
      <div className={`main ${mobileSidebar ? 'drawer-open' : ''}`}>
        {mobileSidebar && <div className="drawer-scrim" onClick={() => setMobileSidebar(false)} />}
        <LibraryPanel
          entries={entries}
          baseline={baseline}
          selectedKey={view === 'main' ? selectedKey : null}
          onSelect={(k) => openKey(k)}
          indexing={library.indexing}
          compareSelecting={compareSelecting}
          compareKeys={compareKeys}
          toggleCompare={(k) => setCompareKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : ks.length >= 6 ? ks : [...ks, k]))}
          beginCompare={() => {
            setCompareSelecting(true);
            setCompareKeys(selectedKey ? [selectedKey] : []);
            setMobileSidebar(true);
          }}
          startCompare={() => {
            setCompareSelecting(false);
            setView('compare');
            setMobileSidebar(false);
          }}
          cancelCompare={() => {
            setCompareSelecting(false);
            setCompareKeys([]);
          }}
          onClearSaved={async () => {
            await library.clearSaved();
            toast('Saved logs removed', undefined, 'success');
          }}
          events={library.events}
          eventOf={library.eventOf}
          onCreateEvent={(name) => {
            library.createEvent(name);
            toast(`Made the event "${name}"`, 'Use + on it to add logs. They are only matched within the event.', 'success');
          }}
          onRenameEvent={(id, name) => library.renameEvent(id, name)}
          onMoveToEvent={(keys, id) => {
            library.moveToEvent(keys, id);
            toast(keys.length === 1 ? 'Moved 1 match' : `Moved ${keys.length} matches`, library.events.find((e) => e.id === id)?.name, 'success');
          }}
          onDeleteEvent={async (id, keys) => {
            const n = keys.length ? await library.deleteEntries(keys) : 0;
            library.removeEvent(id);
            if (selectedKey && keys.includes(selectedKey)) setSelectedKey(null);
            setCompareKeys((ks) => ks.filter((k) => !keys.includes(k)));
            toast('Event deleted', n ? `${n} ${n === 1 ? 'match' : 'matches'} removed with it. Files in your folders are not touched.` : undefined, 'success');
          }}
          onAddToEvent={(id) => {
            eventTarget.current = id;
            eventInput.current?.click();
          }}
          hidden={library.hiddenMatches + library.hiddenRobotLogs}
          onShowHidden={async () => {
            await library.showHidden();
            toast('Showing everything again', 'Matches and robot logs you deleted from a watched folder are listed again.', 'success');
          }}
          onDelete={async (keys) => {
            const n = await library.deleteEntries(keys);
            if (selectedKey && keys.includes(selectedKey)) setSelectedKey(null);
            setCompareKeys((ks) => ks.filter((k) => !keys.includes(k)));
            toast(n === 1 ? 'Deleted 1 match' : `Deleted ${n} matches`, 'Files in your Driver Station and robot-log folders are not touched.', 'success');
          }}
          onClearAll={async () => {
            const n = await library.clearAll();
            setSelectedKey(null);
            setCompareKeys([]);
            setView('main');
            toast('Library cleared', n ? `${n} ${n === 1 ? 'match' : 'matches'} removed. Matches that arrive from now on still appear.` : undefined, 'success');
          }}
        />
        <main className="content">
          {view === 'compare' && compareEntries.length >= 2 ? (
            <Compare
              entries={compareEntries}
              theme={chartTheme}
              onOpen={(k) => openKey(k, 'board')}
              onRemove={(k) => {
                const next = compareKeys.filter((x) => x !== k);
                setCompareKeys(next);
                if (next.length < 2) setView('main');
              }}
              onClose={() => {
                setView('main');
                setCompareKeys([]);
              }}
            />
          ) : selected ? (
            <Viewer
              key={selected.key}
              entry={selected}
              state={parsed}
              entries={entries}
              theme={chartTheme}
              settings={settings}
              tab={tab}
              setTab={setTab}
              headSlot={headSlot}
              onAddLogs={() => extraInput.current?.click()}
              onRemoveLog={(name) => void library.detachExtra(selected.key, name)}
              onCompare={() => {
                setCompareSelecting(true);
                setCompareKeys([selected.key]);
                setMobileSidebar(true);
                toast('Pick logs to compare', 'Tick up to 5 more logs in the library, then press Compare.');
              }}
              onRemove={() => {
                void library.removeEntry(selected.key);
                setSelectedKey(null);
              }}
              toast={(t, m, k) => toast(t, m, k)}
            />
          ) : (
            <Welcome
              library={library}
              recent={entries}
              onOpenFiles={() => fileInput.current?.click()}
              onOpen={(k) => openKey(k, 'board')}
              onSample={openSample}
              onLatestMatch={openLatestMatch}
            />
          )}
        </main>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".dslog,.dsevents,.wpilog,.hoot"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />
      <input
        ref={eventInput}
        type="file"
        multiple
        accept=".dslog,.dsevents,.wpilog,.hoot"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          const id = eventTarget.current;
          eventTarget.current = null;
          if (files.length && id) void addFiles(files, id);
        }}
      />
      <input
        ref={extraInput}
        type="file"
        multiple
        accept=".wpilog,.hoot"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length && selectedKey) void addExtras(files, selectedKey);
        }}
      />

      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="upload" size={40} />
            <h2>Drop to open</h2>
            <p className="muted">.dslog / .dsevents files, or a whole folder of them</p>
          </div>
        </div>
      )}

      {help && <HelpModal onClose={() => setHelp(false)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="t-body">
              <div className="t-title">{t.title}</div>
              {t.msg && <div className="t-msg">{t.msg}</div>}
            </div>
            {t.action && (
              <button
                className="btn small"
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="btn small icon ghost" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
