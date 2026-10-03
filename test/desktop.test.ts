import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { copyIntoRobotFolder } = require('../desktop/robotfiles.cjs') as {
  copyIntoRobotFolder(paths: unknown, dir: string): Promise<{ copied: string[]; skipped: string[]; failed: { name: string; error: string }[] }>;
};

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
