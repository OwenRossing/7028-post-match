import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compare } from './components/Compare';
import { HelpModal } from './components/HelpModal';
import { Icon } from './components/Icon';
import { Library as LibraryPanel } from './components/Library';
import { TopBar } from './components/TopBar';
import { Viewer } from './components/Viewer';
import type { Tab } from './components/viewer/types';
import { Welcome } from './components/Welcome';
import { filesFromDrop } from './lib/folder';
import { isLogFile, sortEntries, type LogEntry } from './lib/library';
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
  const [tab, setTab] = useState<Tab>('overview');
  const [view, setView] = useState<'main' | 'compare'>('main');
  const [compareSelecting, setCompareSelecting] = useState(false);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
        openKey(e.key, 'overview');
        toast('New log from the Driver Station', `Opened ${e.key}. It updates live while the DS is recording.`, 'success');
      } else {
        toast('New log from the Driver Station', e.key, 'info', { label: 'Open', run: () => openKey(e.key, 'overview') });
      }
    },
    [settings.autoFollow, openKey, toast],
  );
  const library = useLibrary({ onNewLog, onError: (title, msg) => toast(title, msg, 'error') });
  const entries = useMemo(() => sortEntries(library.entries.values()), [library.entries]);
  const selected = selectedKey ? library.entries.get(selectedKey) : undefined;
  const parsed = useParsed(view === 'main' ? selected : undefined);

  const addFiles = useCallback(
    async (files: File[]) => {
      const logs = files.filter((f) => isLogFile(f.name));
      if (!logs.length) {
        toast('No DS logs found', 'Pick .dslog and/or .dsevents files from the Driver Station log folder.', 'error');
        return;
      }
      const added = await library.addFiles(logs);
      const newest = [...added].sort((a, b) => b.startTime - a.startTime)[0];
      if (newest) openKey(newest.key, 'overview');
      if (added.length > 1) toast(`Added ${added.length} logs`, 'They are listed in the library on the left.', 'success');
      const unpaired = added.filter((e) => !e.dslog || !e.dsevents);
      if (added.length === 1 && unpaired.length === 1)
        toast(
          `Only the ${unpaired[0].dslog ? '.dslog' : '.dsevents'} was opened`,
          `Add ${unpaired[0].key}.${unpaired[0].dslog ? 'dsevents' : 'dslog'} too for ${unpaired[0].dslog ? 'messages and match info' : 'graphs'}.`,
        );
    },
    [library, openKey, toast],
  );

  const openLatestMatch = useCallback(() => {
    const m = entries.find((e) => e.summary?.isMatch) ?? entries.find((e) => e.summary?.enabledTime) ?? entries[0];
    if (m) openKey(m.key, 'overview');
    else toast('No logs yet', 'Open some logs or connect the DS folder first.');
  }, [entries, openKey, toast]);

  const openSample = useCallback(async () => {
    const e = await library.loadSample();
    if (e) openKey(e.key, 'overview');
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
      />
      <div className={`main ${mobileSidebar ? 'drawer-open' : ''}`}>
        {mobileSidebar && <div className="drawer-scrim" onClick={() => setMobileSidebar(false)} />}
        <LibraryPanel
          entries={entries}
          selectedKey={view === 'main' ? selectedKey : null}
          onSelect={(k) => openKey(k)}
          indexing={library.indexing}
          compareSelecting={compareSelecting}
          compareKeys={compareKeys}
          toggleCompare={(k) =>
            setCompareKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : ks.length >= 6 ? ks : [...ks, k]))
          }
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
        />
        <main className="content">
          {view === 'compare' && compareEntries.length >= 2 ? (
            <Compare
              entries={compareEntries}
              theme={chartTheme}
              onOpen={(k) => openKey(k, 'overview')}
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
              theme={chartTheme}
              settings={settings}
              tab={tab}
              setTab={setTab}
              onCompare={() => {
                setCompareSelecting(true);
                setCompareKeys([selected.key]);
                setMobileSidebar(true);
                toast('Pick logs to compare', 'Tick up to 5 more logs in the library, then press Compare.');
              }}
              onRemove={
                selected.source === 'saved' || selected.source === 'upload' || selected.source === 'sample'
                  ? () => {
                      void library.removeEntry(selected.key);
                      setSelectedKey(null);
                    }
                  : undefined
              }
              toast={(t, m, k) => toast(t, m, k)}
            />
          ) : (
            <Welcome
              library={library}
              recent={entries}
              onOpenFiles={() => fileInput.current?.click()}
              onOpen={(k) => openKey(k, 'overview')}
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
        accept=".dslog,.dsevents"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void addFiles(files);
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
