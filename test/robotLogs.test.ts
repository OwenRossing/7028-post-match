import { describe, expect, it } from 'vitest';
import type { RioAnchors } from '../src/lib/aggregate';
import type { LogSummary } from '../src/lib/analysis';
import type { ExtraFile, FileRef, LogEntry } from '../src/lib/library';
import { RobotLogStore } from '../src/lib/robotLogs';

const DS_START = 1_767_225_600;

/** An in-memory stand-in for IndexedDB. */
function fakeDb() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(store: string, key: string) => data.get(`${store}/${key}`) as T | undefined,
    set: async (store: string, key: string, value: unknown) => void data.set(`${store}/${key}`, value),
    del: async (store: string, key: string) => void data.delete(`${store}/${key}`),
  };
}

const ref = (name: string): FileRef => ({ name, size: 10, mtime: 1, read: async () => new ArrayBuffer(0) });

/** A robot log's anchors for a run that covers [start, start + length] on the wall clock. */
function anchors(startUnix: number, length: number, ids: RioAnchors['ids'] = []): RioAnchors {
  return { first: 0, last: length, enabled: [], lines: [], clockOffset: startUnix, ids };
}

const extra = (name: string, a: RioAnchors, role = 'roboRIO'): ExtraFile => ({ kind: 'wpilog', file: ref(name), role, anchors: a });

/** A match with a Driver Station log, as the library holds it after reading. */
function dsMatch(key: string, offset: number, duration = 160, title = key): LogEntry {
  const summary = {
    startTime: DS_START + offset,
    duration,
    title,
    anchor: { startUnix: DS_START + offset, duration, enabled: [{ start: 15, end: 150 }], messages: [] },
  } as unknown as LogSummary;
  return { key, source: 'folder', startTime: DS_START + offset, dslog: ref(`${key}.dslog`), dsevents: ref(`${key}.dsevents`), summary };
}

