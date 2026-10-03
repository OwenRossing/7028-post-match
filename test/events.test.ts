import { describe, expect, it } from 'vitest';
import { emptyEventState, EventStore, eventIdOf, groupEvents, READING, UNSORTED, type EventState } from '../src/lib/events';
import type { FileRef, LogEntry } from '../src/lib/library';
import type { LogSummary } from '../src/lib/analysis';

const DAY = 86400;
const T = Date.UTC(2026, 2, 5, 15, 0, 0) / 1000; // a Thursday afternoon
const ref = (n: string): FileRef => ({ name: n, size: 1, mtime: 1, read: async () => new ArrayBuffer(0) });

/** A match with a Driver Station log. `event` is what the field called the event, when it was on a field. */
function ds(key: string, startTime: number, event?: string): LogEntry {
  const summary = { eventName: event, fms: !!event } as unknown as LogSummary;
  return { key, source: 'folder', startTime, dslog: ref(`${key}.dslog`), dsevents: ref(`${key}.dsevents`), summary };
}
const robotOnly = (key: string, startTime: number): LogEntry => ({ key, source: 'saved', startTime, robot: { title: key } });

const group = (entries: LogEntry[], st: EventState = emptyEventState()) => groupEvents(entries, st);
const byName = (r: ReturnType<typeof group>) => Object.fromEntries(r.events.map((e) => [e.name, e.keys]));

describe('events found from the logs', () => {
  it('groups matches by the event the field named, newest event first', () => {
    const r = group([ds('a1', T, 'MNST'), ds('a2', T + 600, 'MNST'), ds('b1', T + 21 * DAY, 'WIMI'), ds('a3', T + DAY, 'mnst')]);
    expect(r.events.map((e) => e.name)).toEqual(['WIMI 2026', 'MNST 2026']);
    expect(byName(r)).toEqual({ 'WIMI 2026': ['b1'], 'MNST 2026': ['a3', 'a2', 'a1'] }); // newest first within it; the code's case does not matter
    expect(r.of.get('a1')).toBe(eventIdOf('MNST', T));
  });

  it('keeps the same event code in different seasons apart', () => {
    const r = group([ds('y1', T, 'MNST'), ds('y2', T + 365 * DAY, 'MNST')]);
    expect(r.events.map((e) => e.name).sort()).toEqual(['MNST 2026', 'MNST 2027']);
  });

  it('puts a match with no field name at the event it falls inside of, and makes practice sessions of the rest', () => {
    const r = group([
      ds('q1', T, 'MNST'),
      ds('q9', T + DAY, 'MNST'),
      ds('pit', T + DAY + 4 * 3600), // an hour of testing the evening of the last match day
      ds('shop1', T - 30 * DAY),
      ds('shop2', T - 29 * DAY), // the next day: the same session
      ds('shop3', T - 20 * DAY), // more than three days later: another
    ]);
    expect(r.of.get('pit')).toBe(eventIdOf('MNST', T));
    const names = r.events.map((e) => e.name);
    expect(names[0]).toBe('MNST 2026');
    expect(names.filter((n) => n.startsWith('Practice'))).toHaveLength(2);
    expect(r.of.get('shop1')).toBe(r.of.get('shop2'));
    expect(r.of.get('shop3')).not.toBe(r.of.get('shop1'));
  });

  it('takes a robot-only match to the event or session it happened in, else to the bucket for the unplaced', () => {
    const r = group([ds('q1', T, 'MNST'), robotOnly('robot:in', T + 3600), robotOnly('robot:out', T + 90 * DAY)]);
    expect(r.of.get('robot:in')).toBe(eventIdOf('MNST', T));
    expect(r.of.get('robot:out')).toBe(UNSORTED);
    expect(r.events.at(-1)!.id).toBe(UNSORTED); // last
  });
});

