import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, findProblems, type ChartId } from '../lib/analysis';
import { ChartGroup, type Marker } from '../lib/chartGroup';
import { download, eventsToCsv, logToCsv, safeFileName, summaryMarkdown } from '../lib/export';
import type { LogEntry } from '../lib/library';
import { channelLabelKey, type Settings } from '../lib/settings';
import type { ChartTheme } from '../lib/theme';
import { fmtDateTime, fmtSpan } from '../lib/time';
import { makeTimeFormat } from '../lib/timefmt';
import type { ParsedState } from '../lib/useParsed';
import { Icon } from './Icon';
import { KeyBar } from './KeyBar';
import { EventsView } from './viewer/EventsView';
import { defaultChannels, Graphs } from './viewer/Graphs';
import { Overview } from './viewer/Overview';
import { RobotMap } from './viewer/RobotMap';
import { Power } from './viewer/Power';
import type { EventFilter, Tab, ViewCtx } from './viewer/types';

interface Props {
  entry: LogEntry;
  state: ParsedState;
  theme: ChartTheme;
  settings: Settings;
  tab: Tab;
  setTab: (t: Tab) => void;
  onCompare: () => void;
  onRemove?: () => void;
  toast: (title: string, msg?: string, kind?: 'info' | 'error' | 'success') => void;
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function Viewer(props: Props) {
  const { entry, state } = props;
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
  parsed,
  refreshing,
  theme,
  settings,
  tab,
  setTab,
  onCompare,
  onRemove,
  toast,
}: Props & { parsed: NonNullable<ParsedState['data']>; refreshing: boolean }) {
  const { log, events, analysis } = parsed;
  const group = useMemo(() => new ChartGroup({ start: 0, end: 1 }), [entry.key]);
  const initialised = useRef(false);
  const [channels, setChannels] = useState<number[]>(() => defaultChannels(log));
  const [eventFilter, setEventFilter] = useState<EventFilter & { nonce: number }>({ nonce: 0 });
  const [menu, setMenu] = useState<'more' | null>(null);

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
      if (e.kind === 'error') markers.push({ t: e.t, level: 'error' });
      else if (e.kind === 'warning' && !e.tags.includes('tracer')) markers.push({ t: e.t, level: 'warning' });
      else if (e.tags.includes('comms')) markers.push({ t: e.t, level: 'comms' });
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
    (t: number, opts?: { chart?: ChartId; width?: number }) => {
      if (!Number.isFinite(t) || !log) return;
      setTab('graphs');
      const current = group.range.end - group.range.start;
      const width = opts?.width ?? Math.min(20, current);
      group.focusOn(t, Math.max(width, 2));
      if (opts?.chart)
        setTimeout(() => document.getElementById(`chart-${opts.chart}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    },
    [group, log, setTab],
  );

  const showEvents = useCallback(
    (filter: EventFilter) => {
      setTab('events');
      setEventFilter({ ...filter, nonce: Date.now() });
    },
    [setTab],
  );

  const ctx: ViewCtx = { entry, parsed, group, theme, settings, tf, labels, labelKey, jumpTo, showEvents, setTab };

  const focusStats = useMemo(() => computeStats(log, events, analysis, analysis.focus), [log, events, analysis]);
  const focusProblems = useMemo(() => findProblems(log, events, analysis, focusStats), [log, events, analysis, focusStats]);
  const verdict = focusProblems.some((p) => p.severity === 'bad') ? 'bad' : focusProblems.some((p) => p.severity === 'warn') ? 'warn' : 'ok';
  const live = (entry.source === 'folder' || entry.source === 'companion') && Date.now() - (entry.dslog?.mtime ?? 0) < 20000;

  // Keyboard shortcuts for the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const m = analysis.match;
      const tabs: Tab[] = ['overview', 'graphs', 'events', 'power', 'details'];
      const pad = (a: number, b: number) => group.setRange(a - 2, b + 2);
      const onGraphs = tab === 'graphs';
      switch (e.key) {
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
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
        case 'j':
        case 'k': {
          const list = (events?.events ?? []).filter((ev) => ev.kind === 'error' || (ev.kind === 'warning' && !ev.tags.includes('tracer')));
          if (!list.length) break;
          const ref = group.pinned ?? (e.key === 'j' ? -Infinity : Infinity);
          const next = e.key === 'j' ? list.find((ev) => ev.t > ref + 1e-3) : [...list].reverse().find((ev) => ev.t < ref - 1e-3);
          if (next) {
            if (tab !== 'graphs') setTab('graphs');
            group.pin(next.t);
          }
          break;
        }
        case '/':
          if (tab === 'events') {
            e.preventDefault();
            document.getElementById('events-search')?.focus();
          }
          break;
        case 'Escape':
          if (group.pinned != null) group.pin(null, false);
          else if (tab !== 'overview') setTab('overview');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [group, analysis, events, tab, setTab]);

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

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="viewer-title">
          <span className={`head-light ${verdict}`} title={verdict === 'ok' ? 'Healthy' : verdict === 'warn' ? 'Warnings' : 'Problems'} />
          <div style={{ minWidth: 0 }}>
            <h1>
              {analysis.title}
              {live && (
                <span className="live-tag">
                  <span className="live-dot" /> Live
                </span>
              )}
              {refreshing && <div className="spinner" style={{ width: 13, height: 13 }} />}
            </h1>
            <div className="viewer-sub">
              {[meta?.eventName, meta?.team && `Team ${meta.team}`, fmtDateTime(start)].filter(Boolean).join('  ·  ')}
            </div>
          </div>
        <div className="tabs" role="tablist">
          {(
            [
              ['overview', 'Summary'],
              ['graphs', 'Graphs'],
              ['events', 'Messages'],
              ['power', 'Power'],
              ['details', 'Details'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
          <div className="viewer-actions">
            <div className="menu-wrap">
              <button className="btn icon round" onClick={() => setMenu(menu ? null : 'more')} title="Export, compare and more" aria-label="More">
                <Icon name="more" size={18} />
              </button>
              {menu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenu(null)} />
                  <div className="menu" onClick={() => setMenu(null)}>
                    <button className="item" onClick={exportActions.summary}>
                      <Icon name="copy" />
                      <span>
                        Copy summary
                        <small>The fix list as text for Discord / Slack</small>
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
      </div>
      {parsed.warnings.length > 0 && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="banner">
            <Icon name="alert" /> {parsed.warnings.join(' · ')}
          </div>
        </div>
      )}
      {tab === 'overview' && <RobotMap ctx={ctx} />}
      {tab === 'details' && <Overview ctx={ctx} />}
      {tab === 'graphs' && <Graphs ctx={ctx} channels={channels} setChannels={setChannels} />}
      {tab === 'power' && <Power ctx={ctx} channels={channels} setChannels={setChannels} />}
      {tab === 'events' && <EventsView ctx={ctx} initial={eventFilter} />}
      <KeyBar
        keys={
          tab === 'overview'
            ? [['← → ↑ ↓', 'move'], ['Enter', 'graph'], ['Space', 'checked'], ['N', 'next problem'], ['M', 'messages']]
            : tab === 'graphs'
              ? [['← →', 'pan'], ['+ −', 'zoom'], ['A T M F', 'auto · teleop · match · all'], ['J K', 'next / prev issue'], ['Esc', 'back']]
              : tab === 'events'
                ? [['/', 'search'], ['J K', 'jump to issue on graph'], ['Esc', 'back']]
                : [['Esc', 'back']]
        }
      />
    </div>
  );
}

