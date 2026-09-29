// "Is this normal for our robot?" Each board row is compared against the same row in the robot's
// recent matches. A row is flagged when it is 2+ standard deviations out in the direction that is worse.

import type { Board, Row } from './board';
import { walkRows } from './board';
import type { LogEntry } from './library';

/** How many earlier matches make up "normal". */
export const HISTORY_SIZE = 15;
/** Fewer matches than this and nothing is judged. */
export const MIN_HISTORY = 5;
export const FLAG_Z = 2;

export interface HistoryPoint {
  key: string;
  startTime: number;
  label: string;
  metrics: Record<string, number>;
}

export interface Baseline {
  points: HistoryPoint[];
  /** Synthetic history, only for the sample log. */
  demo: boolean;
}

export interface Judgement {
  /** This match's value. */
  value: number;
  /** Earlier matches, oldest first. */
  history: { label: string; value: number; key: string }[];
  n: number;
  mean: number;
  sd: number;
  /** The spread z is measured in: sd, but never below the row's noise floor or 5% of the mean. */
  spread: number;
  /** Standard deviations away, using a floor for rows that barely vary. */
  z: number;
  enough: boolean;
  flagged: boolean;
  /** 1 when above usual, -1 when below. */
  dir: 1 | -1 | 0;
}

/** "Qualification 22" → "Q22". */
export function shortLabel(title: string): string {
  const m = /^(Qualification|Playoff|Elimination|Practice|Final)s?\s*(?:match\s*)?(\d+)/i.exec(title);
  if (m) return `${m[1][0].toUpperCase()}${m[2]}`;
  return title.length > 10 ? title.slice(0, 9) + '…' : title;
}

/** The robot's matches before this one, newest last. */
export function pickHistory(entries: Iterable<LogEntry>, current: { key: string; startTime: number; team?: number }): HistoryPoint[] {
  return [...entries]
    .filter(
      (e) =>
        e.key !== current.key &&
        e.summary?.isMatch &&
        e.summary.metrics &&
        e.startTime < current.startTime &&
        (current.team == null || e.summary.team == null || e.summary.team === current.team),
    )
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, HISTORY_SIZE)
    .reverse()
    .map((e) => ({ key: e.key, startTime: e.startTime, label: shortLabel(e.summary!.title), metrics: e.summary!.metrics! }));
}

export function judge(row: Row, baseline: Baseline): Judgement | null {
  if (!row.better || !Number.isFinite(row.value)) return null;
  const history: Judgement['history'] = [];
  for (const p of baseline.points) {
    const v = p.metrics[row.id] ?? (row.zeroIfMissing ? 0 : undefined);
    if (v !== undefined && Number.isFinite(v)) history.push({ label: p.label, value: v, key: p.key });
  }
  const n = history.length;
  const mean = n ? history.reduce((a, h) => a + h.value, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(history.reduce((a, h) => a + (h.value - mean) ** 2, 0) / (n - 1)) : NaN;
  const enough = n >= MIN_HISTORY;
  const spread = Math.max(Number.isFinite(sd) ? sd : 0, row.noise ?? 0, Math.abs(mean) * 0.05, 1e-9);
  const z = enough ? (row.value - mean) / spread : 0;
  const worse = row.better === 'either' ? Math.abs(z) : row.better === 'lower' ? z : -z;
  return {
    value: row.value,
    history,
    n,
    mean,
    sd: Number.isFinite(sd) ? sd : 0,
    spread,
    z,
    enough,
    flagged: enough && worse >= FLAG_Z,
    dir: z > 0 ? 1 : z < 0 ? -1 : 0,
  };
}

/** Every row's judgement, by row id. */
export function judgeBoard(board: Board, baseline: Baseline): Map<string, Judgement> {
  const out = new Map<string, Judgement>();
  for (const col of board.columns)
    for (const [r] of walkRows(col.rows)) {
      const j = judge(r, baseline);
      if (j) out.set(r.id, j);
    }
  return out;
}

// ---------- Demo history for the sample log ----------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Fourteen made-up earlier matches around the sample's own numbers, so the sample shows what flagged
 * rows look like. About one row in ten is made to look unusual in this match.
 */
export function demoBaseline(board: Board): Baseline {
  const rows: Row[] = [];
  for (const col of board.columns) for (const [r] of walkRows(col.rows)) if (r.better && Number.isFinite(r.value)) rows.push(r);
  const points: HistoryPoint[] = Array.from({ length: 14 }, (_, i) => ({
    key: `demo-${i}`,
    startTime: i,
    label: `Q${4 + i + Math.floor(i / 3)}`,
    metrics: {},
  }));
  for (const r of rows) {
    const pick = rng(hash(r.id))();
    const unusual = pick < 0.1;
    const x = r.value;
    const integer = r.digits === 0;
    let centre: number;
    if (!unusual) centre = x * (0.92 + pick * 0.2);
    else if (r.better === 'higher') centre = x * 1.18;
    else if (x === 0) centre = 0;
    else centre = x * (r.better === 'either' && pick < 0.03 ? 1.9 : 0.45);
    const spread = Math.max(Math.abs(centre) * 0.09, (r.noise ?? 0) * 0.6);
    const next = rng(hash(r.id) ^ 0x9e3779b9);
    for (const p of points) {
      // Sum of uniforms: roughly normal, and deterministic.
      const g = (next() + next() + next() - 1.5) * 2;
      let v = centre + g * spread;
      if (x === 0 && integer) v = next() < 0.12 ? 1 : 0;
      if (integer) v = Math.round(v);
      p.metrics[r.id] = Math.max(0, v);
    }
  }
  return { points, demo: true };
}
