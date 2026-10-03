// Lining up logs from different machines. The Driver Station, the roboRIO and a CAN device each stamp
// their own clock; to put them on one graph we need the offset between them, and a way to say how sure we are.
//
// "Offset" everywhere means: seconds to add to a time in the other log to get the time on the match
// (Driver Station) timeline.

import type { Analysis, Span } from './analysis';
import type { DSEventsFile } from './dsevents';
import type { DSLog } from './dslog';
import { clockOffset, consoleLines, enabledWindows, type WPILog } from './wpilog';

export type AlignMethod = 'messages' | 'enabled' | 'clock';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface Alignment {
  /** The method the offset came from; undefined when nothing could be lined up. */
  method?: AlignMethod;
  offset: number;
  confidence: Confidence;
  /** One plain sentence for the Info page. */
  detail: string;
  /** Every method that produced an answer, so disagreements show. */
  tried: Partial<Record<AlignMethod, { offset: number; confidence: Confidence }>>;
}

export interface DsAnchor {
  /** When the DS log began, Unix seconds (UTC). */
  startUnix?: number;
  duration: number;
  /** Windows the robot was enabled, on the DS timeline. */
  enabled: Span[];
  /** Messages the robot sent, on the DS timeline. */
  messages: { t: number; text: string }[];
}

const MIN_MESSAGE = 12;
const WINDOW = 0.3;
const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
const PRIORITY: Record<AlignMethod, number> = { messages: 3, enabled: 2, clock: 1 };
const LABEL: Record<AlignMethod, string> = {
  messages: 'shared console messages',
  enabled: 'the enabled periods',
  clock: "the roboRIO's clock",
};

