// Events: the unit people think in. A Driver Station log tells which event it was recorded at (the field names it), so
// matches group into events by themselves; shop practice with no field groups into sessions. The user can also make
// their own events, move matches between them, and add logs to one: a log added to an event is only weighed against that
// event's matches, which is what keeps several events (whose match numbers all collide) from getting mixed up.

import { idb } from './idb';
import type { LogEntry } from './library';

type Db = Pick<typeof idb, 'get' | 'set'>;

/** What the user decided, kept between visits. Everything else is worked out again each time. */
export interface EventState {
  /** Events the user made. They exist even when empty, so logs can be added to them. */
  manual: { id: string; name: string }[];
  /** Matches the user moved, by key, to an event. */
  eventOf: Record<string, string>;
  /** Logs that were added to an event, by file name: they are only matched within it. */
  eventOfLog: Record<string, string>;
  /** Names the user gave automatic events. */
  names: Record<string, string>;
}

export const emptyEventState = (): EventState => ({ manual: [], eventOf: {}, eventOfLog: {}, names: {} });

export interface EventInfo {
  id: string;
  name: string;
  /** Made by the user (as opposed to found from the logs). */
  manual: boolean;
  /** Matches in it, newest first. */
  keys: string[];
  /** Unix seconds of the earliest and latest match, 0 when empty. */
  start: number;
  end: number;
}

/** Robot logs that fit no event yet. */
export const UNSORTED = 'auto:unsorted';
/** Matches whose Driver Station log has not been read yet: what event they are at is not known until it is. */
export const READING = 'auto:reading';
/** The two holding groups: not events the user can add to, rename or delete. */
export const isHolding = (id: string) => id === UNSORTED || id === READING;
/** Matches with no field more than this far apart are separate practice sessions. */
const SESSION_GAP = 3 * 86400;
/** A match with no field name this close to an event's matches was at that event (a pit test, say). */
const EVENT_MARGIN = 12 * 3600;
/** A robot-log-only match this close to an event's or session's matches goes with it. */
const ROBOT_MARGIN = 86400;

const short = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const range = (a: number, b: number) => (short(a) === short(b) ? short(a) : `${short(a)} – ${short(b)}`);

/** The id of an event the logs name: its FMS code and the year. */
export const eventIdOf = (code: string, startTime: number) => `auto:${code.toUpperCase()}:${new Date(startTime * 1000).getFullYear()}`;

/**
 * Sorts matches into events. A match goes to the event the user moved it to; else the event its Driver Station log names;
 * else, with no field, the event it falls inside of, or else a practice session. A robot-log-only match goes by its time.
 */