describe('RobotLogStore', () => {
  it('adds robot matches and attached logs to the library entries, and nothing else changes', () => {
    const s = new RobotLogStore(fakeDb());
    const lib = new Map([['q22', dsMatch('q22', 0)]]);
    expect(s.applyTo(lib)).toBe(lib); // nothing to add: the same map comes back

    s.add('q22', extra('a.wpilog', anchors(DS_START, 200)));
    s.addRobotMatch('robot:b.wpilog', { startTime: DS_START + 5000, title: 'Qualification 30' });
    s.add('robot:b.wpilog', extra('b.wpilog', anchors(DS_START + 5000, 200)));
    const out = s.applyTo(lib);
    expect(out.get('q22')!.extras!.map((x) => x.file.name)).toEqual(['a.wpilog']);
    expect(out.get('robot:b.wpilog')).toMatchObject({ robot: { title: 'Qualification 30' }, startTime: DS_START + 5000 });
    expect(out.get('robot:b.wpilog')!.dslog).toBeUndefined();
    expect(s.applyTo(out)).toBe(out); // and applying again changes nothing
  });

  it('drops a robot match once it is gone from the store', () => {
    const s = new RobotLogStore(fakeDb());
    s.addRobotMatch('robot:b.wpilog', { startTime: 1, title: 'x' });
    s.add('robot:b.wpilog', extra('b.wpilog', anchors(DS_START, 200)));
    const withIt = s.applyTo(new Map());
    expect(withIt.has('robot:b.wpilog')).toBe(true);
    s.remove('robot:b.wpilog', 'b.wpilog'); // the last log: the match goes with it
    expect(s.applyTo(withIt).has('robot:b.wpilog')).toBe(false);
  });

  it('joins a robot match to its Driver Station log when that arrives, and the robot match goes away', () => {
    const s = new RobotLogStore(fakeDb());
    s.addRobotMatch('robot:a.wpilog', { startTime: DS_START, title: 'Robot log' });
    s.add('robot:a.wpilog', extra('a.wpilog', anchors(DS_START - 30, 300)));

    // no DS match yet: nothing to do
    expect(s.joinPlan([]).adds).toEqual([]);
    // the DS log of a match elsewhere in the day: still nothing
    expect(s.joinPlan([dsMatch('later', 20000)]).adds).toEqual([]);

    const plan = s.joinPlan([dsMatch('later', 20000), dsMatch('q22', 0)]);
    expect(plan.adds.map((a) => [a.name, a.key])).toEqual([['a.wpilog', 'q22']]);
    expect(plan.absorbed).toEqual(['robot:a.wpilog']);
    expect(s.applyJoin(plan)).toEqual(['q22']);
    expect(s.has('a.wpilog', 'q22')).toBe(true);
    expect(s.isRobotMatch('robot:a.wpilog')).toBe(false);
  });

  it('brings along every log of a robot match when one of them fits', () => {
    const s = new RobotLogStore(fakeDb());
    s.addRobotMatch('robot:a.wpilog', { startTime: DS_START, title: 'Robot log' });
    s.add('robot:a.wpilog', extra('a.wpilog', anchors(DS_START - 30, 300)));
    // a CTRE log with no clock of its own, grouped with the first when it was added
    s.add('robot:a.wpilog', extra('ctre.wpilog', { first: 0, last: 100, enabled: [], lines: [], ids: [] }, 'CTRE Phoenix'));
    const plan = s.joinPlan([dsMatch('q22', 0)]);
    expect(plan.adds.map((a) => a.name).sort()).toEqual(['a.wpilog', 'ctre.wpilog']);
    s.applyJoin(plan);
    expect(s.extrasFor('q22')!.map((x) => x.file.name).sort()).toEqual(['a.wpilog', 'ctre.wpilog']);
    expect(s.isRobotMatch('robot:a.wpilog')).toBe(false);
  });

  it('also adds a log that covers several matches to each one that appears', () => {
    const s = new RobotLogStore(fakeDb());
    s.add('q22', extra('run.wpilog', anchors(DS_START - 60, 1500))); // a whole run: two matches inside it
    const lib = [dsMatch('q22', 0), dsMatch('q23', 600)];
    const plan = s.joinPlan(lib);
    expect(plan.adds.map((a) => a.key)).toEqual(['q23']); // q22 already has it
    s.applyJoin(plan);
    expect(s.keysOf('run.wpilog').sort()).toEqual(['q22', 'q23']);
  });

  it('does not put back a log the user took off', () => {
    const s = new RobotLogStore(fakeDb());
    s.add('q22', extra('run.wpilog', anchors(DS_START - 60, 1500)));
    s.add('q23', extra('run.wpilog', anchors(DS_START - 60, 1500)));
    s.remove('q23', 'run.wpilog');
    expect(s.joinPlan([dsMatch('q22', 0), dsMatch('q23', 600)]).adds).toEqual([]);
    // adding it by hand again is allowed, and clears the memory of having removed it
    s.add('q23', extra('run.wpilog', anchors(DS_START - 60, 1500)));
    expect(s.isDismissed('run.wpilog', 'q23')).toBe(false);
  });

  it('keeps a robot match apart from a DS match the field says is a different one', () => {
    const s = new RobotLogStore(fakeDb());
    s.addRobotMatch('robot:a.wpilog', { startTime: DS_START, title: 'Qualification 31' });
    s.add('robot:a.wpilog', extra('a.wpilog', anchors(DS_START - 30, 300, [{ type: 'qualification', number: 31 }])));
    const q22 = dsMatch('q22', 0);
    q22.summary = { ...q22.summary!, fms: true, matchType: 'Qualification', matchNumber: 22 };
    expect(s.joinPlan([q22]).adds).toEqual([]); // clocks overlap, but the field called them different matches
    const q31 = dsMatch('q31', 100000);
    q31.summary = { ...q31.summary!, fms: true, matchType: 'Qualification', matchNumber: 31 };
    expect(s.joinPlan([q22, q31]).adds.map((a) => a.key)).toEqual(['q31']); // same match number: joins whatever the clocks say
  });

  it('remembers everything between visits', async () => {
    const db = fakeDb();
    const a = new RobotLogStore(db);
    const kept = await a.keep('a.wpilog', 3, 7, new Uint8Array([1, 2, 3]).buffer);
    a.addRobotMatch('robot:a.wpilog', { startTime: 5, title: 'Practice 2' });
    a.add('robot:a.wpilog', { kind: 'wpilog', file: kept, role: 'roboRIO', anchors: anchors(DS_START, 100), startUnix: DS_START });
    a.add('q22', extra('x.wpilog', anchors(DS_START, 100)));
    a.remove('q22', 'x.wpilog');
    await a.save((k) => k === 'sample');

    const b = new RobotLogStore(db);
    await b.load();
    expect(b.isRobotMatch('robot:a.wpilog')).toBe(true);
    const x = b.extrasFor('robot:a.wpilog')![0];
    expect(x).toMatchObject({ role: 'roboRIO', startUnix: DS_START });
    expect(x.anchors!.clockOffset).toBe(DS_START);
    expect(new Uint8Array(await x.file.read())).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.isDismissed('x.wpilog', 'q22')).toBe(true);
  });

  it('keeps a .hoot with its description and places it by the match in its name', async () => {
    const db = fakeDb();
    const s = new RobotLogStore(db);
    const hoot = { size: 80_000_000, magic: '48 4f 4f 54', head: [], tail: [], samples: [], entropy: { head: 5, middle: 5, tail: 5 }, zeroFraction: 0.3, strings: [], name: { ids: [] } };
    const anchors = { first: 0, last: 0, enabled: [], lines: [], ids: [{ type: 'qualification' as const, number: 22 }] };
    // no Driver Station log yet: the .hoot is a match of its own
    s.addRobotMatch('robot:x.hoot', { startTime: 1, title: 'Qualification 22' });
    s.add('robot:x.hoot', { kind: 'hoot', file: ref('x.hoot'), role: 'CTRE Phoenix', decoded: false, hoot, anchors });

    // then two DS logs arrive: it joins the match its name says, and not the other
    const q22 = dsMatch('q22', 0);
    q22.summary = { ...q22.summary!, fms: true, matchType: 'Qualification', matchNumber: 22 };
    const q23 = dsMatch('q23', 600);
    q23.summary = { ...q23.summary!, fms: true, matchType: 'Qualification', matchNumber: 23 };
    const plan = s.joinPlan([q22, q23]);
    expect(plan.adds.map((a) => a.key)).toEqual(['q22']);
    expect(plan.absorbed).toEqual(['robot:x.hoot']);

    // and what it was described as survives a reload
    await s.save();
    const b = new RobotLogStore(db);
    await b.load();
    expect(b.extrasFor('robot:x.hoot')![0]).toMatchObject({ kind: 'hoot', decoded: false, hoot: { size: 80_000_000 } });
  });

  it('does not save what it was told to skip, and frees files nothing uses any more', async () => {
    const db = fakeDb();
    const s = new RobotLogStore(db);
    await s.keep('s.wpilog', 1, 1, new ArrayBuffer(1));
    await s.keep('gone.wpilog', 1, 1, new ArrayBuffer(1));
    s.add('sample', extra('s.wpilog', anchors(DS_START, 100)));
    s.add('q22', extra('gone.wpilog', anchors(DS_START, 100)));
    s.remove('q22', 'gone.wpilog');
    await s.save((k) => k === 'sample', ['gone.wpilog']);
    expect(Object.keys(db.data.get('kv/attachments') as object)).toEqual([]);
    expect(db.data.has('files/gone.wpilog')).toBe(false);
  });
});