describe('matches that have not been read yet', () => {
  it('wait in a group of their own instead of being guessed into an event and moved', () => {
    const unread: LogEntry = { key: 'later', source: 'folder', startTime: T + 60, dslog: ref('later.dslog'), dsevents: ref('later.dsevents') };
    const r = group([ds('q1', T, 'MNST'), unread]);
    expect(r.of.get('later')).toBe(READING);
    expect(r.events.map((e) => e.name)).toEqual(['MNST 2026', 'Reading logs…']);
    // once it has been read it goes where its log says
    const read = { ...unread, summary: { eventName: 'MNST', fms: true } as unknown as LogSummary };
    expect(group([ds('q1', T, 'MNST'), read]).of.get('later')).toBe(eventIdOf('MNST', T));
    // a log that could not be read is not left waiting
    expect(group([ds('q1', T, 'MNST'), { ...unread, summaryError: 'bad' }]).of.get('later')).toBe(eventIdOf('MNST', T)); // it is inside the event's days
  });

  it('go where the user put them, even before they are read', () => {
    const unread: LogEntry = { key: 'later', source: 'folder', startTime: T + 60, dslog: ref('later.dslog') };
    expect(group([unread], { ...emptyEventState(), manual: [{ id: 'manual:x', name: 'X' }], eventOf: { later: 'manual:x' } }).of.get('later')).toBe('manual:x');
  });
});

describe('events the user makes and changes', () => {
  it('lets matches be moved, and lists an empty event so logs can be added to it', () => {
    const store = new EventStore({ get: async () => undefined, set: async () => undefined });
    const mine = store.create('Week 0 scrimmage');
    const spare = store.create('Not used yet');
    store.assign(['q1'], mine);
    const r = group([ds('q1', T, 'MNST'), ds('q2', T + 60, 'MNST')], store.state);
    expect(byName(r)).toEqual({ 'Week 0 scrimmage': ['q1'], 'MNST 2026': ['q2'], 'Not used yet': [] });
    expect(r.of.get('q1')).toBe(mine);
    expect(r.events.find((e) => e.id === spare)).toMatchObject({ manual: true, keys: [], start: 0, end: 0 });
    // an empty event leads (it is what is about to be filled), then newest first
    expect(r.events.map((e) => e.name)).toEqual(['Not used yet', 'MNST 2026', 'Week 0 scrimmage']);
    // and two empty ones next to each other sort steadily rather than confusing the order
    const two = group([ds('q2', T + 60, 'MNST')], { ...store.state, eventOf: {} });
    expect(two.events.map((e) => e.name).sort()).toEqual(['MNST 2026', 'Not used yet', 'Week 0 scrimmage']);
  });

  it('puts matches back where the logs say when the event is deleted', () => {
    const store = new EventStore({ get: async () => undefined, set: async () => undefined });
    const mine = store.create('Mine');
    store.assign(['q1'], mine);
    store.assignLogs(['a.hoot'], mine);
    store.removeEvent(mine);
    expect(group([ds('q1', T, 'MNST')], store.state).of.get('q1')).toBe(eventIdOf('MNST', T));
    expect(store.eventOfLog('a.hoot')).toBeUndefined();
  });

  it('renames an event the logs made, and one the user made', () => {
    const store = new EventStore({ get: async () => undefined, set: async () => undefined });
    const mine = store.create('Old');
    store.rename(mine, 'Newer');
    store.rename(eventIdOf('MNST', T), 'Minnesota North Star');
    store.rename(mine, '   '); // an empty name changes nothing
    const r = group([ds('q1', T, 'MNST')], store.state);
    expect(r.events.map((e) => e.name).sort()).toEqual(['Minnesota North Star', 'Newer']);
  });

  it('ignores a move to an event that no longer exists', () => {
    const st: EventState = { ...emptyEventState(), eventOf: { q1: 'manual:gone' } };
    expect(group([ds('q1', T, 'MNST')], st).of.get('q1')).toBe(eventIdOf('MNST', T));
  });

  it('remembers all of it between visits', async () => {
    const data = new Map<string, unknown>();
    const db = { get: async <V>(_s: string, k: string) => data.get(k) as V | undefined, set: async (_s: string, k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))) };
    const a = new EventStore(db);
    const mine = a.create('Scrimmage');
    a.assign(['q1'], mine);
    a.assignLogs(['FRC_1.wpilog'], mine);
    a.rename(eventIdOf('MNST', T), 'Minnesota');
    await a.save();
    const b = new EventStore(db);
    await b.load();
    expect(b.state.manual).toEqual([{ id: mine, name: 'Scrimmage' }]);
    expect(b.eventOfLog('FRC_1.wpilog')).toBe(mine);
    expect(group([ds('q1', T, 'MNST'), ds('q2', T, 'MNST')], b.state).events.map((e) => e.name).sort()).toEqual(['Minnesota', 'Scrimmage']);
    b.forget(['q1']);
    expect(group([ds('q1', T, 'MNST')], b.state).of.get('q1')).toBe(eventIdOf('MNST', T));
  });
});
