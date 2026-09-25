import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DSEvent, EventKind } from '../../lib/dsevents';
import { download, eventsToCsv, safeFileName } from '../../lib/export';
import { Icon } from '../Icon';
import { useGroupValue, type EventFilter, type ViewCtx } from './types';

const KINDS: { kind: EventKind; label: string; color: string; help: string }[] = [
  { kind: 'error', label: 'Errors', color: 'var(--bad)', help: 'Errors reported by robot code or vendor libraries' },
  { kind: 'warning', label: 'Warnings', color: 'var(--warn)', help: 'Warnings reported by robot code or vendor libraries' },
  { kind: 'print', label: 'Prints', color: 'var(--faint)', help: 'System.out / print() output from the robot' },
  { kind: 'ds', label: 'Driver Station', color: 'var(--info)', help: 'Diagnostics from the Driver Station itself' },
  { kind: 'fms', label: 'FMS', color: 'var(--test)', help: 'Field management system messages' },
];

const TAG_LABEL: Record<string, string> = {
  can: 'CAN',
  loop: 'Loop overruns',
  tracer: 'Loop timing',
  comms: 'Comms',
  nt: 'NetworkTables',
  rail: 'Rail faults',
  crash: 'Crashes',
  brownout: 'Brownouts',
  joystick: 'Joysticks',
  error: 'Errors',
  ping: 'Ping results',
};

type Scope = 'all' | 'match' | 'zoom';

const ALL_KINDS: EventKind[] = ['error', 'warning', 'print', 'ds', 'fms'];
const PROBLEM_KINDS: EventKind[] = ['error', 'warning'];

interface Row {
  first: DSEvent;
  count: number;
  last: DSEvent;
}

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let k = 0;
  while (true) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    out.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

