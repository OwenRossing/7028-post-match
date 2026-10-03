import { describe, expect, it } from 'vitest';
import { alignWPILog, clockSpan, planPlacements, placeLog, rioAnchors, robotMatchTitle, type Candidate, type DsAnchor } from '../src/lib/aggregate';
import { fileKind, mergeEntries, summaryKeyOf, versionKey, type LogEntry } from '../src/lib/library';
import { parseWPILog } from '../src/lib/wpilog';
import { WPILogWriter } from './helpers/wpilog-writer';

// The roboRIO had been up 250.4 s when the DS log began: rio time = DS time + 250.4, so offset = -250.4
const SHIFT = 250.4;
const DS_START = 1_767_225_600; // 2026-01-01T00:00:00Z

const ds: DsAnchor = {
  startUnix: DS_START,
  duration: 200,
  enabled: [
    { start: 15, end: 30 },
    { start: 35, end: 170 },
  ],
  messages: [
    { t: 3, text: 'Robot code starting up now' },
    { t: 20, text: 'Auto selected: two piece left' },
    { t: 40, text: 'Shooter is spinning up to speed' },
    { t: 60, text: 'Loop time of 0.02s overrun' },
    { t: 90, text: 'Loop time of 0.02s overrun' },
    { t: 120, text: 'Climber extended and locked' },
    { t: 150, text: 'Intake current spike on channel 7' },
    { t: 160, text: 'ok' }, // too short to trust
  ],
};

function rio(opts: { clock?: boolean; enabled?: boolean; messages?: boolean; shift?: number; extra?: (w: WPILogWriter) => void }) {
  const shift = opts.shift ?? SHIFT;
  const w = new WPILogWriter();
  const t = (dsT: number) => dsT + shift;
  if (opts.enabled !== false) {
    const e = w.start('DS:enabled', 'boolean', 0);
    w.boolean(e, 0, false);
    for (const win of ds.enabled) {
      w.boolean(e, t(win.start), true);
      w.boolean(e, t(win.end), false);
    }
  }
  if (opts.messages !== false) {
    const m = w.start('messages', 'string', 0);
    for (const msg of ds.messages) w.string(m, t(msg.t) - 0.02, `${msg.text}\n`); // the robot logs it 20 ms before the DS hears it
  }
  if (opts.clock) {
    const c = w.start('systemTime', 'int64', 0);
    w.int64(c, t(0), (DS_START + 0.7) * 1e6); // at the moment the DS log began, the robot's clock read 0.7 s ahead
  }
  opts.extra?.(w);
  const end = w.start('end', 'double');
  w.double(end, t(ds.duration), 0);
  return parseWPILog(w.bytes());
}

