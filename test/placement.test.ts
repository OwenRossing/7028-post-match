import { describe, expect, it } from 'vitest';
import { alignToSibling, identityFit, placeLog, planPlacements, type Alignment, type Candidate, type KnownLog, type RioAnchors } from '../src/lib/aggregate';
import { linkBoots, type ExtraInfo } from '../src/lib/extras';
import type { MatchId } from '../src/lib/wpilog';

// These are the rules that keep a pool of many events clean: what a name, a clock and a shape can each settle alone.

const T = 1_780_000_000;
const q = (n: number, event?: string): MatchId => ({ ...(event ? { event } : {}), type: 'qualification', number: n });

/** A robot log that ran for `length` seconds from `start`, optionally with a wall clock and match names. */
function rio(o: { start?: number; length?: number; clock?: boolean; ids?: MatchId[]; idsFrom?: 'log' | 'name'; stamp?: number; enabled?: RioAnchors['enabled'] }): RioAnchors {
  const start = o.start ?? T;
  return {
    first: 0,
    last: o.length ?? 200,
    enabled: o.enabled ?? [],
    lines: [],
    clockOffset: o.clock === false ? undefined : start,
    ids: o.ids ?? [],
    idsFrom: o.ids?.length ? (o.idsFrom ?? 'log') : undefined,
    stamp: o.stamp,
  };
}

const match = (key: string, start: number, id?: MatchId, enabled: RioAnchors['enabled'] = []): Candidate => ({ key, id, anchor: { startUnix: start, duration: 160, enabled, messages: [] } });

describe('a match name', () => {
  it('names the event or it does not: without one the same number fits at every event', () => {
    expect(identityFit(rio({ ids: [q(22, 'MNST')] }), match('a', T, q(22, 'MNST')))).toMatchObject({ fit: 'high', weak: false });
    expect(identityFit(rio({ ids: [q(22)] }), match('a', T, q(22, 'MNST')))).toMatchObject({ fit: 'high', weak: true });
    expect(identityFit(rio({ ids: [q(22, 'WIMI')] }), match('a', T, q(22, 'MNST')))).toMatchObject({ fit: 'none' });
  });

  it('is trusted whatever the clocks say when both sides name the event', () => {
    expect(placeLog(rio({ ids: [q(22, 'MNST')] }), match('far', T + 99999, q(22, 'MNST'))).fit).toBe('high');
  });

  it('without an event, needs the clock to say which of several events it means', () => {
    const log = rio({ ids: [q(22)], idsFrom: 'name' });
    const here = match('here', T, q(22, 'MNST'));
    const there = match('there', T + 21 * 86400, q(22, 'WIMI'));
    const p = (c: Candidate, nameMatches: number) => placeLog(log, c, { nameMatches });
    expect(p(here, 2).fit).toBe('high'); // the clock agrees with this one
    expect(p(there, 2).fit).toBe('medium'); // and not with that one: a suggestion, never automatic
    expect(p(there, 2).why).toMatch(/clocks say they do not overlap/);
  });

  it('without an event or a clock, is trusted only when it points at one match', () => {
    const log = rio({ clock: false, ids: [q(22)], idsFrom: 'name' });
    const m = match('m', T, q(22, 'MNST'));
    expect(placeLog(log, m, { nameMatches: 1 }).fit).toBe('high');
    expect(placeLog(log, m, { nameMatches: 3 }).fit).toBe('medium');
    expect(placeLog(log, m, { nameMatches: 3, sameEvent: true }).fit).toBe('high'); // put in this match's event: it is the one
  });

  it('from the file name only says where the run began, so another number is not a no', () => {
    const named = rio({ ids: [q(22, 'MNST')], idsFrom: 'name', start: T, length: 1500 }); // named for Q22, ran on through Q23
    expect(placeLog(named, match('q23', T + 600, q(23, 'MNST'))).fit).toBe('high'); // the clocks say so
    // while the log's own field records name every match it ran, so another number really is a no
    const recorded = rio({ ids: [q(22, 'MNST')], idsFrom: 'log', start: T, length: 1500 });
    expect(placeLog(recorded, match('q23', T + 600, q(23, 'MNST'))).fit).toBe('none');
  });
});