/** What the Driver Station side offers to line up against. */
export function dsAnchor(log: DSLog | null, events: DSEventsFile | null, analysis: Analysis): DsAnchor {
  const enabled: Span[] = [];
  for (const m of analysis.modes) {
    if (m.mode === 'disabled') continue;
    const last = enabled[enabled.length - 1];
    if (last && m.start - last.end < 0.5) last.end = m.end;
    else enabled.push({ start: m.start, end: m.end });
  }
  const messages = (events?.events ?? [])
    .filter((e) => e.kind === 'print' || e.kind === 'error' || e.kind === 'warning')
    .map((e) => ({ t: e.t, text: e.text }));
  return { startUnix: log?.startTime ?? events?.startTime, duration: analysis.duration, enabled, messages };
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Offsets from messages both sides logged: the same text at one time on one clock and another on the other. */
function byMessages(w: WPILog, ds: DsAnchor): { offset: number; votes: number; spread: number } | null {
  const lines = consoleLines(w)
    .slice(0, 20000)
    .map((l) => ({ t: l.t, text: squash(l.text) }));
  if (!lines.length) return null;
  const pairs: { o: number; i: number }[] = [];
  ds.messages.slice(0, 1000).forEach((m, i) => {
    const key = squash(m.text.split('\n')[0]).slice(0, 80);
    if (key.length < MIN_MESSAGE) return;
    let n = 0;
    for (const l of lines) {
      if (!l.text.includes(key)) continue;
      pairs.push({ o: m.t - l.t, i });
      if (++n >= 25) break;
    }
  });
  if (!pairs.length) return null;
  pairs.sort((a, b) => a.o - b.o);
  // densest window of offsets, counting each DS message once
  const inWin = new Map<number, number>();
  let lo = 0;
  let best = { from: 0, to: 0, votes: 0 };
  for (let hi = 0; hi < pairs.length; hi++) {
    inWin.set(pairs[hi].i, (inWin.get(pairs[hi].i) ?? 0) + 1);
    while (pairs[hi].o - pairs[lo].o > 2 * WINDOW) {
      const c = inWin.get(pairs[lo].i)! - 1;
      if (c) inWin.set(pairs[lo].i, c);
      else inWin.delete(pairs[lo].i);
      lo++;
    }
    if (inWin.size > best.votes) best = { from: lo, to: hi, votes: inWin.size };
  }
  const o = pairs.slice(best.from, best.to + 1).map((p) => p.o);
  const offset = median(o);
  return { offset, votes: best.votes, spread: median(o.map((x) => Math.abs(x - offset))) };
}

function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Offsets that make the two logs' enabled periods coincide. */
function byEnabled(w: WPILog, ds: DsAnchor): { offset: number; score: number } | null {
  const rio = enabledWindows(w).filter((x) => x.end - x.start > 0.5);
  const dsw = ds.enabled.filter((x) => x.end - x.start > 0.5);
  if (!rio.length || !dsw.length) return null;
  const total = (ws: Span[]) => ws.reduce((a, x) => a + (x.end - x.start), 0);
  const denom = Math.max(total(rio), total(dsw));
  const cands = new Set<number>();
  for (const d of dsw.slice(0, 8))
    for (const r of rio.slice(0, 8)) {
      cands.add(d.start - r.start);
      cands.add(d.end - r.end);
    }
  let best: { offset: number; score: number } | null = null;
  for (const offset of cands) {
    let sum = 0;
    for (const r of rio) {
      const shifted = { start: r.start + offset, end: r.end + offset };
      for (const d of dsw) sum += overlap(shifted, d);
    }
    const score = sum / denom;
    if (!best || score > best.score) best = { offset, score };
  }
  return best;
}

function confidenceOf(method: AlignMethod, d: { votes?: number; spread?: number; score?: number }): Confidence {
  if (method === 'messages') {
    const v = d.votes ?? 0;
    if (v >= 5 && (d.spread ?? 1) < 0.15) return 'high';
    if (v >= 3) return 'medium';
    return v >= 2 ? 'low' : 'none';
  }
  if (method === 'enabled') {
    const s = d.score ?? 0;
    return s >= 0.9 ? 'high' : s >= 0.6 ? 'medium' : s >= 0.3 ? 'low' : 'none';
  }
  return 'medium'; // a clock only agrees to within a second or two
}

/** Finds the offset that puts a wpilog on the match timeline, with the method used and how sure it is. */
export function alignWPILog(w: WPILog, ds: DsAnchor): Alignment {
  const tried: Alignment['tried'] = {};
  const found: { method: AlignMethod; offset: number; confidence: Confidence; note: string }[] = [];

  const msg = byMessages(w, ds);
  if (msg) {
    const confidence = confidenceOf('messages', msg);
    if (confidence !== 'none') found.push({ method: 'messages', offset: msg.offset, confidence, note: `${msg.votes} shared messages` });
  }
  const en = byEnabled(w, ds);
  if (en) {
    const confidence = confidenceOf('enabled', en);
    if (confidence !== 'none') found.push({ method: 'enabled', offset: en.offset, confidence, note: `${Math.round(en.score * 100)}% of enabled time coincides` });
  }
  const co = clockOffset(w);
  if (co != null && ds.startUnix != null) found.push({ method: 'clock', offset: co - ds.startUnix, confidence: confidenceOf('clock', {}), note: 'clock times' });

  for (const f of found) tried[f.method] = { offset: f.offset, confidence: f.confidence };
  if (!found.length)
    return {
      offset: 0,
      confidence: 'none',
      tried,
      detail: "Couldn't line this log up with the Driver Station log: no shared messages, enabled periods or clock to go by.",
    };

  found.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || PRIORITY[b.method] - PRIORITY[a.method]);
  const pick = found[0];
  // A log that does not even overlap the match was lined up wrongly, however sure the method was.
  const span = { start: w.first + pick.offset, end: w.last + pick.offset };
  if (overlap(span, { start: 0, end: ds.duration }) <= 0)
    return {
      offset: pick.offset,
      confidence: 'none',
      tried,
      detail: `Lined up by ${LABEL[pick.method]}, but that puts this log entirely outside the match. It is probably from a different run.`,
    };

  const others = found.slice(1).map((o) => {
    const d = Math.abs(o.offset - pick.offset);
    return d < 0.25 ? `agrees with ${LABEL[o.method]} (within ${d.toFixed(2)} s)` : `differs from ${LABEL[o.method]} by ${d.toFixed(1)} s`;
  });
  return {
    method: pick.method,
    offset: pick.offset,
    confidence: pick.confidence,
    tried,
    detail: [`Lined up by ${LABEL[pick.method]} (${pick.note})`, ...others].join('; ') + '.',
  };
}

// ---------- Which matches does a log belong to? ----------

export interface Candidate {
  key: string;
  /** Unix seconds (UTC) and length of the match's DS log. */
  startUnix: number;
  duration: number;
}

/**
 * Matches that a roboRIO log covers. One log spans a whole run of robot code, which can include several
 * DS logs, so this can be more than one. Needs the log's clock; with none, returns nothing.
 */
export function matchesFor(w: WPILog, candidates: Candidate[]): string[] {
  return matchesForSpan(clockSpan(w), candidates);
}

/** The same, from a log's wall-clock span (what probing a log returns). */
export function matchesForSpan(span: Span | undefined, candidates: Candidate[]): string[] {
  if (!span) return [];
  return candidates
    .filter((c) => c.duration > 1 && overlap(span, { start: c.startUnix, end: c.startUnix + c.duration }) / c.duration >= 0.5)
    .map((c) => c.key);
}

/** The log's own wall-clock span (Unix seconds), when it has a clock. */
export function clockSpan(w: WPILog): Span | undefined {
  const off = clockOffset(w);
  return off == null ? undefined : { start: w.first + off, end: w.last + off };
}
