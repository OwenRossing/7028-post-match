import { useEffect, useMemo, useState } from 'react';
import { MIN_HISTORY, type HistoryStatus } from '../lib/baseline';
import { hasDS, summaryKeyOf, type LogEntry } from '../lib/library';
import { isHolding, UNSORTED, type EventInfo } from '../lib/events';
import { describeDelete, planDelete } from '../lib/manage';
import { fmtClock, fmtDate, fmtSpan } from '../lib/time';
import { FileChips } from './FileChips';
import { Icon } from './Icon';

type Filter = 'all' | 'matches' | 'enabled' | 'issues';

/** Which logs the open match is being compared against (see lib/baseline.ts). */
export interface BaselineInfo {
  title: string;
  /** The sample match shows made-up history instead. */
  demo: boolean;
  status: Map<string, HistoryStatus>;
}

interface Props {
  entries: LogEntry[];
  baseline: BaselineInfo | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  indexing: number;
  compareSelecting: boolean;
  compareKeys: string[];
  toggleCompare: (key: string) => void;
  startCompare: () => void;
  cancelCompare: () => void;
  beginCompare: () => void;
  onClearSaved: () => void;
  /** Deletes matches (saved ones are removed, ones from a watched folder are hidden). */
  onDelete: (keys: string[]) => void | Promise<void>;
  /** Empties the library. */
  onClearAll: () => void | Promise<void>;
  /** How many matches and robot logs are hidden (deleted from a watched folder). */
  hidden: number;
  onShowHidden: () => void;
  /** Matches grouped into events, and which event each is in. */
  events: EventInfo[];
  eventOf: Map<string, string>;
  onCreateEvent: (name: string) => void;
  onRenameEvent: (id: string, name: string) => void;
  onMoveToEvent: (keys: string[], id: string) => void;
  /** Deletes the matches of an event, and the event itself when the user made it. */
  onDeleteEvent: (id: string, keys: string[]) => void | Promise<void>;
  /** Asks for files to add to this event. */
  onAddToEvent: (id: string) => void;
}

