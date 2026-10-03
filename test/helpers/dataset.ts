// A synthetic day-to-day pool of matches and robot logs, at the size of a real season: several events whose match
// numbers collide, shop practice days with no field, robot boots that each span several matches, and the gaps real logs
// have (no clock, no event code, a hoot that is only named for the first match it ran). Used to score the matching engine.

import type { Span } from '../../src/lib/analysis';
import type { Candidate, DsAnchor, KnownLog, RioAnchors } from '../../src/lib/aggregate';
import type { MatchId, MatchKind } from '../../src/lib/wpilog';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TruthMatch {
  key: string;
  event: string; // "MNST", or "shop" for practice with no field
  day: number;
  start: number;
  duration: number;
  id?: MatchId;
  candidate: Candidate;
}

export type LogClass =
  | 'wpilog: event code in the log'
  | 'wpilog: match numbers but no event code'
  | 'wpilog: no match numbers (clock + messages only)'
  | 'wpilog: no clock, no numbers (messages only)'
  | 'hoot: named for the match it started in'
  | 'hoot: no match in its name';

export interface TruthLog {
  name: string;
  cls: LogClass;
  boot: number;
  /** Every match it really ran through. */
  truth: Set<string>;
  anchors: RioAnchors;
  /** The event it was really recorded at. */
  event: string;
}

export interface Dataset {
  matches: TruthMatch[];
  logs: TruthLog[];
  known: KnownLog[];
  candidates: Candidate[];
}

const DAY = 86400;
const MATCH_LEN = 160;

