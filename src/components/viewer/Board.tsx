import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Severity } from '../../lib/analysis';
import { classifyHistory, demoBaseline, judgeBoard, MIN_HISTORY, usesDemoHistory, type Baseline, type Judgement } from '../../lib/baseline';
import { buildBoard, walkRows, type Instance, type Row } from '../../lib/board';
import { useChecked } from '../../lib/checked';
import type { LogEntry } from '../../lib/library';
import { channelName } from '../../lib/settings';
import { Inspector } from './Inspector';
import { MatchStrip } from './MatchStrip';
import type { ViewCtx } from './types';

export type Tone = 'bad' | 'warn' | null;

/** A row as it sits on screen. */
export interface Cell {
  row: Row;
  col: number;
  depth: number;
  /** Ancestors, outermost first. */
  path: Row[];
  j?: Judgement;
  tone: Tone;
  /** Red rows hidden inside this one while it is folded. */
  hiddenFlags: number;
  kids: number;
  open: boolean;
  /** Ticked off by the pit crew: still shown, but no longer counted as unusual. */
  checked: boolean;
}

export interface BoardModel {
  cells: Cell[][];
  /** Every red row in reading order (including folded ones), with its ancestors. */
  flags: { id: string; col: number; path: string[] }[];
  /** Column and ancestor ids of every row, shown or folded away. */
  where: Map<string, { col: number; path: string[] }>;
  tone: (r: Row) => Tone;
  judgements: Map<string, Judgement>;
  baseline: Baseline;
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function fmtNumber(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function rowLabel(r: Row, ctx: ViewCtx): string {
  if (r.ch != null) return channelName(ctx.labels, r.ch);
  if (r.label === 'At' && r.at != null) return ctx.tf.fmt(r.at).replace(/(\.\d)\d+$/, '$1');
  return r.label;
}

/** "2.1× usual", "−1.32 V vs usual", "usually 0". */
export function deltaText(r: Row, j: Judgement): string {
  if (j.mean === 0) return 'usually 0';
  if (['V', '%', 'ms', 's', 'MB'].includes(r.unit)) {
    const d = j.value - j.mean;
    return `${d > 0 ? '+' : '−'}${fmtNumber(Math.abs(d), r.digits)} ${r.unit} vs usual`;
  }
  const ratio = j.value / j.mean;
  if (ratio >= 1.15) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× usual`;
  if (ratio <= 0.87) return `${Math.round((1 - ratio) * 100)}% under usual`;
  return `${j.z > 0 ? '+' : '−'}${Math.abs(j.z).toFixed(1)}σ`;
}

/** The Graphs row that shows a board row's signal. */
function signalOf(r: Row): string | undefined {
  if (r.trace?.kind !== 'series') return undefined;
  return r.trace.signal === 'channel' ? `ch${r.trace.ch}` : r.trace.signal;
}

export function Board({ ctx, entries }: { ctx: ViewCtx; entries: LogEntry[] }) {
  const { log, events, analysis } = ctx.parsed;
  const board = useMemo(() => buildBoard(log, events, analysis), [log, events, analysis]);

  const baseline = useMemo<Baseline>(() => {
    // Same inputs as the Library panel, which lists these logs.
    const { points } = classifyHistory(entries, {
      key: ctx.entry.key,
      startTime: ctx.entry.startTime,
      team: ctx.entry.summary?.team ?? events?.meta.team,
    });
    if (usesDemoHistory(ctx.entry, points.length)) return demoBaseline(board);
    return { points, demo: false };
  }, [entries, ctx.entry, events, board]);
  const judgements = useMemo(() => judgeBoard(board, baseline), [board, baseline]);

  const problemTone = useMemo(() => {
    const sev = new Map<string, Severity>(ctx.problems.map((p) => [p.id, p.severity]));
    return (r: Row): Tone => {
      if (!r.problems || (r.unit === '' && !(r.value > 0))) return null;
      const s = r.problems.map((id) => sev.get(id));
      return s.includes('bad') ? 'bad' : s.includes('warn') ? 'warn' : null;
    };
  }, [ctx.problems]);
  const tone = (r: Row): Tone => (judgements.get(r.id)?.flagged ? 'bad' : problemTone(r));

  // Everything starts folded: each column shows its headline rows, and a red badge says what is inside.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [checked, toggleChecked] = useChecked(ctx.entry.key);
  const visible = (r: Row) => !r.quiet || !!judgements.get(r.id)?.flagged;

  const model = useMemo<BoardModel>(() => {
    const cells: Cell[][] = [];
    const flags: BoardModel['flags'] = [];
    const where: BoardModel['where'] = new Map();
    board.columns.forEach((col, ci) => {
      const out: Cell[] = [];
      // Returns how many unchecked red rows are at or below these rows.
      const walk = (rows: Row[], depth: number, path: Row[], shown: boolean): number => {
        let reds = 0;
        for (const r of rows.filter(visible)) {
          const kids = (r.children ?? []).filter(visible);
          const isOpen = open[r.id] ?? false;
          const t = tone(r);
          const done = checked.has(r.id);
          const red = t === 'bad' && !done;
          where.set(r.id, { col: ci, path: path.map((p) => p.id) });
          if (red) flags.push({ id: r.id, col: ci, path: path.map((p) => p.id) });
          const cell: Cell = {
            row: r,
            col: ci,
            depth,
            path,
            j: judgements.get(r.id),
            tone: t,
            hiddenFlags: 0,
            kids: kids.length,
            open: isOpen,
            checked: done,
          };
          if (shown) out.push(cell);
          const inner = kids.length ? walk(kids, depth + 1, [...path, r], shown && isOpen) : 0;
          if (!isOpen) cell.hiddenFlags = inner;
          reds += inner + (red ? 1 : 0);
        }
        return reds;
      };
      walk(col.rows, 0, [], true);
      cells.push(out);
    });
    return { cells, flags, where, tone, judgements, baseline };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, judgements, open, problemTone, baseline, checked]);

  // ---------- Cursor ----------
  const [sel, setSel] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [pop, setPop] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [inst, setInst] = useState(0);

  const find = (id: string | null) => {
    if (id == null) return null;
    for (let c = 0; c < model.cells.length; c++) {
      const i = model.cells[c].findIndex((x) => x.row.id === id);
      if (i >= 0) return { c, i, cell: model.cells[c][i] };
    }
    return null;
  };
  let here = find(sel);
  const w = sel ? model.where.get(sel) : undefined;
  if (!here && w) {
    // Folded away: land on the nearest visible ancestor.
    here =
      [...w.path].reverse().map(find).find(Boolean) ?? (model.cells[w.col][0] ? { c: w.col, i: 0, cell: model.cells[w.col][0] } : null);
  }
  if (!here) {
    // Start on the first red row, or the first folded row with something red inside.
    for (let c = 0; c < model.cells.length && !here; c++) {
      const i = model.cells[c].findIndex((x) => (x.tone === 'bad' && !x.checked) || x.hiddenFlags > 0);
      if (i >= 0) here = { c, i, cell: model.cells[c][i] };
    }
    const c = model.cells.findIndex((col) => col.length);
    if (!here && c >= 0) here = { c, i: 0, cell: model.cells[c][0] };
  }
  const cur = here?.cell ?? null;

  useEffect(() => setInst(0), [cur?.row.id]);

  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!cur) return;
    rootRef.current?.querySelector(`[data-cell="${CSS.escape(cur.row.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur?.row.id, inspecting]);

  const select = (id: string) => setSel(id);
  const toggle = (r: Row, force?: boolean) => {
    const c = find(r.id)?.cell;
    if (!c?.kids) return;
    setOpen((o) => ({ ...o, [r.id]: force ?? !c.open }));
  };

  const moveRow = (d: number) => {
    if (!here) return;
    const col = model.cells[here.c];
    const next = col[Math.min(col.length - 1, Math.max(0, here.i + d))];
    if (next) select(next.row.id);
  };
  const moveCol = (d: number) => {
    if (!here) return;
    const y = rootRef.current?.querySelector(`[data-cell="${CSS.escape(here.cell.row.id)}"]`)?.getBoundingClientRect();
    for (let c = here.c + d; c >= 0 && c < model.cells.length; c += d) {
      const col = model.cells[c];
      if (!col.length) continue;
      let best = col[0];
      if (y) {
        let bestD = Infinity;
        for (const cell of col) {
          const r = rootRef.current?.querySelector(`[data-cell="${CSS.escape(cell.row.id)}"]`)?.getBoundingClientRect();
          if (!r) continue;
          const dist = Math.abs(r.top + r.height / 2 - (y.top + y.height / 2));
          if (dist < bestD) {
            bestD = dist;
            best = cell;
          }
        }
      }
      select(best.row.id);
      return;
    }
  };
  const jumpFlag = (d: 1 | -1) => {
    if (!model.flags.length) return;
    const order = model.flags;
    const at = order.findIndex((f) => f.id === cur?.row.id);
    const next = order[at < 0 ? (d > 0 ? 0 : order.length - 1) : (at + d + order.length) % order.length];
    if (next.path.length) setOpen((o) => ({ ...o, ...Object.fromEntries(next.path.map((p) => [p, true])) }));
    select(next.id);
  };

  const instances = (r: Row): Instance[] => r.instances ?? (r.at != null ? [{ t: r.at }] : []);
  const timeOf = (r: Row) => instances(r)[inst]?.t ?? r.at ?? instances(r)[0]?.t;

  const openGraphs = () => {
    if (!cur) return;
    const t = timeOf(cur.row);
    if (t != null && log) ctx.jumpTo(t, { signal: signalOf(cur.row), width: 12 });
    else ctx.setTab('graphs');
  };
  const openMessages = () => {
    if (!cur) return;
    const r = cur.row;
    const first = r.eventIds?.length ? events?.events[r.eventIds[0]] : undefined;
    ctx.showEvents(r.filter ?? (first ? { text: first.text.split('\n')[0].slice(0, 60) } : {}));
  };

  // One listener that always sees the latest state.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-back')) return;
    const r = cur?.row;
    const list = r ? instances(r) : [];
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        moveRow(1);
        break;
      case 'ArrowUp':
        moveRow(-1);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        if (inspecting && list.length > 1) setInst((i) => Math.min(list.length - 1, Math.max(0, i + d)));
        else moveCol(d);
        break;
      }
      case 'Home':
        if (here) select(model.cells[here.c][0].row.id);
        break;
      case 'End':
        if (here) select(model.cells[here.c][model.cells[here.c].length - 1].row.id);
        break;
      case ' ':
        if (r) toggle(r);
        break;
      case 'Enter':
        if (inspecting) openGraphs();
        else setInspecting(true);
        break;
      case 'Escape':
        if (inspecting) setInspecting(false);
        else handled = false;
        break;
      case 'j':
        jumpFlag(1);
        break;
      case 'k':
        jumpFlag(-1);
        break;
      case 'g':
        openGraphs();
        break;
      case 'm':
        openMessages();
        break;
      case 'x':
        if (r) toggleChecked(r.id);
        break;
      case 'i': {
        const rect = r?.hint ? rootRef.current?.querySelector(`[data-cell="${CSS.escape(r.id)}"]`)?.getBoundingClientRect() : undefined;
        if (r && rect) setPop((p) => (p?.id === r.id ? null : { id: r.id, rect }));
        break;
      }
      case 'e': {
        if (!here) break;
        const tops = board.columns[here.c].rows.filter((x) => x.children?.length);
        const anyClosed = model.cells[here.c].some((c) => c.kids && !c.open);
        setOpen((o) => ({ ...o, ...Object.fromEntries(tops.map((x) => [x.id, anyClosed])) }));
        if (!anyClosed && cur?.path.length) select(cur.path[0].id);
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, []);

  // Clicking anywhere outside the details panel closes it. A click on another row just moves the panel to that row.
  useEffect(() => {
    if (!inspecting) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.insp, .brow')) setInspecting(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [inspecting]);

  const flagCount = model.flags.length;
  const checkedCount = [...model.where.keys()].filter((id) => checked.has(id)).length;
  const side = here && here.c >= 3 ? 'left' : 'right';
  const selInstances = cur ? instances(cur.row) : [];

  return (
    <div className={`board ${inspecting ? `inspecting insp-${side}` : ''}`} ref={rootRef}>
      <div className="board-top">
        <BaselineNote baseline={baseline} />
        <MatchStrip ctx={ctx} range={board.range} marks={selInstances} active={inst} tone={cur?.tone ?? null} />
        <div className={`board-count ${flagCount ? 'bad' : 'ok'}`}>
          {flagCount ? (
            <>
              <b>{flagCount}</b> out of the ordinary
            </>
          ) : (
            'Nothing out of the ordinary'
          )}
          {checkedCount > 0 && <span className="board-checked">· {checkedCount} checked</span>}
        </div>
      </div>

      <div className="board-stage">
        <div className="board-cols">
          {board.columns.map((col, ci) => {
            const cells = model.cells[ci];
            const red = model.flags.filter((f) => f.col === ci).length;
            return (
              <section key={col.id} className={`bcol ${here?.c === ci ? 'active' : ''}`} aria-label={col.title}>
                <header className="bcol-head">
                  <h2>{col.title}</h2>
                  {red > 0 ? (
                    <span className="bcol-flag">{red}</span>
                  ) : (
                    cells.length > 0 && <span className="bcol-ok" title="Nothing unusual" />
                  )}
                </header>
                <div className="bcol-body">
                  {cells.length ? (
                    cells.map((c) => (
                      <BoardRow
                        key={c.row.id}
                        cell={c}
                        ctx={ctx}
                        selected={cur?.row.id === c.row.id}
                        // Mouse: a row with things inside folds and unfolds; a row without opens its details.
                        onClick={() => {
                          select(c.row.id);
                          if (c.kids) {
                            toggle(c.row);
                            setInspecting(false);
                          } else setInspecting(true);
                        }}
                        onDetails={() => {
                          select(c.row.id);
                          setInspecting(true);
                        }}
                        onInfo={(rect) => setPop((p) => (p?.id === c.row.id ? null : { id: c.row.id, rect }))}
                      />
                    ))
                  ) : (
                    <EmptyColumn id={col.id} ctx={ctx} />
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {pop && popRow(board, pop.id) && (
          <InfoPop
            title={rowLabel(popRow(board, pop.id)!, ctx)}
            text={popRow(board, pop.id)!.hint ?? ''}
            rect={pop.rect}
            onClose={() => setPop(null)}
          />
        )}
        {inspecting && cur && (
          <Inspector
            ctx={ctx}
            cell={cur}
            column={board.columns[cur.col].title}
            range={board.range}
            instance={inst}
            setInstance={setInst}
            side={side}
            onClose={() => setInspecting(false)}
            onGraphs={openGraphs}
            onMessages={openMessages}
          />
        )}
      </div>
    </div>
  );
}

function popRow(board: ReturnType<typeof buildBoard>, id: string): Row | undefined {
  for (const col of board.columns) for (const [r] of walkRows(col.rows)) if (r.id === id) return r;
}

/** The small "what is this?" popup next to a row's info button. */
function InfoPop({ title, text, rect, onClose }: { title: string; text: string; rect: DOMRect; onClose: () => void }) {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.info-pop, .brow-info')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const width = 320;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  const below = rect.bottom + 180 < window.innerHeight;
  return createPortal(
    <div
      className="info-pop"
      role="tooltip"
      style={{ left, width, ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) }}
    >
      <b>{title}</b>
      <p>{text}</p>
    </div>,
    document.body,
  );
}

function BoardRow({
  cell,
  ctx,
  selected,
  onClick,
  onDetails,
  onInfo,
}: {
  cell: Cell;
  ctx: ViewCtx;
  selected: boolean;
  onClick: () => void;
  onDetails: () => void;
  onInfo: (rect: DOMRect) => void;
}) {
  const { row: r, j, tone } = cell;
  const hasValue = Number.isFinite(r.value);
  const zero = hasValue && r.value === 0;
  const flagged = !!j?.flagged;
  return (
    <div
      className={[
        'brow',
        `d${Math.min(cell.depth, 3)}`,
        cell.checked ? 'checked' : (tone ?? ''),
        selected ? 'sel' : '',
        zero ? 'zero' : '',
        cell.kids ? 'parent' : '',
        r.label === 'At' ? 'instance' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-cell={r.id}
      onClick={onClick}
      onDoubleClick={onDetails}
      role="row"
      aria-selected={selected}
    >
      {cell.depth > 0 && <span className="brow-guide" aria-hidden="true" />}
      <span className="brow-twist" aria-hidden="true">
        {cell.kids ? <Chevron open={cell.open} /> : null}
      </span>
      <span className="brow-label">
        <span className="brow-line">
          <span className="brow-name">{rowLabel(r, ctx)}</span>
          {r.sub && <span className="brow-sub">{r.sub}</span>}
        </span>
        {flagged && j && !cell.checked && <span className="brow-delta">{deltaText(r, j)}</span>}
      </span>
      {cell.checked && (
        <span className="brow-check" title="Checked">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2.5 6.3 5 8.8l4.6-5.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      {!cell.open && cell.hiddenFlags > 0 && (
        <span className="brow-hidden" title={`${cell.hiddenFlags} unusual inside`}>
          {cell.hiddenFlags}
        </span>
      )}
      {r.hint && (
        <button
          className="brow-info"
          title="What is this?  (I)"
          aria-label="What is this?"
          onClick={(e) => {
            e.stopPropagation();
            onInfo(e.currentTarget.getBoundingClientRect());
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M7 6.2v3.6M7 4.2v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <span className="brow-value">
        {hasValue ? fmtNumber(r.value, r.digits) : ''}
        {hasValue && r.unit && <small>{r.unit}</small>}
      </span>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
      <path d="M3 1.5 6.8 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BaselineNote({ baseline }: { baseline: Baseline }) {
  const n = baseline.points.length;
  let body: ReactNode;
  if (baseline.demo)
    body = (
      <>
        Compared with <b>{n} demo matches</b>
      </>
    );
  else if (n >= MIN_HISTORY)
    body = (
      <>
        Compared with <b>last {n} matches</b>
      </>
    );
  else if (n > 0)
    body = (
      <>
        Learning what’s normal:{' '}
        <b>
          {n} of {MIN_HISTORY}
        </b>{' '}
        matches
      </>
    );
  else body = <>No earlier matches to compare</>;
  return (
    <div className={`board-base ${baseline.demo ? 'demo' : ''}`}>
      <span className="board-base-dot" />
      <span>{body}</span>
    </div>
  );
}

function EmptyColumn({ id, ctx }: { id: string; ctx: ViewCtx }) {
  if (id === 'performance')
    return (
      <div className="bcol-empty">
        <p>
          <b>Your own numbers.</b> Print one from robot code:
        </p>
        <pre>System.out.println("[pv] Flywheel/Spinup = " + secs + " s");</pre>
      </div>
    );
  const needs = !ctx.parsed.events ? '.dsevents' : !ctx.parsed.log ? '.dslog' : null;
  return <div className="bcol-empty muted">{needs ? `Needs the ${needs} file.` : 'Nothing logged.'}</div>;
}
