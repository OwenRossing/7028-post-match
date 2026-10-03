import { describe, expect, it } from 'vitest';
import { summaryKeyOf, type ExtraFile, type FileRef, type LogEntry } from '../src/lib/library';
import { describeDelete, planDelete } from '../src/lib/manage';

const ref = (name: string, size = 10): FileRef => ({ name, size, mtime: 1, read: async () => new ArrayBuffer(0) });
const extra = (name: string): ExtraFile => ({ kind: 'wpilog', file: ref(name) });

const match = (key: string, source: LogEntry['source'], extras: ExtraFile[] = []): LogEntry => ({
  key,
  source,
  startTime: 1,
  dslog: ref(`${key}.dslog`),
  dsevents: ref(`${key}.dsevents`),
  extras: extras.length ? extras : undefined,
});

const library = [
  match('up1', 'upload', [extra('rio-1.wpilog')]),
  match('saved1', 'saved'),
  match('folder1', 'folder', [extra('rio-2.wpilog'), extra('ctre-2.wpilog')]),
  match('comp1', 'companion'),
  match('sample', 'sample'),
  { key: 'robot:x.hoot', source: 'saved', startTime: 1, robot: { title: 'Robot log x' }, extras: [extra('x.hoot')] } as LogEntry,
];

describe('planning a deletion', () => {
  it('removes saved matches from the browser and only hides the ones a watched folder holds', () => {
    const plan = planDelete(library, ['up1', 'saved1', 'folder1', 'comp1']);
    expect(plan.keys).toEqual(['up1', 'saved1', 'folder1', 'comp1']);
    expect(plan.hide).toEqual(['folder1', 'comp1']); // the folder's files are never touched: these are only hidden
    expect(plan.counts).toMatchObject({ total: 4, saved: 2, watched: 2, robotOnly: 0, sample: 0, robotLogs: 3 });
  });

  it('names the saved copies to delete, and the cached summaries of saved matches', () => {
    const plan = planDelete(library, ['up1', 'folder1']);
    // a saved copy of the same files can sit under a folder match, so both matches' file names go
    expect(plan.saved).toEqual(['up1.dslog', 'up1.dsevents', 'folder1.dslog', 'folder1.dsevents']);
    expect(plan.summaryKeys).toEqual([summaryKeyOf(library[0])]);
  });

  it('tells robot-only matches and the sample apart, and ignores keys that are not in the library', () => {
    const plan = planDelete(library, ['robot:x.hoot', 'sample', 'nothing-like-this']);
    expect(plan.keys).toEqual(['sample', 'robot:x.hoot']);
    expect(plan.hide).toEqual([]);
    expect(plan.counts).toMatchObject({ total: 2, robotOnly: 1, sample: 1, saved: 0, watched: 0, robotLogs: 1 });
    expect(planDelete(library, []).keys).toEqual([]);
  });
});

describe('asking before deleting', () => {
  it('says what is removed, what is only hidden, and that the folder is untouched', () => {
    const text = describeDelete(planDelete(library, ['up1', 'saved1', 'folder1']));
    expect(text).toMatch(/^Delete 3 matches\?/);
    expect(text).toMatch(/2 saved matches: removed from this browser/);
    expect(text).toMatch(/1 match from a watched folder: hidden\. The files in the folder are not touched, and Show hidden brings it back/);
    expect(text).toMatch(/3 attached robot logs go with them/);
    expect(text).not.toMatch(/arrive from now on/);
  });

  it('is plain about one match', () => {
    const text = describeDelete(planDelete(library, ['saved1']));
    expect(text).toMatch(/^Delete 1 match\?/);
    expect(text).toMatch(/1 saved match: removed/);
    expect(text).not.toMatch(/robot logs/);
    // one robot log on one match
    expect(describeDelete(planDelete([match('m', 'upload', [extra('a.wpilog')])], ['m']))).toMatch(/1 attached robot log goes with it\./);
  });

  it('says that clearing the library keeps what arrives later', () => {
    const text = describeDelete(planDelete(library, library.map((e) => e.key)), { all: true });
    expect(text).toMatch(/^Clear the whole library \(6 matches\)\?/);
    expect(text).toMatch(/1 robot-log-only match: removed/);
    expect(text).toMatch(/The sample log: closed/);
    expect(text).toMatch(/Matches that arrive from now on still appear/);
  });
});