function matchesQuery(e: LogEntry, q: string): boolean {
  if (!q) return true;
  const s = e.summary;
  const hay = [
    e.key,
    s?.title,
    s?.eventName,
    s?.team,
    s?.matchType,
    s?.matchNumber != null ? `q${s.matchNumber}` : '',
    fmtDate(e.startTime),
  ]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

function shortTitle(e: LogEntry): string {
  if (e.robot) return e.robot.title;
  const s = e.summary;
  if (!s) return e.key;
  if (s.isMatch && s.matchType && s.matchNumber && s.fms) {
    const t = s.matchType;
    const prefix = t.startsWith('Qual')
      ? 'Qual'
      : t.startsWith('Pract')
        ? 'Practice'
        : t.startsWith('Elim') || t.startsWith('Play')
          ? 'Playoff'
          : t;
    return `${prefix} ${s.matchNumber}`;
  }
  return s.title;
}

export function Library(props: Props) {
  const { entries, baseline, selectedKey, onSelect, indexing, compareSelecting, compareKeys } = props;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [onlyBaseline, setOnlyBaseline] = useState(false);
  const [managing, setManaging] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const status = baseline && !baseline.demo ? baseline.status : null;
  const used = useMemo(() => entries.filter((e) => status?.get(e.key)?.used), [entries, status]);
  const skipped = useMemo(
    () =>
      entries.flatMap((e) =>
        status && !status.get(e.key)?.used && e.key !== selectedKey
          ? [{ e, reason: (status.get(e.key) as { reason: string } | undefined)?.reason ?? '' }]
          : [],
      ),
    [entries, status, selectedKey],
  );
  const filterByBaseline = onlyBaseline && !!status;

  const shown = useMemo(
    () =>
      entries.filter((e) => {
        if (filterByBaseline && !status?.get(e.key)?.used) return false;
        if (!matchesQuery(e, q.trim())) return false;
        const s = e.summary;
        if (filter === 'matches') return !!s?.isMatch;
        if (filter === 'enabled') return !!s && s.enabledTime > 0;
        if (filter === 'issues') return !!s && s.verdict !== 'ok';
        return true;
      }),
    [entries, q, filter, filterByBaseline, status],
  );

  /** Consecutive matches on the same day, for the day rows inside an event. */
  const dayGroups = (items: LogEntry[]) => {
    const out: { label: string; events: Set<string>; items: LogEntry[] }[] = [];
    for (const e of items) {
      const label = fmtDate(e.startTime);
      let g = out[out.length - 1];
      if (!g || g.label !== label) {
        g = { label, events: new Set(), items: [] };
        out.push(g);
      }
      if (e.summary?.eventName) g.events.add(e.summary.eventName);
      g.items.push(e);
    }
    return out;
  };

  // The events, each with its days. Empty events the user made show unless the list is being filtered.
  const filtering = q.trim() !== '' || filter !== 'all' || filterByBaseline;
  const eventGroups = useMemo(() => {
    const byEvent = new Map<string, LogEntry[]>();
    for (const e of shown) {
      const id = props.eventOf.get(e.key) ?? UNSORTED;
      byEvent.set(id, [...(byEvent.get(id) ?? []), e]);
    }
    return props.events.filter((ev) => byEvent.has(ev.id) || (!filtering && ev.manual)).map((ev) => ({ ev, items: byEvent.get(ev.id) ?? [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, props.events, props.eventOf, filtering]);

  // Events fold away; with a lot of matches only the newest and the open one start open.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const isOpen = (ev: EventInfo, index: number) => filtering || (folded[ev.id] !== undefined ? !folded[ev.id] : entries.length <= 60 || index === 0 || (!!selectedKey && ev.keys.includes(selectedKey)));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // an open event menu closes when anything else is clicked
  useEffect(() => {
    if (menuFor == null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.lib-event-menu')) setMenuFor(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuFor]);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  const hasSaved = entries.some((e) => e.source === 'saved' || e.source === 'upload');
  const stored = useStorageUsed(entries.length);

  // ---- managing: pick matches and delete them, or clear the library ----
  const chosen = useMemo(() => {
    const have = new Set(entries.map((e) => e.key));
    return [...picked].filter((k) => have.has(k));
  }, [picked, entries]);
  const setMany = (keys: string[], on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      for (const k of keys) (on ? n.add(k) : n.delete(k));
      return n;
    });
  const leave = () => {
    setManaging(false);
    setPicked(new Set());
  };
  useEffect(() => {
    if (managing && !entries.length) leave();
  }, [managing, entries.length]);
  const allShown = shown.length > 0 && shown.every((e) => picked.has(e.key));
  const removeChosen = async () => {
    if (!chosen.length || !confirm(describeDelete(planDelete(entries, chosen)))) return;
    await props.onDelete(chosen);
    setPicked(new Set());
  };
  const clearAll = () => {
    if (!confirm(describeDelete(planDelete(entries, entries.map((e) => e.key)), { all: true }))) return;
    void props.onClearAll();
    leave();
  };

  return (
    <aside className="sidebar">
      {compareSelecting && (
        <div className="compare-bar">
          <span>
            Pick logs to compare <b>({compareKeys.length}/6)</b>
          </span>
          <span className="row" style={{ gap: 4 }}>
            <button className="btn small primary" disabled={compareKeys.length < 2} onClick={props.startCompare}>
              Compare
            </button>
            <button className="btn small ghost" onClick={props.cancelCompare}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {managing && !compareSelecting && (
        <>
          <div className="compare-bar manage-bar">
            <span>{chosen.length ? <b>{chosen.length} selected</b> : 'Pick matches to delete'}</span>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn small ghost" onClick={() => setMany(shown.map((e) => e.key), !allShown)}>
                {allShown ? 'None' : 'All'}
              </button>
              <button className="btn small danger" disabled={!chosen.length} onClick={() => void removeChosen()}>
                <Icon name="trash" size={13} /> Delete
              </button>
              <button className="btn small ghost" onClick={leave}>
                Done
              </button>
            </span>
          </div>
          <div className="manage-more">
            <select
              className="input manage-move"
              value=""
              disabled={!chosen.length}
              aria-label="Move the selected matches to an event"
              onChange={(ev) => {
                if (ev.target.value) {
                  props.onMoveToEvent(chosen, ev.target.value);
                  setPicked(new Set());
                }
              }}
            >
              <option value="">Move to event…</option>
              {props.events
                .filter((x) => !isHolding(x.id))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
            <button className="link" onClick={clearAll}>
              Clear the whole library…
            </button>
            {props.hidden > 0 && (
              <button className="link" onClick={props.onShowHidden}>
                Show {props.hidden} hidden
              </button>
            )}
          </div>
        </>
      )}
      <div className="sidebar-head">
        <div className="sidebar-title">
          <span className="sidebar-count">Library · {entries.length}</span>
          {indexing > 0 && (
            <span className="row" style={{ gap: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 500 }} title="Reading logs in the background">
              <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> {indexing}
            </span>
          )}
        </div>
        {!compareSelecting && !managing && (
          <div className="sidebar-actions">
            <button className="btn small ghost" onClick={() => setCreating('')} title="Make an event to collect logs in">
              <Icon name="plus" size={13} /> Event
            </button>
            {entries.length > 0 && (
              <button className="btn small ghost" onClick={() => setManaging(true)} title="Pick matches to delete or move, or clear the library">
                <Icon name="list" size={13} /> Manage
              </button>
            )}
            {entries.length > 1 && (
              <button className="btn small ghost" onClick={props.beginCompare} title="Compare logs">
                <Icon name="compare" size={13} /> Compare
              </button>
            )}
          </div>
        )}
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Search: q22, MNST, practice…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          {(
            [
              ['all', 'All'],
              ['matches', 'Matches'],
              ['enabled', 'Enabled'],
              ['issues', 'Issues'],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {baseline && !compareSelecting && (
        <div className="lib-base">
          <div className="lib-base-head">
            <span className="lib-base-label">Compared against</span>
            {status && used.length > 0 && (
              <button className="link" onClick={() => setOnlyBaseline((v) => !v)}>
                {onlyBaseline ? 'Show all logs' : 'Show only these'}
              </button>
            )}
          </div>
          {baseline.demo ? (
            <p>
              <b>Made-up demo matches.</b> Only for the sample.
            </p>
          ) : used.length >= MIN_HISTORY ? (
            <p>
              <b>{used.length} earlier matches</b>, tagged below.
            </p>
          ) : (
            <p>
              <b>
                {used.length} of {MIN_HISTORY}
              </b>{' '}
              earlier matches so far.
            </p>
          )}
          {status && skipped.length > 0 && (
            <details className="lib-base-skipped">
              <summary>
                {skipped.length} {skipped.length === 1 ? 'log' : 'logs'} not used
              </summary>
              <ul>
                {skipped.slice(0, 40).map(({ e, reason }) => (
                  <li key={e.key}>
                    <span className="mono">{e.key}</span>
                    <span>{reason}</span>
                  </li>
                ))}
                {skipped.length > 40 && <li className="faint">and {skipped.length - 40} more</li>}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="lib-list">
        {!entries.length && (
          <div className="lib-empty">No logs yet. Drop .dslog / .dsevents files anywhere, or connect the DS log folder.</div>
        )}
        {entries.length > 0 && !shown.length && <div className="lib-empty">Nothing matches.</div>}
        {creating !== null && (
          <form
            className="lib-new-event"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (creating.trim()) props.onCreateEvent(creating.trim());
              setCreating(null);
            }}
          >
            <input className="input" autoFocus placeholder="Event name, e.g. MNST week 1" value={creating} onChange={(ev) => setCreating(ev.target.value)} onKeyDown={(ev) => ev.key === 'Escape' && setCreating(null)} />
            <button className="btn small primary" type="submit" disabled={!creating.trim()}>
              Create
            </button>
            <button className="btn small ghost" type="button" onClick={() => setCreating(null)}>
              Cancel
            </button>
          </form>
        )}
        {eventGroups.map(({ ev, items }, index) => {
          const open = isOpen(ev, index);
          const days = dayGroups(items);
          const all = items.length > 0 && items.every((e) => picked.has(e.key));
          return (
            <section key={ev.id} className="lib-event">
              <div className={`lib-event-head ${menuFor === ev.id ? 'menu-open' : ''}`}>
                {managing && (
                  <input type="checkbox" className="lib-group-pick" aria-label={`Select all matches in ${ev.name}`} checked={all} onChange={(x) => setMany(items.map((e) => e.key), x.target.checked)} />
                )}
                <button className="lib-event-toggle" onClick={() => setFolded((f) => ({ ...f, [ev.id]: open }))} aria-expanded={open} title={open ? 'Fold this event' : 'Open this event'}>
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                </button>
                {renaming?.id === ev.id ? (
                  <input
                    className="input lib-event-rename"
                    autoFocus
                    value={renaming.value}
                    onChange={(x) => setRenaming({ id: ev.id, value: x.target.value })}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(x) => {
                      if (x.key === 'Enter') {
                        props.onRenameEvent(ev.id, renaming.value);
                        setRenaming(null);
                      } else if (x.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="lib-event-name" title={ev.name}>
                    {ev.name}
                  </span>
                )}
                <span className="lib-event-count">
                  {ev.keys.length ? `${ev.keys.length} ${ev.keys.length === 1 ? 'match' : 'matches'}` : 'empty'}
                </span>
                {!isHolding(ev.id) && !managing && (
                  <span className="lib-event-actions">
                    <button className="btn small ghost icon" onClick={() => props.onAddToEvent(ev.id)} title={`Add logs to ${ev.name}`} aria-label={`Add logs to ${ev.name}`}>
                      <Icon name="plus" size={13} />
                    </button>
                    <span className="lib-event-menu">
                      <button className="btn small ghost icon" onClick={() => setMenuFor(menuFor === ev.id ? null : ev.id)} title="More" aria-label={`More for ${ev.name}`}>
                        <Icon name="more" size={13} />
                      </button>
                      {menuFor === ev.id && (
                        <div className="menu lib-event-popup">
                          <button
                            className="item"
                            onClick={() => {
                              setMenuFor(null);
                              setRenaming({ id: ev.id, value: ev.name });
                            }}
                          >
                            Rename…
                          </button>
                          <button
                            className="item danger"
                            onClick={() => {
                              setMenuFor(null);
                              const what = ev.keys.length ? describeDelete(planDelete(entries, ev.keys)).replace(/^Delete/, `Delete the event "${ev.name}" and`) : `Delete the empty event "${ev.name}"?`;
                              if (confirm(what)) void props.onDeleteEvent(ev.id, ev.keys);
                            }}
                          >
                            Delete event…
                          </button>
                        </div>
                      )}
                    </span>
                  </span>
                )}
              </div>
              {open && !items.length && <div className="lib-event-empty">{ev.manual ? 'Nothing here yet. Use + to add logs to this event.' : 'Nothing matches.'}</div>}
              {open &&
                days.map((g) => (
                  <div key={g.label}>
                    <div className="lib-group">
                      {managing && (
                        <input
                          type="checkbox"
                          className="lib-group-pick"
                          aria-label={`Select all matches on ${g.label}`}
                          checked={g.items.every((e) => picked.has(e.key))}
                          onChange={(x) => setMany(g.items.map((e) => e.key), x.target.checked)}
                        />
                      )}
                      <span>{g.label}</span>
                      <span>{`${g.items.length} ${g.items.length === 1 ? 'match' : 'matches'}`}</span>
                    </div>
                    {g.items.map((e) => (
                      <Row
                        key={e.key}
                        e={e}
                        selected={selectedKey === e.key}
                        compare={compareSelecting || managing}
                        checked={managing ? picked.has(e.key) : compareKeys.includes(e.key)}
                        inBaseline={!compareSelecting && !managing && !!status?.get(e.key)?.used}
                        showFile={filterByBaseline}
                        reason={status && e.key !== selectedKey ? (status.get(e.key) as { reason?: string } | undefined)?.reason : undefined}
                        onClick={() =>
                          managing ? setMany([e.key], !picked.has(e.key)) : compareSelecting ? hasDS(e) && props.toggleCompare(e.key) : onSelect(e.key)
                        }
                      />
                    ))}
                  </div>
                ))}
            </section>
          );
        })}
      </div>
      {(hasSaved || props.hidden > 0) && (
        <div className="sidebar-foot">
          <span title="Logs are kept in this browser, so there is no limit but the browser's own: it holds as much as your disk allows">
            {hasSaved ? `Saved in this browser${stored ? ` · ${stored}` : ''}` : `${props.hidden} hidden`}
          </span>
          <span className="row" style={{ gap: 4 }}>
            {props.hidden > 0 && (
              <button className="btn small ghost" onClick={props.onShowHidden} title="Bring back matches and robot logs you deleted from a watched folder">
                Show {props.hidden} hidden
              </button>
            )}
            {hasSaved && (
              <button
                className="btn small ghost"
                onClick={() =>
                  confirm('Remove all saved logs from this browser? Logs in a connected folder are not affected.') && props.onClearSaved()
                }
                title="Remove saved logs"
              >
                <Icon name="trash" size={13} />
              </button>
            )}
          </span>
        </div>
      )}
    </aside>
  );
}

/** How much this browser is holding for the app, e.g. "148 MB". Re-read whenever the number of logs changes. */
function useStorageUsed(dep: number): string {
  const [text, setText] = useState('');
  useEffect(() => {
    let cancelled = false;
    navigator.storage?.estimate?.().then(
      (e) => {
        if (cancelled || e.usage == null) return;
        setText(e.usage >= 1e9 ? `${(e.usage / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(e.usage / 1e6))} MB`);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [dep]);
  return text;
}

function Row({
  e,
  selected,
  compare,
  checked,
  inBaseline,
  showFile,
  reason,
  onClick,
}: {
  e: LogEntry;
  selected: boolean;
  compare: boolean;
  checked: boolean;
  /** Part of what the open match is compared against. */
  inBaseline: boolean;
  /** Show the file name (the Show only these view). */
  showFile: boolean;
  /** Why this log is not part of the comparison, when there is one. */
  reason?: string;
  onClick: () => void;
}) {
  const s = e.summary;
  const pending = hasDS(e) && e.summaryKey !== summaryKeyOf(e) && !e.summaryError;
  const live = (e.source === 'folder' || e.source === 'companion') && Date.now() - (e.dslog?.mtime ?? 0) < 20000;
  const idle = s && !s.enabledTime && !s.isMatch;
  return (
    <div
      className={`lib-row ${selected ? 'selected' : ''} ${inBaseline ? 'in-baseline' : ''}`}
      onClick={onClick}
      style={idle && !selected ? { opacity: 0.62 } : undefined}
      title={reason ? `Not part of the comparison: ${reason}` : undefined}
    >
      {compare ? (
        <input type="checkbox" checked={checked} readOnly />
      ) : (
        <span
          className={`dot ${s ? s.verdict : 'none'}`}
          title={s ? (s.verdict === 'ok' ? 'Healthy' : `${s.problemCount} issue(s)`) : 'Not read yet'}
        />
      )}
      <span className="title">
        {shortTitle(e)}
        {inBaseline && <span className="lib-tag">baseline</span>}
      </span>
      <span className="time">{fmtClock(e.startTime, false)}</span>
      {showFile && (
        <div className="lib-file mono" title="The files read for this match">
          {e.key}
          <span>{[e.dslog && '.dslog', e.dsevents && '.dsevents', ...(e.extras ?? []).map((x) => `.${x.kind}`)].filter(Boolean).join(' + ')}</span>
        </div>
      )}
      <div className="meta">
        {e.summaryError ? (
          <span style={{ color: 'var(--bad)' }}>Unreadable: {e.summaryError}</span>
        ) : e.robot ? (
          <span>Robot log only · waiting for the Driver Station log</span>
        ) : s ? (
          <span>
            {[
              fmtSpan(s.duration),
              Number.isFinite(s.minVoltage) && s.enabledTime > 0 && `${s.minVoltage.toFixed(1)} V`,
              s.verdict !== 'ok' && `${s.problemCount} issue${s.problemCount === 1 ? '' : 's'}`,
              !s.hasDslog && 'messages only',
              !s.hasEvents && 'no messages',
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </span>
        ) : pending ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> reading…
          </span>
        ) : null}
        {live && (
          <span className="badge good">
            <span className="live-dot" style={{ width: 6, height: 6 }} /> live
          </span>
        )}
      </div>
      <div className="lib-chips">
        <FileChips entry={e} compact />
      </div>
    </div>
  );
}
