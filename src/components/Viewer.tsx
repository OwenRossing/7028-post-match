import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeStats, findProblems, problemStops, stepProblem } from '../lib/analysis';
import { ChartGroup, type Marker } from '../lib/chartGroup';
import { download, eventsToCsv, logToCsv, safeFileName, summaryMarkdown } from '../lib/export';
import { hasDS, type LogEntry } from '../lib/library';
import { channelLabelKey, type Settings } from '../lib/settings';
import type { ChartTheme } from '../lib/theme';
import { fmtDateTime, fmtSpan } from '../lib/time';
import { makeTimeFormat } from '../lib/timefmt';
import type { ParsedState } from '../lib/useParsed';
import { FileChips } from './FileChips';
import { Icon } from './Icon';
import { KeyBar } from './KeyBar';
import { Scrim } from './Scrim';
import { Board } from './viewer/Board';
import { RobotOnly } from './viewer/RobotOnly';
import { EventsView } from './viewer/EventsView';
import { CHART_SIGNALS, Graphs } from './viewer/Graphs';
import { Info } from './viewer/Info';
import type { EventFilter, JumpOpts, Tab, ViewCtx } from './viewer/types';

interface Props {
  entry: LogEntry;
  state: ParsedState;
  /** The whole library, for comparing this match against earlier ones. */
  entries: LogEntry[];
  theme: ChartTheme;
  settings: Settings;
  tab: Tab;
  setTab: (t: Tab) => void;
  /** The top bar's slot for the title and tabs; without one the header renders in place. */
  headSlot?: HTMLElement | null;
  onCompare: () => void;
  /** Opens a file picker for roboRIO / CTRE logs to add to this match. */
  onAddLogs: () => void;
  onRemoveLog: (name: string) => void;
  onRemove?: () => void;
  toast: (title: string, msg?: string, kind?: 'info' | 'error' | 'success') => void;
}

const TABS: [Tab, string][] = [
  ['board', 'Board'],
  ['graphs', 'Graphs'],
  ['messages', 'Messages'],
  ['info', 'Info'],
];

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function Viewer(props: Props) {
  const { entry, state } = props;
  if (!hasDS(entry))
    return <RobotOnly entry={entry} headSlot={props.headSlot} onAddLogs={props.onAddLogs} onRemoveLog={props.onRemoveLog} onRemove={() => props.onRemove?.()} />;
  if (state.status === 'error')
    return (
      <div className="center-state">
        <div>
          <Icon name="alertCircle" size={36} />
          <h2>Couldn't read this log</h2>
          <p>{state.error}</p>
          {props.onRemove && (
            <button className="btn" onClick={props.onRemove}>
              <Icon name="trash" size={14} /> Remove from library
            </button>
          )}
        </div>
      </div>
    );
  if (!state.data || state.key !== entry.key)
    return (
      <div className="center-state">
        <div className="row" style={{ justifyContent: 'center' }}>
          <div className="spinner" /> Reading {entry.key}…
        </div>
      </div>
    );
  return <LoadedViewer {...props} parsed={state.data} refreshing={!!state.refreshing} />;
}

