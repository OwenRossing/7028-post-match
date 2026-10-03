import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCompanion, type CompanionHandle } from '../server/companion.mjs';
import { convertedNote, listRobot, robotRef, type RobotItem } from '../src/lib/companion';
import { robotSummaryText } from '../src/components/RobotMenu';
import { rioAnchors } from '../src/lib/aggregate';
import { parseWPILog } from '../src/lib/wpilog';
import { WPILogWriter } from './helpers/wpilog-writer';

let tmp: string;
let h: CompanionHandle | undefined;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitview-client-'));
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const log = () => {
  const w = new WPILogWriter();
  w.double(w.start('Phoenix6/TalonFX-1/Position', 'double'), 1, 1);
  return w.bytes();
};

describe.skipIf(process.platform === 'win32')('the page talking to the engine', () => {
  it('lists the robot folder and downloads what it listed', async () => {
    const robot = path.join(tmp, 'robot');
    mkdirSync(robot);
    writeFileSync(path.join(robot, 'a.wpilog'), log());
    writeFileSync(path.join(robot, 'b.hoot'), Buffer.alloc(100, 7));
    const fixture = path.join(tmp, 'fx.wpilog');
    writeFileSync(fixture, log());
    const owlet = path.join(tmp, 'owlet');
    writeFileSync(owlet, `#!/bin/sh\ncp '${fixture}' "$4"\n`);
    chmodSync(owlet, 0o755);
    h = await startCompanion({ port: 0, robotDir: robot, owlet, convertDir: path.join(tmp, 'c') });
    for (let i = 0; i < 4; i++) await h.robot.scan();
    for (let i = 0; i < 80 && h.robot.snapshot().items.some((x) => x.state !== 'ready'); i++) await new Promise((r) => setTimeout(r, 50));

    const listing = (await listRobot(h.url))!;
    expect(listing.owlet.found).toBe(true);
    expect(robotSummaryText(listing)).toBe('1 .wpilog · 1 .hoot');
    const hoot = listing.items.find((i) => i.kind === 'hoot')!;
    // what the engine checked reaches the app, to be shown on the card
    expect(hoot.converted).toMatchObject({ signals: 1, records: 2, seconds: 0 }); // this fixture has a single reading
    // the converted log comes back as the file; the original is available too
    const converted = new Uint8Array(await robotRef(h.url, hoot).read());
    expect(parseWPILog(converted).entries[0].name).toBe('Phoenix6/TalonFX-1/Position');
    expect(new Uint8Array(await robotRef(h.url, hoot, 'source').read())).toEqual(new Uint8Array(100).fill(7));
    // and the converted file takes the match from the hoot's name when it has none of its own
    expect(rioAnchors(parseWPILog(converted), 'MNST_Q22_rio_2026-05-16.hoot').ids).toEqual([{ event: 'MNST', type: 'qualification', number: 22 }]);
  });

  it('summarises what Owlet is doing in plain words', () => {
    const item = (kind: 'wpilog' | 'hoot', state: 'ready' | 'queued' | 'converting' | 'failed' | 'needs-owlet', n: number) => ({ id: String(n), name: `${n}`, path: `${n}`, kind, size: 1, mtime: 1, state });
    const base = { dir: '/r', owlet: { path: '/o', configured: null, found: true } };
    expect(robotSummaryText({ ...base, items: [] })).toBe('0 .wpilogs · 0 .hoots');
    expect(robotSummaryText({ ...base, items: [item('hoot', 'converting', 1), item('hoot', 'queued', 2), item('hoot', 'failed', 3), item('wpilog', 'ready', 4)] })).toBe(
      '1 .wpilog · 3 .hoots · 2 converting · 1 failed',
    );
    expect(robotSummaryText({ ...base, items: [item('hoot', 'needs-owlet', 1)] })).toBe('0 .wpilogs · 1 .hoot · 1 waiting for Owlet');
  });

  it('tells the user what was converted, in plain words, and why signals could still be missing', () => {
    const base: RobotItem = { id: '1', name: 'Q22.hoot', path: 'Q22.hoot', kind: 'hoot', size: 80e6, mtime: 1, state: 'ready' };
    const note = convertedNote({ ...base, converted: { signals: 412, records: 9e6, seconds: 151, bytes: 2e8 } })!;
    expect(note).toMatch(/read back from start to end and is complete: 412 signals over 2m 31s\./);
    expect(note).toMatch(/Deep Scan/);
    expect(note).not.toMatch(/Owlet said/); // it said nothing
    expect(convertedNote({ ...base, converted: { signals: 1, records: 5, seconds: 4, bytes: 9, said: '3 signals skipped' } })).toMatch(/1 signal over .*\nOwlet said: 3 signals skipped/);
    // nothing to say for anything that was not converted by Owlet
    expect(convertedNote({ ...base, state: 'failed' })).toBeUndefined();
    expect(convertedNote({ ...base, kind: 'wpilog', converted: { signals: 1, records: 1, seconds: 1, bytes: 1 } })).toBeUndefined();
    expect(convertedNote(base)).toBeUndefined();
  });
});
