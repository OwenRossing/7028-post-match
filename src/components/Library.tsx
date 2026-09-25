import { useMemo, useState } from 'react';
import { versionKey, type LogEntry } from '../lib/library';
import { fmtClock, fmtDate, fmtSpan } from '../lib/time';
import { Icon } from './Icon';

type Filter = 'all' | 'matches' | 'enabled' | 'issues';

interface Props {
  entries: LogEntry[];
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
  const s = e.summary;
  if (!s) return e.key;
  if (s.isMatch && s.matchType && s.matchNumber && s.fms) {
    const t = s.matchType;
    const prefix = t.startsWith('Qual') ? 'Qual' : t.startsWith('Pract') ? 'Practice' : t.startsWith('Elim') || t.startsWith('Play') ? 'Playoff' : t;
    return `${prefix} ${s.matchNumber}`;
  }
  return s.title;
}

export function Library(props: Props) {
  const { entries, selectedKey, onSelect, indexing, compareSelecting, compareKeys } = props;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(
    () =>
      entries.filter((e) => {
        if (!matchesQuery(e, q.trim())) return false;
        const s = e.summary;
        if (filter === 'matches') return !!s?.isMatch;
        if (filter === 'enabled') return !!s && s.enabledTime > 0;
        if (filter === 'issues') return !!s && s.verdict !== 'ok';
        return true;
      }),
    [entries, q, filter],
  );

  const groups = useMemo(() => {
    const out: { label: string; events: Set<string>; items: LogEntry[] }[] = [];
    for (const e of shown) {
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
  }, [shown]);

  const hasSaved = entries.some((e) => e.source === 'saved' || e.source === 'upload');

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
      <div className="sidebar-head">
        <div className="sidebar-title">
          <span>Library · {entries.length}</span>
          <span className="row" style={{ gap: 4 }}>
            {indexing > 0 && (
              <span className="row" style={{ gap: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 500 }} title="Reading logs in the background">
                <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> {indexing}
              </span>
            )}
            {!compareSelecting && entries.length > 1 && (
              <button className="btn small ghost" onClick={props.beginCompare} title="Compare logs" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Icon name="compare" size={13} /> Compare
              </button>
            )}
          </span>
        </div>
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
      <div className="lib-list">
        {!entries.length && <div className="lib-empty">No logs yet. Drop .dslog / .dsevents files anywhere, or connect the DS log folder.</div>}
        {entries.length > 0 && !shown.length && <div className="lib-empty">Nothing matches.</div>}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="lib-group">
              <span>{g.label}</span>
              <span>{[...g.events].join(', ')}</span>
            </div>
            {g.items.map((e) => (
              <Row
                key={e.key}
                e={e}
                selected={selectedKey === e.key}
                compare={compareSelecting}
                checked={compareKeys.includes(e.key)}
                onClick={() => (compareSelecting ? props.toggleCompare(e.key) : onSelect(e.key))}
              />
            ))}
          </div>
        ))}
      </div>
      {hasSaved && (
        <div className="sidebar-foot">
          <span>Opened logs are saved in this browser for offline use.</span>
          <button
            className="btn small ghost"
            onClick={() => confirm('Remove all saved logs from this browser? Logs in a connected folder are not affected.') && props.onClearSaved()}
            title="Remove saved logs"
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      )}
    </aside>
  );
}

function Row({ e, selected, compare, checked, onClick }: { e: LogEntry; selected: boolean; compare: boolean; checked: boolean; onClick: () => void }) {
  const s = e.summary;
  const pending = e.summaryKey !== versionKey(e) && !e.summaryError;
  const live = (e.source === 'folder' || e.source === 'companion') && Date.now() - (e.dslog?.mtime ?? 0) < 20000;
  const idle = s && !s.enabledTime && !s.isMatch;
  return (
    <div className={`lib-row ${selected ? 'selected' : ''}`} onClick={onClick} style={idle && !selected ? { opacity: 0.62 } : undefined}>
      {compare ? (
        <input type="checkbox" checked={checked} readOnly />
      ) : (
        <span className={`dot ${s ? s.verdict : 'none'}`} title={s ? (s.verdict === 'ok' ? 'Healthy' : `${s.problemCount} issue(s)`) : 'Not read yet'} />
      )}
      <span className="title">{shortTitle(e)}</span>
      <span className="time">{fmtClock(e.startTime, false)}</span>
      <div className="meta">
        {e.summaryError ? (
          <span style={{ color: 'var(--bad)' }}>Unreadable: {e.summaryError}</span>
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
    </div>
  );
}