function LoadedViewer({
  entry,
  entries,
  parsed,
  refreshing,
  theme,
  settings,
  tab,
  setTab,
  headSlot,
  onCompare,
  onAddLogs,
  onRemoveLog,
  onRemove,
  toast,
}: Props & { parsed: NonNullable<ParsedState['data']>; refreshing: boolean }) {
  const { log, events, analysis } = parsed;
  const group = useMemo(() => new ChartGroup({ start: 0, end: 1 }), [entry.key]);
  const initialised = useRef(false);
  // Which Graphs rows are unfolded, and the one the keyboard is on. Kept here so they survive tab switches.
  const [graphOpen, setGraphOpen] = useState<string[]>([]);
  const [graphSel, setGraphSel] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<EventFilter & { nonce: number }>({ nonce: 0 });
  const [menu, setMenu] = useState<'more' | null>(null);
  useEffect(() => {
    if (tab !== 'messages') setEventFilter({ nonce: 0 });
  }, [tab]);

  // Keep the sync group in step with the (possibly growing) log.
  useEffect(() => {
    const duration = Math.max(analysis.duration, 1);
    group.setFull({ start: 0, end: duration });
    if (!initialised.current) {
      initialised.current = true;
      const f = analysis.focus;
      if (f.end - f.start > 1 && f.end - f.start < duration - 1) group.setRange(f.start, f.end);
      else group.reset();
    }
  }, [group, analysis]);

  const tf = useMemo(
    () => makeTimeFormat(settings.timeMode, log?.startTime ?? events?.startTime ?? 0, analysis.match?.start),
    [settings.timeMode, log, events, analysis],
  );
  group.fmt = tf.fmt;
  group.fmtAxis = tf.axis;
  group.tickBase = tf.tickBase;

  useEffect(() => {
    const markers: Marker[] = [];
    for (const e of events?.events ?? []) {
      const text = e.text.split('\n')[0].trim();
      if (e.kind === 'error') markers.push({ t: e.t, level: 'error', text });
      else if (e.kind === 'warning' && !e.tags.includes('tracer')) markers.push({ t: e.t, level: 'warning', text });
      else if (e.tags.includes('comms')) markers.push({ t: e.t, level: 'comms', text });
    }
    group.setOverlay({
      modes: analysis.modes,
      noComms: analysis.noComms,
      stalls: analysis.codeStalls,
      brownouts: analysis.brownouts,
      markers,
      showMarkers: settings.showMarkers,
    });
  }, [group, analysis, events, settings.showMarkers]);

  useEffect(() => group.redraw(), [group, tf]);

  const labelKey = channelLabelKey(events?.meta.team, log?.pdType ?? 'none');
  const labels = settings.channelLabels[labelKey];

  const jumpTo = useCallback(
    (t: number, opts?: JumpOpts) => {
      if (!Number.isFinite(t) || !log) return;
      setTab('graphs');
      const current = group.range.end - group.range.start;
      const width = opts?.width ?? Math.min(20, current);
      group.focusOn(t, Math.max(width, 2));
      // Unfold the rows that show it, so the answer is on screen.
      const ids = opts?.signal ? (/^ch\d+$/.test(opts.signal) ? ['channels', opts.signal] : [opts.signal]) : opts?.chart ? CHART_SIGNALS[opts.chart] : [];
      if (ids.length) {
        setGraphOpen((o) => [...new Set([...o, ...ids])]);
        setGraphSel(ids[ids.length - 1]);
        setTimeout(() => document.getElementById(`sig-${ids[ids.length - 1]}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      }
    },
    [group, log, setTab],
  );

  const showEvents = useCallback(
    (filter: EventFilter) => {
      setTab('messages');
      setEventFilter({ ...filter, nonce: Date.now() });
    },
    [setTab],
  );

  const focusStats = useMemo(() => computeStats(log, events, analysis, analysis.focus), [log, events, analysis]);
  const focusProblems = useMemo(() => findProblems(log, events, analysis, focusStats), [log, events, analysis, focusStats]);
  const ctx: ViewCtx = { entry, parsed, group, theme, settings, tf, labels, labelKey, problems: focusProblems, jumpTo, showEvents, setTab, addLogs: onAddLogs, removeLog: onRemoveLog };
  const verdict = focusProblems.some((p) => p.severity === 'bad') ? 'bad' : focusProblems.some((p) => p.severity === 'warn') ? 'warn' : 'ok';
  const live = (entry.source === 'folder' || entry.source === 'companion') && Date.now() - (entry.dslog?.mtime ?? 0) < 20000;

  // Keyboard shortcuts for the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const m = analysis.match;
      const tabs: Tab[] = ['board', 'graphs', 'messages', 'info'];
      const pad = (a: number, b: number) => group.setRange(a - 2, b + 2);
      const onGraphs = tab === 'graphs';
      switch (e.key) {
        case '1':
        case '2':
        case '3':
        case '4':
          setTab(tabs[Number(e.key) - 1]);
          break;
        // zoom keys only on Graphs, so letters stay free for the other screens
        case 'f':
          if (onGraphs) group.reset();
          break;
        case 'm':
          if (!onGraphs) break;
          if (m) pad(m.start, m.end);
          else pad(analysis.focus.start, analysis.focus.end);
          break;
        case 'a':
          if (onGraphs && m?.autoStart != null) pad(m.autoStart, m.autoEnd!);
          break;
        case 't':
          if (onGraphs && m?.teleopStart != null) pad(m.teleopStart, m.teleopEnd!);
          break;
        case '+':
        case '=':
          if (onGraphs) group.zoom(0.6);
          break;
        case '-':
        case '_':
          if (onGraphs) group.zoom(1 / 0.6);
          break;
        case 'ArrowLeft':
          if (tab === 'graphs') {
            group.panBy(-0.2);
            e.preventDefault();
          }
          break;
        case 'ArrowRight':
          if (tab === 'graphs') {
            group.panBy(0.2);
            e.preventDefault();
          }
          break;
        // J goes back to the previous problem and K forward to the next one, like the arrows on the Graphs card
        case 'j':
        case 'k': {
          const stop = stepProblem(problemStops(focusProblems), group.pinned, e.key === 'k' ? 1 : -1);
          if (stop) jumpTo(stop.t, { chart: stop.chart, width: 12 });
          break;
        }
        case '/':
          if (tab === 'messages') {
            e.preventDefault();
            document.getElementById('events-search')?.focus();
          }
          break;
        case 'Escape':
          if (tab === 'graphs' && group.pinned != null) group.pin(null, false);
          else if (tab !== 'board') setTab('board');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [group, analysis, tab, setTab, focusProblems, jumpTo]);

  const baseName = safeFileName(`${analysis.title} ${entry.key}`);
  const exportActions = {
    summary: async () => {
      const subtitle = [
        events?.meta.eventName,
        events?.meta.team && `Team ${events.meta.team}`,
        fmtDateTime(log?.startTime ?? events?.startTime ?? entry.startTime),
      ]
        .filter(Boolean)
        .join(' · ');
      const text = summaryMarkdown({ title: analysis.title, subtitle, stats: focusStats, problems: focusProblems });
      try {
        await navigator.clipboard.writeText(text);
        toast('Summary copied', 'Paste it into Discord, Slack or your notes.', 'success');
      } catch {
        download(text, `${baseName} summary.md`);
      }
    },
    csvRange: () => log && download(logToCsv(log, group.range, labels, analysis.match?.start), `${baseName} (range).csv`, 'text/csv'),
    csvAll: () =>
      log && download(logToCsv(log, { start: 0, end: analysis.duration }, labels, analysis.match?.start), `${baseName}.csv`, 'text/csv'),
    events: () => events && download(eventsToCsv(events.events, analysis.match?.start), `${baseName} messages.csv`, 'text/csv'),
  };

  const meta = events?.meta;
  const start = log?.startTime ?? events?.startTime ?? entry.startTime;

  const tabBar = (className: string) => (
    <div className={`tabs ${className}`} role="tablist">
      {TABS.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
          {label}
        </button>
      ))}
    </div>
  );

  const whoWhere = [meta?.eventName, meta?.team && `Team ${meta.team}`].filter(Boolean).join(' · ');

  // One row, like the prototype: light, title, where/who, tabs, export.
  const head = (
    <div className="vhead">
      <span className={`head-light ${verdict}`} title={verdict === 'ok' ? 'Healthy' : verdict === 'warn' ? 'Warnings' : 'Problems'} />
      <div className="vhead-title">
        <h1>{analysis.title}</h1>
        {live && (
          <span className="live-tag">
            <span className="live-dot" /> Live
          </span>
        )}
        {refreshing && <div className="spinner" style={{ width: 13, height: 13 }} />}
        <FileChips entry={entry} compact showMissing onAddRobot={onAddLogs} />
        <span className="vhead-sub">
          {whoWhere}
          <span className="vhead-date">
            {whoWhere && ' · '}
            {fmtDateTime(start)}
          </span>
        </span>
      </div>
      {tabBar('vhead-tabs')}
      <div className="viewer-actions">
        <div className="menu-wrap">
          <button className="btn icon round" onClick={() => setMenu(menu ? null : 'more')} title="Export, compare and more" aria-label="Export and compare">
            <Icon name="download" size={17} />
          </button>
          {menu && (
            <>
              <Scrim onClose={() => setMenu(null)} />
              <div className="menu" onClick={() => setMenu(null)}>
                <button className="item" onClick={exportActions.summary}>
                  <Icon name="copy" />
                  <span>
                    Copy summary
                    <small>The fix list as text for Discord / Slack</small>
                  </span>
                </button>
                <button className="item" onClick={onAddLogs}>
                  <Icon name="plug" />
                  <span>
                    Add robot logs
                    <small>roboRIO or CTRE .wpilog files for this match</small>
                  </span>
                </button>
                <button className="item" onClick={onCompare}>
                  <Icon name="compare" />
                  <span>
                    Compare with other logs
                    <small>Overlay up to 6 matches</small>
                  </span>
                </button>
                <hr />
                <button className="item" onClick={exportActions.csvRange} disabled={!log}>
                  <Icon name="download" />
                  <span>
                    Data CSV, visible range
                    <small>
                      {tf.fmt(group.range.start)} → {tf.fmt(group.range.end)}
                    </small>
                  </span>
                </button>
                <button className="item" onClick={exportActions.csvAll} disabled={!log}>
                  <Icon name="download" />
                  <span>
                    Data CSV, whole log
                    <small>Every 20 ms record, all channels</small>
                  </span>
                </button>
                <button className="item" onClick={exportActions.events} disabled={!events}>
                  <Icon name="list" />
                  <span>
                    Messages CSV
                    <small>All errors, warnings and prints</small>
                  </span>
                </button>
                <div className="menu-note">
                  {[meta?.dsVersion && `DS ${meta.dsVersion}`, meta?.robotLanguage && `${meta.robotLanguage} ${meta.wpilibVersion ?? ''}`, fmtSpan(analysis.duration) + ' log', entry.key]
                    .filter(Boolean)
                    .join(' · ')}
                  {!entry.dslog && ' (no .dslog)'}
                  {!entry.dsevents && ' (no .dsevents)'}
                </div>
                {onRemove && (
                  <>
                    <hr />
                    <button className="item danger" onClick={onRemove}>
                      <Icon name="trash" />
                      <span>Remove from library</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={`viewer ${tab === 'board' ? 'viewer-board' : ''}`}>
      {headSlot ? createPortal(head, headSlot) : <div className="viewer-head">{head}</div>}
      {tabBar('tabs-strip')}
      {parsed.warnings.length > 0 && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="banner">
            <Icon name="alert" /> {parsed.warnings.join(' · ')}
          </div>
        </div>
      )}
      {tab === 'board' && <Board ctx={ctx} entries={entries} />}
      {tab === 'graphs' && <Graphs ctx={ctx} open={graphOpen} setOpen={setGraphOpen} sel={graphSel} setSel={setGraphSel} />}
      {tab === 'messages' && (
        <div className="page">
          <EventsView ctx={ctx} initial={eventFilter} />
        </div>
      )}
      {tab === 'info' && <Info ctx={ctx} />}
      <KeyBar
        keys={
          tab === 'board'
            ? [['← → ↑ ↓', 'move'], ['Space', 'unfold'], ['Enter', 'details'], ['I', 'explain'], ['J K', 'unusual']]
            : tab === 'graphs'
              ? [['↑ ↓', 'rows'], ['Space', 'unfold'], ['← →', 'pan'], ['+ −', 'zoom'], ['A T M F', 'auto · teleop · match · all'], ['Esc', 'board']]
              : tab === 'messages'
                ? [['↑ ↓', 'move'], ['Enter', 'open'], ['G', 'on the graphs'], ['/', 'search'], ['Esc', 'board']]
                : [['↑ ↓', 'move'], ['Space', 'unfold'], ['Esc', 'board']]
        }
      />
    </div>
  );
}

