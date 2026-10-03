// Lining up logs from different machines, and deciding which match a robot log belongs to.
//
// The Driver Station, the roboRIO and a CAN device each stamp their own clock. To put them on one graph we need
// the offset between them, and a way to say how sure we are.
//
// "Offset" everywhere means: seconds to add to a time in the other log to get the time on the match
// (Driver Station) timeline.

import type { Analysis, Span } from './analysis';
import type { DSEventsFile } from './dsevents';
import type { DSLog } from './dslog';
import { hootName } from './hoot';
import { clockOffset, consoleLines, enabledWindows, fileStamp, matchIds, matchLabel, sameMatch, type MatchId, type WPILog } from './wpilog';

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

/** What the Driver Station side offers to line up against. */
export interface DsAnchor {
  /** When the DS log began, Unix seconds (UTC). */
  startUnix?: number;
  duration: number;
  /** Windows the robot was enabled, on the DS timeline. */
  enabled: Span[];
  /** Messages the robot sent, on the DS timeline. */
  messages: { t: number; text: string }[];
}

/**
 * What a robot log offers to line up with, small enough to keep next to the log. Taken once when a log is added, so it
 * can be placed on a match later (when that match's DS log turns up) without reading the whole file again.
 */
export interface RioAnchors {
  first: number;
  last: number;
  /** Windows the robot was enabled, on the log's own clock. */
  enabled: Span[];
  /** Console lines worth matching on, on the log's own clock (lowercase, whitespace squashed). */
  lines: { t: number; text: string }[];
  /** Add to a log time to get Unix seconds, when the log has the robot's wall clock. */
  clockOffset?: number;
  /** The matches the field said this log was running, or the one its file name gives. */
  ids: MatchId[];
}