export function makeDataset(opts: { events?: string[]; seed?: number; shopDays?: number } = {}): Dataset {
  const events = opts.events ?? ['MNST', 'WIMI', 'MNDU'];
  const rand = rng(opts.seed ?? 7);
  const base = Date.UTC(2026, 2, 5, 14, 0, 0) / 1000; // 08:00 local
  const matches: TruthMatch[] = [];
  const kinds: [MatchKind, number][] = [['practice', 6], ['qualification', 54]];

  const addMatch = (event: string, day: number, start: number, n: number, kind?: MatchKind) => {
    const key = `${event}-${kind ?? 'shop'}-${n}-${day}`;
    const duration = MATCH_LEN + Math.round(rand() * 10);
    const messages: DsAnchor['messages'] = [];
    for (let k = 0; k < 12; k++) messages.push({ t: 10 + rand() * (duration - 20), text: `warning: loop overrun in subsystem ${key} step ${k}` });
    const enabled: Span[] = [
      { start: 5, end: 20 },
      { start: 25, end: duration - 4 },
    ];
    const id: MatchId | undefined = kind ? { event, type: kind, number: n } : undefined;
    const anchor: DsAnchor = { startUnix: start, duration, enabled, messages };
    matches.push({ key, event, day, start, duration, id, candidate: { key, id, anchor } });
  };

  let evStart = base;
  for (const event of events) {
    let t = evStart;
    let day = 0;
    for (const [kind, count] of kinds) {
      for (let n = 1; n <= count; n++) {
        addMatch(event, day, t, n, kind);
        t += 540 + rand() * 120; // a match every ~9-10 minutes
        if (t - (evStart + day * DAY) > 9 * 3600) {
          day++;
          t = evStart + day * DAY + rand() * 600;
        }
      }
    }
    evStart += 21 * DAY;
  }
  // shop practice: no field, so no match name anywhere
  const shopDays = opts.shopDays ?? 6;
  for (let d = 0; d < shopDays; d++) {
    const dayStart = base + (7 + d * 3) * DAY + 3600;
    let t = dayStart;
    for (let n = 1; n <= 10; n++) {
      addMatch('shop', d, t, n);
      t += 300 + rand() * 400;
    }
  }

  // robot boots: each spans a run of consecutive matches of one event (or one shop day)
  const logs: TruthLog[] = [];
  const groups = new Map<string, TruthMatch[]>();
  for (const m of matches) {
    const g = `${m.event}/${m.day}`;
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  let boot = 0;
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start);
    let previousEnd = -Infinity; // one robot: a boot cannot begin before the last one ended
    for (let i = 0; i < list.length; ) {
      const span = 2 + Math.floor(rand() * 4); // 2-5 matches per boot
      const run = list.slice(i, i + span);
      i += span;
      const first = run[0];
      const last = run[run.length - 1];
      const bootStart = Math.max(first.start - 300 - rand() * 300, previousEnd + 60);
      const bootEnd = last.start + last.duration + 120;
      previousEnd = bootEnd;
      const length = bootEnd - bootStart;
      const skew = rand() * 3;
      const withClock = rand() > 0.15;
      const roll = rand();
      const atEvent = first.event !== 'shop';
      const cls: LogClass = !atEvent
        ? roll < 0.5
          ? 'wpilog: no match numbers (clock + messages only)'
          : 'wpilog: no clock, no numbers (messages only)'
        : roll < 0.6
          ? 'wpilog: event code in the log'
          : roll < 0.8
            ? 'wpilog: match numbers but no event code'
            : roll < 0.9
              ? 'wpilog: no match numbers (clock + messages only)'
              : 'wpilog: no clock, no numbers (messages only)';
      const hasClock = cls !== 'wpilog: no clock, no numbers (messages only)' && withClock;
      const enabled: Span[] = [];
      const lines: RioAnchors['lines'] = [];
      for (const m of run) {
        const rel = m.start - bootStart;
        enabled.push({ start: rel + 5, end: rel + 20 }, { start: rel + 25, end: rel + m.duration - 4 });
        // about 60% of what the DS shows as messages is also in the robot's own console
        for (const msg of m.candidate.anchor.messages) if (rand() < 0.6) lines.push({ t: rel + msg.t + (rand() - 0.5) * 0.1, text: msg.text });
      }
      const ids: MatchId[] =
        cls === 'wpilog: event code in the log'
          ? run.map((m) => m.id!)
          : cls === 'wpilog: match numbers but no event code'
            ? run.map((m) => ({ type: m.id!.type, number: m.id!.number }))
            : [];
      const truth = new Set(run.map((m) => m.key));
      const name = `FRC_${boot}_wpilog`;
      logs.push({
        name,
        cls,
        boot,
        truth,
        event: first.event,
        // DataLogManager names a log FRC_yyyyMMdd_HHmmss a few seconds after the robot boots
        anchors: { first: 0, last: length, enabled, lines, clockOffset: hasClock ? bootStart + skew : undefined, ids, idsFrom: ids.length ? 'log' : undefined, stamp: Math.round(bootStart + rand() * 8) },
      });

      // the Phoenix log of the same boot, converted to .wpilog: no robot clock and no console, only the name
      // CTRE renames a hoot to start with the event and match during a field match, and its name always carries a timestamp
      const named = atEvent && rand() < 0.85;
      logs.push({
        name: `FRC_${boot}_hoot`,
        cls: named ? 'hoot: named for the match it started in' : 'hoot: no match in its name',
        boot,
        truth,
        event: first.event,
        anchors: {
          first: 0,
          last: length + (rand() - 0.5) * 4,
          enabled: [],
          lines: [],
          ids: named ? [{ event: first.event, type: first.id!.type, number: first.id!.number }] : [],
          idsFrom: named ? 'name' : undefined,
          stamp: Math.round(bootStart + rand() * 20),
        },
      });
      boot++;
    }
  }

  return { matches, logs, known: logs.map((l) => ({ name: l.name, anchors: l.anchors })), candidates: matches.map((m) => m.candidate) };
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  /** Placements on a match of another event. */
  wrongEvent: number;
}

/** Scores a set of (log, match) placements against what really happened. */
export function score(ds: Dataset, placed: { name: string; key: string }[]): Map<LogClass | 'all', Score> {
  const out = new Map<LogClass | 'all', Score>();
  const bump = (c: LogClass | 'all', f: (s: Score) => void) => {
    const s = out.get(c) ?? { tp: 0, fp: 0, fn: 0, wrongEvent: 0 };
    f(s);
    out.set(c, s);
  };
  const byName = new Map(ds.logs.map((l) => [l.name, l]));
  const byKey = new Map(ds.matches.map((m) => [m.key, m]));
  const got = new Set(placed.map((p) => `${p.name}@${p.key}`));
  for (const p of placed) {
    const l = byName.get(p.name)!;
    const ok = l.truth.has(p.key);
    const wrongEvent = !ok && ![...l.truth].some((k) => byKey.get(k)!.event === byKey.get(p.key)!.event);
    for (const c of [l.cls, 'all'] as const) bump(c, (s) => (ok ? s.tp++ : (s.fp++, wrongEvent && s.wrongEvent++)));
  }
  for (const l of ds.logs) for (const k of l.truth) if (!got.has(`${l.name}@${k}`)) for (const c of [l.cls, 'all'] as const) bump(c, (s) => s.fn++);
  return out;
}
