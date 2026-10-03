import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { copyIntoRobotFolder } = require('../desktop/robotfiles.cjs') as {
  copyIntoRobotFolder(paths: unknown, dir: string): Promise<{ copied: string[]; skipped: string[]; failed: { name: string; error: string }[] }>;
};

const { findOwletIn, looksRunnable, owletZipIn } = require('../desktop/owletfind.cjs') as {
  findOwletIn(dir: string, o?: { depth?: number; names?: string[] }): string | null;
  looksRunnable(file: string, platform?: string): boolean;
  owletZipIn(dir: string): string | null;
};
const OWLET = process.platform === 'win32' ? 'owlet.exe' : 'owlet';

let tmp: string;
let robot: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitview-desktop-'));
  robot = path.join(tmp, 'Robot logs');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const file = (name: string, bytes: number | string = 100) => {
  const p = path.join(tmp, name);
  writeFileSync(p, typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes);
  return p;
};

describe('putting dropped robot logs in the robot-log folder', () => {
  it('copies hoots and wpilogs under their own names, leaving the originals', async () => {
    const a = file('MNST_Q22_rio_2026.hoot', 5000);
    const b = file('FRC_20260516_163821.wpilog', 300);
    const r = await copyIntoRobotFolder([a, b], robot); // the folder is made if it is not there yet
    expect(r).toEqual({ copied: ['MNST_Q22_rio_2026.hoot', 'FRC_20260516_163821.wpilog'], skipped: [], failed: [] });
    expect(readFileSync(path.join(robot, 'MNST_Q22_rio_2026.hoot')).length).toBe(5000);
    expect(existsSync(a)).toBe(true);
  });

  it('leaves nothing behind but the finished files: no half-copied file is ever visible under a log name', async () => {
    await copyIntoRobotFolder([file('a.hoot', 1_000_000)], robot);
    expect(readdirSync(robot)).toEqual(['a.hoot']);
  });

  it('does not copy what is already there, and does not overwrite a different file with the same name', async () => {
    const a = file('a.hoot', 500);
    await copyIntoRobotFolder([a], robot);
    expect(await copyIntoRobotFolder([a], robot)).toMatchObject({ copied: [], skipped: ['a.hoot'] });
    // a different recording that happens to have the same name is kept alongside, not over it
    const other = path.join(tmp, 'elsewhere');
    mkdirSync(other);
    writeFileSync(path.join(other, 'a.hoot'), Buffer.alloc(900, 1));
    expect(await copyIntoRobotFolder([path.join(other, 'a.hoot')], robot)).toMatchObject({ copied: ['a (2).hoot'] });
    expect(readFileSync(path.join(robot, 'a.hoot')).length).toBe(500);
    expect(readFileSync(path.join(robot, 'a (2).hoot')).length).toBe(900);
    // a file dropped from the folder itself is not copied onto itself
    expect(await copyIntoRobotFolder([path.join(robot, 'a.hoot')], robot)).toMatchObject({ copied: [], skipped: ['a.hoot'] });
  });

  it('refuses anything but .hoot and .wpilog, and anything that is not a file, saying why', async () => {
    const r = await copyIntoRobotFolder([file('notes.txt', 'x'), file('FRC.dslog', 10), tmp, path.join(tmp, 'missing.hoot')], robot);
    expect(r.copied).toEqual([]);
    expect(r.failed.map((f) => f.name)).toEqual(['notes.txt', 'FRC.dslog', path.basename(tmp), 'missing.hoot']);
    expect(r.failed[0].error).toMatch(/Only \.hoot and \.wpilog/);
    expect(r.failed[3].error).toMatch(/ENOENT|no such file/i);
    expect(readdirSync(robot)).toEqual([]);
  });

  it('ignores anything that is not an absolute path string', async () => {
    expect(await copyIntoRobotFolder(['relative/a.hoot', 42, null, { path: '/x/a.hoot' }], robot)).toEqual({ copied: [], skipped: [], failed: [] });
    expect(await copyIntoRobotFolder('not a list', robot)).toEqual({ copied: [], skipped: [], failed: [] });
  });

  it('puts a file only inside the folder, whatever the name looks like', async () => {
    const real = file('real.hoot', 50);
    const link = path.join(tmp, '..evil.hoot');
    symlinkSync(real, link);
    const r = await copyIntoRobotFolder([link], robot);
    expect(r.copied).toEqual(['..evil.hoot']); // a name with dots is still just a name
    expect(readdirSync(robot)).toEqual(['..evil.hoot']);
    expect(existsSync(path.join(tmp, '..evil.hoot'))).toBe(true);
  });
});