describe('alignWPILog', () => {
  it('lines up by shared messages, to within the network delay', () => {
    const a = alignWPILog(rio({ enabled: false }), ds);
    expect(a.method).toBe('messages');
    expect(a.confidence).toBe('high');
    expect(a.offset).toBeCloseTo(-SHIFT + 0.02, 2);
    expect(a.detail).toMatch(/shared console messages/);
  });

  it('is not fooled by a message that repeats', () => {
    // 0.02 s overrun twice in the DS log and, here, 12 more times in the robot's
    const a = alignWPILog(
      rio({
        enabled: false,
        extra: () => undefined,
      }),
      { ...ds, messages: [...ds.messages, ...Array.from({ length: 12 }, (_, i) => ({ t: 175 + i * 0.5, text: 'Loop time of 0.02s overrun' }))] },
    );
    expect(a.offset).toBeCloseTo(-SHIFT + 0.02, 1);
  });

  it('falls back to enabled periods when no messages were logged', () => {
    const a = alignWPILog(rio({ messages: false }), ds);
    expect(a.method).toBe('enabled');
    expect(a.confidence).toBe('high');
    expect(a.offset).toBeCloseTo(-SHIFT, 6);
  });

  it('falls back to the clock when it is all there is, and says it is only medium', () => {
    const a = alignWPILog(rio({ messages: false, enabled: false, clock: true }), ds);
    expect(a.method).toBe('clock');
    expect(a.confidence).toBe('medium');
    expect(a.offset).toBeCloseTo(-SHIFT + 0.7, 6);
  });

  it('notes when methods agree and when they do not', () => {
    const agree = alignWPILog(rio({ clock: true, messages: false }), ds);
    expect(agree.method).toBe('enabled');
    expect(agree.detail).toMatch(/differs from the roboRIO's clock by 0\.7 s/);
    expect(Object.keys(agree.tried).sort()).toEqual(['clock', 'enabled']);

    const both = alignWPILog(rio({ clock: true }), ds);
    expect(both.method).toBe('messages');
    expect(both.detail).toMatch(/agrees with the enabled periods/);
  });

  it('says so when nothing can be matched', () => {
    const a = alignWPILog(rio({ enabled: false, messages: false }), ds);
    expect(a.method).toBeUndefined();
    expect(a.confidence).toBe('none');
    expect(a.detail).toMatch(/Couldn't line this log up/);
  });

  it('rejects a log that lands outside the match', () => {
    // enabled windows match only if shifted a long way: log from another run entirely
    const w = rio({ messages: false });
    const a = alignWPILog(w, { ...ds, duration: 200, enabled: [{ start: 1000, end: 1015 }, { start: 1020, end: 1155 }] });
    // matches by enabled (offset ~ 1000+) but then sits beyond the DS log's 200 s
    expect(a.confidence).toBe('none');
    expect(a.detail).toMatch(/outside the match/);
  });

  it('does not trust an enabled pattern that only partly matches', () => {
    // the first period coincides but nothing else does: 17% of the enabled time
    const a = alignWPILog(rio({ messages: false }), { ...ds, messages: [], enabled: [{ start: 15, end: 30 }, { start: 100, end: 110 }] });
    expect(a.method).toBeUndefined();
    expect(a.confidence).toBe('none');
  });

  it('reports a decent but imperfect enabled match as medium', () => {
    // the DS saw the same two periods, but the second one ended 20 s sooner than the robot's log says
    const a = alignWPILog(rio({ messages: false }), { ...ds, messages: [], enabled: [{ start: 15, end: 30 }, { start: 35, end: 150 }] });
    expect(a.method).toBe('enabled');
    expect(a.confidence).toBe('medium');
  });
});

describe('which match does a robot log belong to', () => {
  const cand = (key: string, startOffset: number, duration = 160, id?: Candidate['id']): Candidate => ({
    key,
    id,
    anchor: { ...ds, startUnix: DS_START + startOffset, duration },
  });

  it('uses the robot clock span', () => {
    expect(clockSpan(rio({ clock: true }))!.start).toBeCloseTo(DS_START + 0.7 - SHIFT, 3); // log time 0 is 250.4 s before DS time 0, 0.7 s fast
  });

  it('trusts overlapping wall clocks, and rejects ones that do not overlap', () => {
    const a = rioAnchors(rio({ clock: true }));
    expect(placeLog(a, cand('a', 0)).fit).toBe('high');
    expect(placeLog(a, cand('b', 10, 150)).fit).toBe('high');
    expect(placeLog(a, cand('elsewhere', 86400)).fit).toBe('none');
    expect(placeLog(a, cand('partly', 170, 100)).fit).toBe('low'); // only 30 s of it inside the run
  });

  it('a match the field named the same is the same match, whatever the clocks say', () => {
    const a = rioAnchors(rio({ clock: true, extra: (w) => fms(w, 'MNST', 2, 22) }));
    expect(a.ids).toEqual([{ event: 'MNST', type: 'qualification', number: 22 }]);
    expect(placeLog(a, cand('q22', 99999, 160, { event: 'MNST', type: 'qualification', number: 22 })).fit).toBe('high');
    // a different match is out even though the clocks overlap
    expect(placeLog(a, cand('q23', 0, 160, { event: 'MNST', type: 'qualification', number: 23 })).fit).toBe('none');
    expect(placeLog(a, cand('p22', 0, 160, { event: 'MNST', type: 'practice', number: 22 })).fit).toBe('none');
    expect(placeLog(a, cand('other event', 0, 160, { event: 'WISU', type: 'qualification', number: 22 })).fit).toBe('none');
  });

  it('falls back to the pattern of what happened when there is no clock or name', () => {
    const a = rioAnchors(rio({ clock: false }));
    expect(placeLog(a, cand('x', 0)).fit).toBe('high'); // messages and enabled periods agree, nothing else fits
  });

  it('does not guess when the same pattern fits more than one place', () => {
    // one robot run with two matches that look alike: enabled 15-30 and 35-170, then again 600 s later
    const w = new WPILogWriter();
    const e = w.start('DS:enabled', 'boolean', 0);
    for (const base of [300, 900]) {
      w.boolean(e, base + 15, true);
      w.boolean(e, base + 30, false);
      w.boolean(e, base + 35, true);
      w.boolean(e, base + 170, false);
    }
    const end = w.start('end', 'double');
    w.double(end, 1200, 0);
    const a = rioAnchors(parseWPILog(w.bytes()));
    const p = placeLog(a, { key: 'q', anchor: { ...ds, startUnix: undefined, messages: [] } });
    expect(p.fit).not.toBe('high');
    expect(p.why).toMatch(/more than one place/);
  });

  it('reads the match from the file name when the log has no field info', () => {
    const w = rio({ messages: false, enabled: false });
    expect(rioAnchors(w, 'FRC_20260516_163821_MNST_q22.wpilog').ids).toEqual([{ event: 'MNST', type: 'qualification', number: 22 }]);
    expect(rioAnchors(w, 'FRC_20260516_163821_MNST_P3.wpilog').ids[0]).toMatchObject({ type: 'practice', number: 3 });
    expect(rioAnchors(w, 'FRC_20260516_163821.wpilog').ids).toEqual([]);
    expect(rioAnchors(w, 'whatever.wpilog').ids).toEqual([]);
    expect(rioAnchors(w, 'FRC_TBD_a1b2c3.wpilog').ids).toEqual([]); // before the Driver Station connected
    // the event part may be missing, and a copied file keeps its name
    expect(rioAnchors(w, 'FRC_20240315_143022_q1.wpilog').ids).toEqual([{ event: undefined, type: 'qualification', number: 1 }]);
    expect(rioAnchors(w, 'FRC_20240315_143022_MNST_Q12 (1).wpilog').ids).toEqual([{ event: 'MNST', type: 'qualification', number: 12 }]);
  });

  it('names a match that only has robot logs', () => {
    expect(robotMatchTitle([{ type: 'qualification', number: 22 }])).toBe('Qualification 22');
    expect(robotMatchTitle([{ type: 'elimination', number: 4 }])).toBe('Playoff 4');
    expect(robotMatchTitle([])).toBe('Robot log');
    expect(robotMatchTitle([], 'FRC_20260516_163821.wpilog')).toBe('Robot log FRC_20260516_163821');
    expect(robotMatchTitle([{ type: 'practice', number: 2 }], 'FRC_x.wpilog')).toBe('Practice 2');
  });

  it('plans only what is new and wanted', () => {
    const a = rioAnchors(rio({ clock: true }));
    const logs = [{ name: 'r.wpilog', anchors: a }];
    const cands = [cand('a', 0), cand('b', 10, 150), cand('far', 86400)];
    const none = () => false;
    expect(planPlacements(logs, cands, none, none).map((m) => m.key)).toEqual(['a', 'b']);
    // already there, or taken off by the user: left alone
    expect(planPlacements(logs, cands, (_n, k) => k === 'a', none).map((m) => m.key)).toEqual(['b']);
    expect(planPlacements(logs, cands, none, (_n, k) => k === 'b').map((m) => m.key)).toEqual(['a']);
  });
});

/** Field match info the way DataLogManager logs it. */
function fms(w: WPILogWriter, event: string, type: number, number: number) {
  const ev = w.start('NT:/FMSInfo/EventName', 'string', 0);
  const mn = w.start('NT:/FMSInfo/MatchNumber', 'int64', 0);
  const mt = w.start('NT:/FMSInfo/MatchType', 'int64', 0);
  w.string(ev, 1, event);
  w.int64(mt, 1, type);
  w.int64(mn, 1, number);
}

describe('entries with attached logs', () => {
  const ref = (name: string, size = 10, mtime = 1) => ({ name, size, mtime, read: async () => new ArrayBuffer(0) });
  const base: LogEntry = { key: 'm1', source: 'folder', startTime: 1, dslog: ref('m1.dslog'), dsevents: ref('m1.dsevents') };

  it('recognises file kinds', () => {
    expect(fileKind('a.dslog')).toBe('ds');
    expect(fileKind('a.DSEVENTS')).toBe('ds');
    expect(fileKind('FRC_20260101_000000.wpilog')).toBe('wpilog');
    expect(fileKind('b.hoot')).toBe('hoot');
    expect(fileKind('notes.txt')).toBeNull();
  });

  it('changes the parse key but not the summary key when a log is attached', () => {
    const withRio: LogEntry = { ...base, extras: [{ kind: 'wpilog', file: ref('r.wpilog') }] };
    expect(summaryKeyOf(withRio)).toBe(summaryKeyOf(base));
    expect(versionKey(withRio)).not.toBe(versionKey(base));
    const bigger: LogEntry = { ...base, extras: [{ kind: 'wpilog', file: ref('r.wpilog', 99) }] };
    expect(versionKey(bigger)).not.toBe(versionKey(withRio));
  });

  it('keeps attached logs when the DS side is rescanned', () => {
    const withRio: LogEntry = { ...base, extras: [{ kind: 'wpilog', file: ref('r.wpilog') }], summaryKey: summaryKeyOf(base) };
    const rescanned: LogEntry = { ...base, dslog: ref('m1.dslog', 11, 2) };
    const merged = mergeEntries(new Map([['m1', withRio]]), [rescanned]).get('m1')!;
    expect(merged.extras).toHaveLength(1);
    expect(merged.dslog!.size).toBe(11);
  });
});