export function EventsView({ ctx, initial }: { ctx: ViewCtx; initial: EventFilter & { nonce: number } }) {
  const { parsed, group, tf } = ctx;
  const events = parsed.events?.events ?? [];
  const match = parsed.analysis.match;
  // Opens on what matters under time pressure: errors and warnings from the match, repeats grouped.
  const [kinds, setKinds] = useState<Set<EventKind>>(new Set(PROBLEM_KINDS));
  const [tag, setTag] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [hideTracer, setHideTracer] = useState(true);
  const [scope, setScope] = useState<Scope>(match ? 'match' : 'all');
  const [open, setOpen] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [limit, setLimit] = useState(300);
  const range = useGroupValue(group, 'range', () => group.range);
  const zoomed = useMemo(() => group.isZoomedFrom(parsed.analysis.focus), [group, range, parsed.analysis.focus]);

  useEffect(() => {
    if (!initial.nonce) return;
    if (initial.tag === 'error') {
      setTag(undefined);
      setKinds(new Set(['error']));
    } else {
      setTag(initial.tag);
      setKinds(initial.kind ? new Set([initial.kind]) : new Set(ALL_KINDS));
    }
    if (initial.tag === 'tracer') setHideTracer(false);
    setQ(initial.text ?? '');
    setScope('all');
    setOpen(null);
  }, [initial]);

  const needle = q.trim().toLowerCase();

  const base = useMemo(() => {
    const span =
      scope === 'match' && match ? { start: match.start, end: match.end } : scope === 'zoom' && zoomed ? range : null;
    return events.filter(
      (e) =>
        (!span || (e.t >= span.start && e.t <= span.end)) &&
        (!tag || e.tags.includes(tag)) &&
        (!hideTracer || tag === 'tracer' || !e.tags.includes('tracer')) &&
        (!needle ||
          e.text.toLowerCase().includes(needle) ||
          (e.location ?? '').toLowerCase().includes(needle) ||
          String(e.code ?? '') === needle),
    );
  }, [events, scope, match, zoomed, range, tag, hideTracer, needle]);

  const counts = useMemo(() => {
    const c: Record<EventKind, number> = { error: 0, warning: 0, print: 0, ds: 0, fms: 0 };
    for (const e of base) c[e.kind]++;
    return c;
  }, [base]);

  const rows: Row[] = useMemo(() => {
    const list = base.filter((e) => kinds.has(e.kind));
    if (!grouped) return list.map((e) => ({ first: e, last: e, count: 1 }));
    const map = new Map<string, Row>();
    for (const e of list) {
      const r = map.get(e.sig);
      if (r) {
        r.count++;
        r.last = e;
      } else map.set(e.sig, { first: e, last: e, count: 1 });
    }
    // errors above warnings, then the most repeated
    const kindRank = (k: EventKind) => (k === 'error' ? 0 : k === 'warning' ? 1 : 2);
    return [...map.values()].sort((a, b) => kindRank(a.first.kind) - kindRank(b.first.kind) || b.count - a.count || a.first.t - b.first.t);
  }, [base, kinds, grouped]);

  const problemsOnly = kinds.size === 2 && kinds.has('error') && kinds.has('warning');

  const toggleKind = (k: EventKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const exportCsv = () =>
    download(
      eventsToCsv(rows.map((r) => r.first).filter(Boolean), match?.start),
      `${safeFileName(`${parsed.analysis.title} ${ctx.entry.key}`)} messages.csv`,
      'text/csv',
    );

  if (!parsed.events)
    return (
      <div className="page">
        <div className="banner info">
          <Icon name="info" /> No .dsevents file for this log. Drop the matching <code>{ctx.entry.key}.dsevents</code> to see messages.
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Which messages">
          <button className={problemsOnly ? 'on' : ''} onClick={() => { setKinds(new Set(PROBLEM_KINDS)); setGrouped(true); }}>
            Problems
          </button>
          <button className={kinds.size === ALL_KINDS.length ? 'on' : ''} onClick={() => { setKinds(new Set(ALL_KINDS)); setGrouped(false); }}>
            Everything
          </button>
        </div>
        <div className="search" style={{ flex: '1 1 220px' }}>
          <Icon name="search" size={15} />
          <input
            className="input"
            id="events-search"
            placeholder="Search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(300);
            }}
          />
        </div>
        <button className={`btn icon round ${filtersOpen ? 'active' : ''}`} onClick={() => setFiltersOpen((f) => !f)} title="Filters" aria-expanded={filtersOpen}>
          <Icon name="filter" size={16} />
        </button>
      </div>

      {tag && (
        <div className="row">
          <button className="chip on" onClick={() => setTag(undefined)} title="Remove filter">
            Only: {TAG_LABEL[tag] ?? tag} <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {filtersOpen && (
        <div className="filters-panel">
          <div className="row">
            <div className="seg">
              <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
                Whole log
              </button>
              {match && (
                <button className={scope === 'match' ? 'on' : ''} onClick={() => setScope('match')}>
                  Match only
                </button>
              )}
              {zoomed && (
                <button className={scope === 'zoom' ? 'on' : ''} onClick={() => setScope('zoom')}>
                  Zoomed range
                </button>
              )}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              Group repeats
            </label>
            <label className="toggle" title="WPILib prints a timing breakdown after each loop overrun">
              <input type="checkbox" checked={hideTracer} onChange={(e) => setHideTracer(e.target.checked)} />
              Hide loop timing dumps
            </label>
            <span style={{ flex: 1 }} />
            <button className="btn small" onClick={exportCsv}>
              <Icon name="download" size={13} /> CSV
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {KINDS.map((k) => (
              <button
                key={k.kind}
                className={`chip ${kinds.has(k.kind) ? 'on' : ''}`}
                style={{ ['--chip-color' as string]: k.color }}
                onClick={() => toggleKind(k.kind)}
                title={k.help}
              >
                <span className="dot" />
                {k.label}
                <span className="count">{counts[k.kind]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="ev-table">
          <tbody>
            {rows.slice(0, limit).map((r) => {
              const e = r.first;
              const isOpen = open === e.id;
              const [firstLine, ...rest] = e.text.split('\n');
              return (
                <Fragment key={e.id}>
                  <tr className={`ev-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : e.id)}>
                    <td className="c-time">{tf.fmt(e.t)}</td>
                    <td className="c-kind">
                      <span className={`badge ${e.kind === 'error' ? 'bad' : e.kind === 'warning' ? 'warn' : e.kind === 'ds' ? 'info' : ''}`}>
                        {e.kind === 'ds' ? 'DS' : e.kind === 'fms' ? 'FMS' : e.kind[0].toUpperCase() + e.kind.slice(1)}
                      </span>
                    </td>
                    <td className="c-msg">
                      {highlight(firstLine, needle)}
                      {rest.length > 0 && <span className="faint"> (+{rest.length} lines)</span>}
                      {e.location && <span className="loc">{highlight(e.location, needle)}</span>}
                    </td>
                    {grouped && <td className="c-count">{r.count > 1 && <span className="badge">×{r.count}</span>}</td>}
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={grouped ? 4 : 3} className="ev-detail">
                        <div className="row">
                          <button
                            className="btn small primary"
                            onClick={() => ctx.jumpTo(e.t, { width: 12 })}
                            disabled={!parsed.log}
                          >
                            <Icon name="activity" size={13} /> Show on graph
                          </button>
                          <button className="btn small" onClick={() => navigator.clipboard?.writeText(e.text + (e.stack ? `\n${e.stack}` : ''))}>
                            <Icon name="copy" size={13} /> Copy
                          </button>
                          {e.code != null && <span className="badge">Code {e.code}</span>}
                          {e.robotTime != null && <span className="badge">Robot time {e.robotTime.toFixed(3)} s</span>}
                          {grouped && r.count > 1 && (
                            <span className="badge accent">
                              {r.count}× from {tf.fmt(r.first.t)} to {tf.fmt(r.last.t)}
                            </span>
                          )}
                          {e.tags.map((t) => (
                            <button key={t} className="badge" style={{ border: 0, cursor: 'pointer' }} onClick={() => setTag(t)}>
                              #{TAG_LABEL[t] ?? t}
                            </button>
                          ))}
                        </div>
                        <pre>{e.text}</pre>
                        {e.location && (
                          <pre>
                            <b>Location:</b> {e.location}
                          </pre>
                        )}
                        {e.stack && <pre>{e.stack}</pre>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="lib-empty">
            {kinds.size === 2 && kinds.has('error') && kinds.has('warning') && !q && !tag
              ? `No errors or warnings${scope === 'match' ? ' during the match' : ''}.`
              : 'No messages match these filters.'}
          </div>
        )}
        {rows.length > limit && (
          <div className="lib-empty">
            <button className="btn" onClick={() => setLimit((l) => l + 500)}>
              Show more ({rows.length - limit} left)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