describe('the packaged desktop app', () => {
  it('includes every file its own code loads', () => {
    // A file that main.cjs requires but electron-builder does not pack crashes the installed app at launch (and only there).
    const root = path.join(__dirname, '..', 'desktop');
    const files: string[] = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).build.files;
    const packed = (name: string) => files.some((f) => f === name || (f === '*.cjs' && name.endsWith('.cjs')) || (f === '*.mjs' && name.endsWith('.mjs')));
    const loaded: string[] = [];
    for (const f of readdirSync(root).filter((n) => n.endsWith('.cjs'))) {
      const code = readFileSync(path.join(root, f), 'utf8');
      for (const m of code.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) loaded.push(m[1]);
      expect(packed(f), `${f} is not packed`).toBe(true);
    }
    expect(loaded).toContain('robotfiles.cjs');
    for (const name of loaded) expect(packed(name), `${name} is required by the app but is not packed`).toBe(true);
  });
});

describe('finding an Owlet that was just downloaded', () => {
  // On Windows the finder wants the "MZ" start of a program, so the stand-ins have it.
  const put = (rel: string, mtime?: number) => {
    const p = path.join(tmp, 'Downloads', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, 'MZ fake program');
    if (mtime) utimesSync(p, mtime, mtime);
    return p;
  };
  const dl = () => path.join(tmp, 'Downloads');

  it('finds it in Downloads, or in an unzipped folder named for it', () => {
    const loose = put(OWLET);
    expect(findOwletIn(dl())).toBe(loose);
    rmSync(loose);
    const unzipped = put(path.join('owlet-2026.1.0', 'bin', OWLET));
    expect(findOwletIn(dl())).toBe(unzipped);
  });

  it('suggests nothing that merely looks like it, or sits in an unrelated folder', () => {
    put('owlet-notes.txt');
    put('owlet.zip');
    put(`${OWLET}.crdownload`); // a download still in progress
    put(path.join('Games', 'cheats', OWLET)); // some other folder's program with the same name
    put(path.join('somebody', 'owlet-ish', 'x', 'y', 'z', 'w', 'v', OWLET)); // buried deeper than an unzipped download would be
    expect(findOwletIn(dl())).toBeNull();
    expect(findOwletIn(path.join(tmp, 'no-such-folder'))).toBeNull();
  });

  it('takes the most recent one when there are two, and reads a depth limit', () => {
    put(path.join('owlet-old', OWLET), 1_600_000_000);
    const newer = put(path.join('owlet-new', OWLET), 1_700_000_000);
    expect(findOwletIn(dl())).toBe(newer);
    expect(findOwletIn(dl(), { depth: 0 })).toBe(newer); // still one folder in: depth counts below that
    put(path.join('owlet-deep', 'a', 'b', OWLET), 1_800_000_000);
    expect(findOwletIn(dl(), { depth: 1 })).toBe(newer); // the deeper, newer one is out of reach
    expect(findOwletIn(dl(), { depth: 2 })).toBe(path.join(dl(), 'owlet-deep', 'a', 'b', OWLET));
  });

  it('only suggests something that starts like a program on Windows', () => {
    const p = path.join(tmp, 'x.exe');
    writeFileSync(p, 'MZ....');
    expect(looksRunnable(p, 'win32')).toBe(true);
    writeFileSync(p, '<html>not a program</html>');
    expect(looksRunnable(p, 'win32')).toBe(false);
    expect(looksRunnable(path.join(tmp, 'missing.exe'), 'win32')).toBe(false);
    expect(looksRunnable(p, 'linux')).toBe(true);
  });

  it('says when the download is there but still zipped', () => {
    expect(owletZipIn(dl())).toBeNull();
    put('Owlet_1.0.zip');
    put('holiday.zip');
    expect(owletZipIn(dl())).toBe('Owlet_1.0.zip');
  });
});