describe('what happened, without a name or a clock', () => {
  it('is never enough on its own: every match has the same auto and teleop windows', () => {
    const shape = [
      { start: 5, end: 20 },
      { start: 25, end: 156 },
    ];
    const log = rio({ clock: false, enabled: shape });
    const p = placeLog(log, match('m', T, undefined, shape));
    expect(p.fit).toBe('medium'); // it looks right, and it would look right on any match
  });
});

describe('putting logs in events', () => {
  const mnst = match('mnst-q22', T, q(22, 'MNST'));
  const wimi = match('wimi-q22', T + 21 * 86400, q(22, 'WIMI'));
  const eventOfMatch = (k: string) => (k.startsWith('mnst') ? 'MNST' : 'WIMI');
  const none = () => false;

  it('weighs a log only against the matches of its own event', () => {
    // a log with no clock, named only Q22: unscoped it cannot tell the two Q22s apart
    const logs: KnownLog[] = [{ name: 'a', anchors: rio({ clock: false, ids: [q(22)], idsFrom: 'name' }) }];
    expect(planPlacements(logs, [mnst, wimi], none, none)).toEqual([]);
    const scoped = planPlacements(logs, [mnst, wimi], none, none, { eventOfLog: () => 'WIMI', eventOfMatch });
    expect(scoped.map((m) => m.key)).toEqual(['wimi-q22']);
  });

  it('never places a log outside the event it was put in, whatever it names', () => {
    const logs: KnownLog[] = [{ name: 'a', anchors: rio({ ids: [q(22, 'MNST')] }) }];
    expect(planPlacements(logs, [mnst], none, none, { eventOfLog: () => 'WIMI', eventOfMatch })).toEqual([]);
  });

  it('leaves an unscoped log alone when it points at one match only', () => {
    const logs: KnownLog[] = [{ name: 'a', anchors: rio({ clock: false, ids: [q(22)], idsFrom: 'name' }) }];
    expect(planPlacements(logs, [mnst], none, none).map((m) => m.key)).toEqual(['mnst-q22']); // the only Q22 there is
  });
});