export function groupEvents(entries: Iterable<LogEntry>, st: EventState): { events: EventInfo[]; of: Map<string, string> } {
  const list = [...entries];
  const manualIds = new Set(st.manual.map((m) => m.id));
  const of = new Map<string, string>();
  const members = new Map<string, LogEntry[]>();
  const add = (id: string, e: LogEntry) => {
    of.set(e.key, id);
    members.set(id, [...(members.get(id) ?? []), e]);
  };
  const moved = (e: LogEntry) => {
    const id = st.eventOf[e.key];
    return id && (manualIds.has(id) || id.startsWith('auto:')) ? id : undefined;
  };

  // 1. the user's choice, and the events the field names
  const rest: LogEntry[] = [];
  for (const e of list) {
    const id = moved(e);
    if (id) add(id, e);
    else if (!e.robot && e.summary?.eventName) add(eventIdOf(e.summary.eventName, e.startTime), e);
    else if (!e.robot && !e.summary && !e.summaryError) add(READING, e); // not read yet: say so, rather than guess and then move it
    else rest.push(e);
  }
  const span = (id: string) => {
    const t = (members.get(id) ?? []).map((e) => e.startTime);
    return t.length ? { start: Math.min(...t), end: Math.max(...t) } : null;
  };
  const near = (e: LogEntry, margin: number, only?: (id: string) => boolean) => {
    let best: string | undefined;
    let bestGap = Infinity;
    for (const id of members.keys()) {
      if (only && !only(id)) continue;
      const s = span(id);
      if (!s) continue;
      const gap = e.startTime < s.start ? s.start - e.startTime : e.startTime > s.end ? e.startTime - s.end : 0;
      if (gap <= margin && gap < bestGap) [best, bestGap] = [id, gap];
    }
    return best;
  };

  // 2. matches with no field name: inside an event, else practice sessions
  const pending = rest.filter((e) => !e.robot).sort((a, b) => a.startTime - b.startTime);
  const sessions: LogEntry[][] = [];
  for (const e of pending) {
    const at = near(e, EVENT_MARGIN, (id) => /^auto:[^:]+:\d{4}$/.test(id));
    if (at) {
      add(at, e);
      continue;
    }
    const last = sessions[sessions.length - 1];
    if (last && e.startTime - last[last.length - 1].startTime <= SESSION_GAP) last.push(e);
    else sessions.push([e]);
  }
  for (const s of sessions) {
    const id = `auto:practice:${Math.floor(s[0].startTime / 86400)}`;
    for (const e of s) add(id, e);
  }

  // 3. robot logs with no Driver Station log yet go by their time
  for (const e of rest.filter((x) => x.robot)) add(near(e, ROBOT_MARGIN) ?? UNSORTED, e);

  // 4. the result, with the user's empty events too
  const info = new Map<string, EventInfo>();
  const make = (id: string): EventInfo => {
    const m = st.manual.find((x) => x.id === id);
    const es = (members.get(id) ?? []).sort((a, b) => b.startTime - a.startTime);
    const s = span(id);
    const parts = id.split(':');
    const auto = id === UNSORTED ? 'Robot logs with no match yet' : id === READING ? 'Reading logs…' : parts[1] === 'practice' ? `Practice · ${s ? range(s.start, s.end) : ''}` : `${parts[1]} ${parts[2]}`;
    return { id, name: st.names[id] ?? m?.name ?? auto, manual: !!m, keys: es.map((e) => e.key), start: s?.start ?? 0, end: s?.end ?? 0 };
  };
  for (const id of members.keys()) info.set(id, make(id));
  for (const m of st.manual) if (!info.has(m.id)) info.set(m.id, make(m.id));
  // newest first; the user's empty events lead (they are what is about to be filled); the "no match yet" bucket is last
  const recency = (e: EventInfo) => e.end || Number.MAX_SAFE_INTEGER;
  const events = [...info.values()].sort((a, b) => recency(b) - recency(a) || a.name.localeCompare(b.name));
  return { events: [...events.filter((e) => !isHolding(e.id)), ...events.filter((e) => e.id === READING), ...events.filter((e) => e.id === UNSORTED)], of };
}

/** The user's choices, remembered. */
export class EventStore {
  state: EventState = emptyEventState();

  constructor(private db: Db = idb) {}

  async load(): Promise<void> {
    const saved = await this.db.get<Partial<EventState>>('kv', 'events');
    this.state = { ...emptyEventState(), ...saved };
  }

  async save(): Promise<void> {
    try {
      await this.db.set('kv', 'events', this.state);
    } catch {
      /* browser storage unavailable: it all stays for this visit only */
    }
  }

  /** Makes an event of the user's own. Returns its id. */
  create(name: string): string {
    const id = `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.state.manual.push({ id, name: name.trim() || 'New event' });
    return id;
  }

  rename(id: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    const m = this.state.manual.find((x) => x.id === id);
    if (m) m.name = n;
    else this.state.names[id] = n;
  }

  /** Removes an event the user made. Its matches go back to where the logs put them, and logs added to it are free again. */
  removeEvent(id: string): void {
    this.state.manual = this.state.manual.filter((m) => m.id !== id);
    delete this.state.names[id];
    for (const [k, v] of Object.entries(this.state.eventOf)) if (v === id) delete this.state.eventOf[k];
    for (const [k, v] of Object.entries(this.state.eventOfLog)) if (v === id) delete this.state.eventOfLog[k];
  }

  /** Moves matches to an event. */
  assign(keys: string[], id: string): void {
    for (const k of keys) this.state.eventOf[k] = id;
  }

  /** Says these logs belong to an event, so they are only matched within it. */
  assignLogs(names: string[], id: string): void {
    for (const n of names) this.state.eventOfLog[n] = id;
  }

  eventOfLog(name: string): string | undefined {
    return this.state.eventOfLog[name];
  }

  /** Forgets what was said about matches that are gone. */
  forget(keys: string[]): void {
    for (const k of keys) delete this.state.eventOf[k];
  }

  clear(): void {
    this.state = emptyEventState();
  }
}