const MIN_MESSAGE = 12;
const WINDOW = 0.3;
const MAX_LINES = 1500;
const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
const PRIORITY: Record<AlignMethod, number> = { messages: 3, enabled: 2, clock: 1 };
const LABEL: Record<AlignMethod, string> = {
  messages: 'shared console messages',
  enabled: 'the enabled periods',
  clock: "the roboRIO's clock",
};

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Messages worth matching on: long enough to be specific, each text kept a few times at most. */
function distinct<T extends { text: string }>(items: T[], limit: number): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const m of items) {
    const n = seen.get(m.text) ?? 0;
    if (m.text.length < MIN_MESSAGE || n >= 3) continue;
    seen.set(m.text, n + 1);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- The two sides ----------

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

/** The same, trimmed to what is worth keeping in a library summary. */
export function compactAnchor(a: DsAnchor, maxMessages = 80): DsAnchor {
  const messages = distinct(
    a.messages.map((m) => ({ t: m.t, text: squash(m.text.split('\n')[0]).slice(0, 160) })),
    maxMessages,
  );
  return { ...a, messages };
}

/** What a robot log offers to line up with. `fileName` supplies an identity when the log itself has none. */
export function rioAnchors(w: WPILog, fileName?: string): RioAnchors {
  const lines = distinct(
    consoleLines(w).map((l) => ({ t: l.t, text: squash(l.text.split('\n')[0]).slice(0, 160) })),
    MAX_LINES,
  );
  let ids = matchIds(w);
  const stamp = fileName ? fileStamp(fileName) : undefined;
  if (!ids.length && stamp?.id) ids = [stamp.id];
  // a log converted from a hoot keeps the hoot's name, which CTRE put the match in during a field match
  if (!ids.length && fileName) ids = hootName(fileName).ids;
  return { first: w.first, last: w.last, enabled: enabledWindows(w), lines, clockOffset: clockOffset(w), ids };
}

// ---------- Lining up ----------

interface Cluster {
  offset: number;
  votes: number;
  spread: number;
}

/** The densest cluster of offsets, counting each DS message once. */
function densest(pairs: { o: number; i: number }[]): Cluster | null {
  if (!pairs.length) return null;
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

/** Offsets from messages both sides logged: the same text at one time on one clock and another on the other. */
function byMessages(rio: RioAnchors, ds: DsAnchor): (Cluster & { ambiguous: boolean }) | null {
  if (!rio.lines.length) return null;
  const pairs: { o: number; i: number }[] = [];
  ds.messages.slice(0, 1000).forEach((m, i) => {
    const key = squash(m.text.split('\n')[0]).slice(0, 80);
    if (key.length < MIN_MESSAGE) return;
    let n = 0;
    for (const l of rio.lines) {
      if (!l.text.includes(key)) continue;
      pairs.push({ o: m.t - l.t, i });
      if (++n >= 25) break;
    }
  });
  pairs.sort((a, b) => a.o - b.o);
  const best = densest(pairs);
  if (!best) return null;
  // Is there a second, different offset that fits nearly as well? Then the log could be of another, similar match.
  const rest = pairs.filter((p) => Math.abs(p.o - best.offset) > 2 + 2 * WINDOW);
  const second = densest(rest);
  return { ...best, ambiguous: !!second && second.votes >= Math.max(2, best.votes * 0.7) };
}

/**
 * How well shifting the robot's enabled periods by `offset` explains the DS's. Two things must hold: every period the
 * DS saw is also in the robot log (recall), and robot-enabled time around them was seen by the DS too (precision). The
 * second is limited to the neighbourhood, so a robot log that holds several matches is not marked down for the others.
 */
function enabledScore(rw: Span[], dw: Span[], offset: number): number {
  const shifted = rw.map((r) => ({ start: r.start + offset, end: r.end + offset }));
  let recall = 1;
  for (const d of dw) {
    let covered = 0;
    for (const r of shifted) covered += overlap(r, d);
    recall = Math.min(recall, covered / (d.end - d.start));
  }
  const hull = { start: Math.min(...dw.map((d) => d.start)) - 30, end: Math.max(...dw.map((d) => d.end)) + 30 };
  let near = 0;
  let matched = 0;
  for (const r of shifted) {
    near += overlap(r, hull);
    for (const d of dw) matched += overlap(r, d);
  }
  return near > 0 ? Math.min(1, recall) * Math.min(1, matched / near) : 0;
}

/** Offsets that make the two logs' enabled periods coincide. */
function byEnabled(rio: RioAnchors, ds: DsAnchor): { offset: number; score: number; ambiguous: boolean } | null {
  const rw = rio.enabled.filter((x) => x.end - x.start > 0.5);
  const dw = ds.enabled.filter((x) => x.end - x.start > 0.5);
  if (!rw.length || !dw.length) return null;
  const cands = new Set<number>();
  for (const d of dw.slice(0, 8))
    for (const r of rw.slice(0, 40)) {
      cands.add(d.start - r.start);
      cands.add(d.end - r.end);
    }
  const scored = [...cands].map((offset) => ({ offset, score: enabledScore(rw, dw, offset) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  // A similar score a minute or more away means the pattern fits somewhere else too (another match that looks alike).
  const ambiguous = scored.some((c) => Math.abs(c.offset - best.offset) > 60 && c.score >= Math.max(0.6, best.score * 0.9));
  return { ...best, ambiguous };
}

function confidenceOf(method: AlignMethod, d: { votes?: number; spread?: number; score?: number; ambiguous?: boolean }): Confidence {
  let c: Confidence;
  if (method === 'messages') {
    const v = d.votes ?? 0;
    c = v >= 5 && (d.spread ?? 1) < 0.15 ? 'high' : v >= 3 ? 'medium' : v >= 2 ? 'low' : 'none';
  } else if (method === 'enabled') {
    const s = d.score ?? 0;
    c = s >= 0.9 ? 'high' : s >= 0.6 ? 'medium' : s >= 0.3 ? 'low' : 'none';
  } else c = 'medium'; // a clock only agrees to within a second or two
  return d.ambiguous && RANK[c] > RANK.low ? 'low' : c;
}

/** Finds the offset that puts a robot log on the match timeline, with the method used and how sure it is. */
export function alignAnchors(rio: RioAnchors, ds: DsAnchor): Alignment {
  const tried: Alignment['tried'] = {};
  const found: { method: AlignMethod; offset: number; confidence: Confidence; note: string }[] = [];

  const msg = byMessages(rio, ds);
  if (msg) {
    const confidence = confidenceOf('messages', msg);
    if (confidence !== 'none')
      found.push({ method: 'messages', offset: msg.offset, confidence, note: `${msg.votes} shared messages${msg.ambiguous ? ', but they fit more than one place' : ''}` });
  }
  const en = byEnabled(rio, ds);
  if (en) {
    const confidence = confidenceOf('enabled', en);
    if (confidence !== 'none')
      found.push({ method: 'enabled', offset: en.offset, confidence, note: `${Math.round(en.score * 100)}% of enabled time coincides${en.ambiguous ? ', but the pattern fits more than one place' : ''}` });
  }
  if (rio.clockOffset != null && ds.startUnix != null)
    found.push({ method: 'clock', offset: rio.clockOffset - ds.startUnix, confidence: confidenceOf('clock', {}), note: 'clock times' });

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
  const span = { start: rio.first + pick.offset, end: rio.last + pick.offset };
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

export function alignWPILog(w: WPILog, ds: DsAnchor): Alignment {
  return alignAnchors(rioAnchors(w), ds);
}

/** The log's own wall-clock span (Unix seconds), when it has a clock. */
export function clockSpan(w: WPILog): Span | undefined {
  const off = clockOffset(w);
  return off == null ? undefined : { start: w.first + off, end: w.last + off };
}

// ---------- Which match does a log belong to? ----------

/** A match a robot log might belong to. */
export interface Candidate {
  key: string;
  /** The match as the field named it, when the DS log says. */
  id?: MatchId;
  anchor: DsAnchor;
}

export interface Placement {
  fit: Confidence;
  /** Why, in a few words. */
  why: string;
}

/** Same match number on both sides, or a different one. Nothing to say when either side has no identity. */
export function identityFit(rio: RioAnchors, cand: Candidate): Placement | null {
  if (!rio.ids.length || !cand.id) return null;
  const same = rio.ids.find((i) => sameMatch(i, cand.id!));
  return same
    ? { fit: 'high', why: `both are ${matchLabel(cand.id)}` }
    : { fit: 'none', why: `the robot log is of ${rio.ids.map(matchLabel).join(', ')}, not ${matchLabel(cand.id)}` };
}

/**
 * How well a robot log fits a match. Best evidence first: the field's own name for the match, then both machines'
 * wall clocks, then the shape of what happened (messages, enabled periods). Only 'high' is trusted without asking.
 */
export function placeLog(rio: RioAnchors, cand: Candidate): Placement {
  const byId = identityFit(rio, cand);
  if (byId) return byId;
  const a = cand.anchor;
  if (rio.clockOffset != null && a.startUnix != null && a.duration > 1) {
    const ratio = overlap({ start: rio.first + rio.clockOffset, end: rio.last + rio.clockOffset }, { start: a.startUnix, end: a.startUnix + a.duration }) / a.duration;
    if (ratio >= 0.5) return { fit: 'high', why: 'the two clocks say they overlap' };
    return ratio < 0.1 ? { fit: 'none', why: 'the two clocks say they do not overlap' } : { fit: 'low', why: 'the two clocks say they overlap only partly' };
  }
  const al = alignAnchors(rio, a);
  return { fit: al.method === 'clock' ? 'none' : al.confidence, why: al.detail };
}

/** A robot log that is known to the library, with what is needed to place it on a match. */
export interface KnownLog {
  name: string;
  anchors: RioAnchors;
}

export interface Move {
  name: string;
  key: string;
  why: string;
}

/**
 * Where robot logs should be added now: every (log, match) pair that fits with high confidence and is not already
 * so, or was not taken off by the user. Run again whenever matches appear.
 */
export function planPlacements(
  logs: KnownLog[],
  cands: Candidate[],
  has: (name: string, key: string) => boolean,
  dismissed: (name: string, key: string) => boolean,
): Move[] {
  const out: Move[] = [];
  for (const l of logs)
    for (const c of cands) {
      if (has(l.name, c.key) || dismissed(l.name, c.key)) continue;
      const p = placeLog(l.anchors, c);
      if (p.fit === 'high') out.push({ name: l.name, key: c.key, why: p.why });
    }
  return out;
}

/** A readable name for a match that only has robot logs: the field's name for it, else the log it was made from. */
export function robotMatchTitle(ids: MatchId[], logName?: string): string {
  if (ids.length) return matchLabel(ids[0]);
  const base = logName?.replace(/^.*[/\\]/, '').replace(/\.wpilog$/i, '');
  return base ? `Robot log ${base}` : 'Robot log';
}