describe('the log of the same boot', () => {
  const m1 = match('m1', T + 400, q(11, 'MNST'));
  const m2 = match('m2', T + 1000, q(12, 'MNST'));
  const m3 = match('m3', T + 1600, q(13, 'MNST'));
  const none = () => false;
  // the roboRIO's log ran through three matches; the Phoenix log of that boot is only named for the first
  const rioLog: KnownLog = { name: 'FRC.wpilog', anchors: rio({ start: T, length: 2000, stamp: T + 3 }) };
  const hoot = (over: Partial<RioAnchors> = {}): KnownLog => ({
    name: 'MNST_Q11_rio.hoot',
    anchors: { first: 0, last: 2001, enabled: [], lines: [], ids: [q(11, 'MNST')], idsFrom: 'name', stamp: T + 10, ...over },
  });

  it('goes where the roboRIO log of that run went', () => {
    const moves = planPlacements([rioLog, hoot()], [m1, m2, m3], none, none);
    expect(moves.filter((m) => m.name === 'MNST_Q11_rio.hoot').map((m) => m.key).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(moves.find((m) => m.name === 'MNST_Q11_rio.hoot' && m.key === 'm2')!.why).toMatch(/same boot as FRC\.wpilog/);
  });

  it('works for a hoot with no match in its name at all', () => {
    const moves = planPlacements([rioLog, hoot({ ids: [], idsFrom: undefined })], [m1, m2, m3], none, none);
    expect(moves.filter((m) => m.name === 'MNST_Q11_rio.hoot')).toHaveLength(3);
  });

  it('does not guess when it began at another time, ran for another length, or two runs look alike', () => {
    for (const other of [hoot({ stamp: T + 500 }), hoot({ last: 900 })]) expect(planPlacements([rioLog, other], [m1, m2, m3], none, none).filter((m) => m.name === other.name).map((m) => m.key)).toEqual(['m1']); // only its own name's match
    const twin: KnownLog = { name: 'FRC-2.wpilog', anchors: rio({ start: T + 20, length: 2000, stamp: T + 25 }) };
    const moves = planPlacements([rioLog, twin, hoot({ ids: [], idsFrom: undefined })], [m1, m2, m3], none, none);
    expect(moves.filter((m) => m.name === 'MNST_Q11_rio.hoot')).toEqual([]); // two logs of that run: which one is it
  });

  it('does not contradict what the log itself says', () => {
    // named for a match the roboRIO log did not run through: leave both as they are
    const elsewhere = hoot({ ids: [q(40, 'MNST')] });
    const moves = planPlacements([rioLog, elsewhere], [m1, m2, m3, match('q40', T + 99999, q(40, 'MNST'))], none, none);
    expect(moves.filter((m) => m.name === elsewhere.name).map((m) => m.key)).toEqual(['q40']);
  });

  it('counts what is already attached, whichever log of the boot came first', () => {
    const attached = new Set(['FRC.wpilog@m1', 'FRC.wpilog@m2', 'FRC.wpilog@m3']);
    const moves = planPlacements([rioLog, hoot({ ids: [], idsFrom: undefined })], [m1, m2, m3], (n, k) => attached.has(`${n}@${k}`), none);
    expect(moves.filter((m) => m.name === 'MNST_Q11_rio.hoot').map((m) => m.key).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(moves.filter((m) => m.name === 'FRC.wpilog')).toEqual([]); // nothing new for the log that was already placed
  });

  it('respects what was taken off by hand and what is already there', () => {
    const moves = planPlacements([rioLog, hoot()], [m1, m2, m3], (n, k) => n === 'MNST_Q11_rio.hoot' && k === 'm1', (n, k) => n === 'MNST_Q11_rio.hoot' && k === 'm3');
    expect(moves.filter((m) => m.name === 'MNST_Q11_rio.hoot').map((m) => m.key)).toEqual(['m2']);
  });
});

describe('lining a log up by the log of the same boot', () => {
  const T0 = 1_780_000_000;
  const w = rio({ start: T0, length: 2000, stamp: T0 + 2 }); // the roboRIO log, with a wall clock
  const phoenix = (over: Partial<RioAnchors> = {}): RioAnchors => ({ first: 0, last: 2001, enabled: [], lines: [], ids: [], stamp: T0 + 9, ...over });

  it('puts it where the two began in relation to each other, on the match timeline', () => {
    // the roboRIO log's time 0 is 100 s into the match; its clock says it began at T0, and the Phoenix log's name says T0 + 9
    const al = alignToSibling(phoenix(), w, 100, 'FRC.wpilog')!;
    expect(al.method).toBe('boot');
    expect(al.confidence).toBe('medium');
    expect(al.offset).toBeCloseTo(109, 6); // the clock is used over the roboRIO log's own file name (T0 + 2) because it is exact
    expect(al.detail).toMatch(/FRC\.wpilog, the log of the same boot/);
    // a roboRIO log with no clock of its own is read by its file name
    expect(alignToSibling(phoenix(), rio({ clock: false, length: 2000, stamp: T0 }), 100, 'x')!.offset).toBeCloseTo(109, 6);
  });

  it('allows for where each log started counting', () => {
    // the roboRIO log's own clock starts at 5 s; the Phoenix log's at 3 s
    const al = alignToSibling(phoenix({ first: 3, last: 2004 }), { ...w, first: 5, last: 2005, clockOffset: T0 - 5 }, 100, 'x')!;
    // the roboRIO record at 5 s is at T0, its DS time 105; the Phoenix first record is 9 s after T0 - 0
    expect(al.offset).toBeCloseTo(5 + 100 + (T0 + 9 - T0) - 3, 6);
  });

  it('says nothing when the logs did not begin together, did not run as long, or are on another clock', () => {
    expect(alignToSibling(phoenix({ stamp: T0 + 500 }), w, 100, 'x')).toBeNull();
    expect(alignToSibling(phoenix({ stamp: T0 + 6 * 3600 }), w, 100, 'x')).toBeNull(); // a time zone: hours apart
    expect(alignToSibling(phoenix({ last: 900 }), w, 100, 'x')).toBeNull();
    expect(alignToSibling(phoenix({ stamp: undefined }), w, 100, 'x')).toBeNull();
    expect(alignToSibling(phoenix({ last: 10 }), w, 100, 'x')).toBeNull(); // too short to tell
  });
});

describe('linking the logs of a match by boot', () => {
  const T0 = 1_780_000_000;
  const info = (name: string, anchors: RioAnchors, alignment?: Alignment, over: Partial<ExtraInfo> = {}): ExtraInfo => ({ name, kind: 'wpilog', size: 1, ok: true, decoded: true, anchors, alignment, ...over });
  const good: Alignment = { method: 'clock', offset: 100, confidence: 'medium', detail: '', tried: {} };
  const none: Alignment = { offset: 0, confidence: 'none', detail: '', tried: {} };
  const rioInfo = () => info('FRC.wpilog', rio({ start: T0, length: 2000, stamp: T0 + 2 }), good);
  const hootAnchors: RioAnchors = { first: 0, last: 2001, enabled: [], lines: [], ids: [], stamp: T0 + 9 };

  it('lines up a log that could not be by the one that was', () => {
    const hoot = info('rio.hoot', hootAnchors, none);
    linkBoots([rioInfo(), hoot]);
    expect(hoot.alignment).toMatchObject({ method: 'boot', confidence: 'medium' });
    expect(hoot.alignment!.offset).toBeCloseTo(109, 6);
  });

  it('also takes a log with no alignment at all', () => {
    const hoot = info('rio.hoot', hootAnchors, undefined);
    linkBoots([rioInfo(), hoot]);
    expect(hoot.alignment?.method).toBe('boot');
  });

  it('leaves alone a log that already lines up, one that is not readable, and one that is only kept', () => {
    const own = info('b.wpilog', { ...hootAnchors }, { ...good, offset: 55 });
    const kept = info('k.hoot', hootAnchors, undefined, { decoded: false });
    linkBoots([rioInfo(), own, kept]);
    expect(own.alignment!.offset).toBe(55);
    expect(kept.alignment).toBeUndefined();
  });

  it('does not guess between two logs that both look like the boot', () => {
    const twin = info('FRC-2.wpilog', rio({ start: T0 + 30, length: 2000, stamp: T0 + 31 }), { ...good, offset: 130 });
    const hoot = info('rio.hoot', hootAnchors, none);
    linkBoots([rioInfo(), twin, hoot]);
    expect(hoot.alignment).toBe(none);
  });

  it('anchors every Phoenix log of the boot on the roboRIO log, never on each other', () => {
    const first = info('rio.hoot', hootAnchors, none);
    const second = info('rio2.hoot', { ...hootAnchors, stamp: T0 + 12 }, none);
    linkBoots([rioInfo(), first, second]);
    expect(first.alignment?.offset).toBeCloseTo(109, 6);
    expect(second.alignment?.offset).toBeCloseTo(112, 6); // each by its own start
    // with no roboRIO log to go by, two Phoenix logs line up with nothing
    const a = info('a.hoot', hootAnchors, none);
    const b = info('b.hoot', { ...hootAnchors, stamp: T0 + 12 }, none);
    linkBoots([a, b]);
    expect(a.alignment).toBe(none);
    expect(b.alignment).toBe(none);
  });
});
