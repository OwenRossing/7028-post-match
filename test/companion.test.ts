import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCompanion, type CompanionHandle } from '../server/companion.mjs';
import { convertHoot, resolveOwlet, timeoutFor } from '../server/owlet.mjs';
import { RobotFolder } from '../server/robot.mjs';
import { inspectWPILog } from '../server/wpilog-check.mjs';
import { WPILogWriter } from './helpers/wpilog-writer';

// The stand-ins for Owlet are shell scripts.
const posix = process.platform !== 'win32';
const d = describe.skipIf(!posix);

let tmp: string;
const handles: CompanionHandle[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitview-test-'));
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  rmSync(tmp, { recursive: true, force: true });
});

const dir = (name: string) => {
  const p = path.join(tmp, name);
  mkdirSync(p, { recursive: true });
  return p;
};

/** A small robot log, the kind of thing Owlet would produce from a hoot. */
function fixtureWpilog(file: string) {
  const w = new WPILogWriter();
  const a = w.start('Phoenix6/TalonFX-1/Position', 'double', 0, '{"unit":"rotations"}');
  for (let t = 0; t < 5; t++) w.double(a, t, t);
  writeFileSync(file, w.bytes());
}

/** A stand-in for `owlet -f wpilog IN OUT` that writes a fixed log. */
function stubOwlet(name = 'owlet') {
  const fixture = path.join(tmp, `${name}-fixture.wpilog`);
  fixtureWpilog(fixture);
  const script = path.join(tmp, name);
  writeFileSync(script, `#!/bin/sh\n[ "$1" = "-f" ] && [ "$2" = "wpilog" ] || { echo "unexpected arguments: $*" >&2; exit 2; }\ncp '${fixture}' "$4"\n`);
  chmodSync(script, 0o755);
  return script;
}

function failingOwlet(message: string) {
  const script = path.join(tmp, 'owlet-fail');
  writeFileSync(script, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`);
  chmodSync(script, 0o755);
  return script;
}

const hoot = (file: string, n = 5000) => writeFileSync(file, Buffer.from(Array.from({ length: n }, (_, i) => (i * 31) & 255)));

async function start(o: Parameters<typeof startCompanion>[0] = {}) {
  const h = await startCompanion({ port: 0, convertDir: path.join(tmp, 'converted'), ...o });
  handles.push(h);
  return h;
}

const get = async (h: CompanionHandle, p: string, init?: RequestInit) => fetch(`${h.url}${p}`, init);

async function scans(h: CompanionHandle, n = 3) {
  for (let i = 0; i < n; i++) await h.robot.scan();
}

async function until(fn: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
}

const state = (h: CompanionHandle, name: string) => h.robot.snapshot().items.find((i) => i.name === name)?.state;

d('robot folder with Owlet', () => {
  it('serves native .wpilog files straight away and converts .hoot files in the background', async () => {
    const robot = dir('robot');
    fixtureWpilog(path.join(robot, 'FRC_20260516_163821.wpilog'));
    hoot(path.join(robot, 'rio_2026.hoot'));
    const h = await start({ robotDir: robot, owlet: stubOwlet() });

    await h.robot.scan();
    expect(state(h, 'FRC_20260516_163821.wpilog')).toBe('ready');
    expect(state(h, 'rio_2026.hoot')).not.toBe('ready'); // not yet: waits to be sure the file has stopped changing

    await scans(h);
    await until(() => state(h, 'rio_2026.hoot') === 'ready');

    const listing = await (await get(h, '/api/robot')).json();
    expect(listing.items.map((i: { name: string; kind: string; state: string }) => [i.name, i.kind, i.state]).sort()).toEqual([
      ['FRC_20260516_163821.wpilog', 'wpilog', 'ready'],
      ['rio_2026.hoot', 'hoot', 'ready'],
    ]);
    expect(listing.owlet.found).toBe(true);
    expect(JSON.stringify(listing.items)).not.toContain(robot); // items name files relative to the folder, never by full path
    expect(listing.convertDir).toBeUndefined(); // the conversion cache is nobody's business

    const id = listing.items.find((i: { kind: string }) => i.kind === 'hoot').id;
    const converted = Buffer.from(await (await get(h, `/api/robot/file?id=${id}`)).arrayBuffer());
    expect(converted.subarray(0, 6).toString('latin1')).toBe('WPILOG'); // the converted log is what is served
    const original = Buffer.from(await (await get(h, `/api/robot/file?id=${id}&which=source`)).arrayBuffer());
    expect(original.equals(readFileSync(path.join(robot, 'rio_2026.hoot')))).toBe(true);
  });

  it('says what is needed when Owlet is not there, and converts once it is', async () => {
    const robot = dir('robot');
    hoot(path.join(robot, 'a.hoot'));
    const h = await start({ robotDir: robot, owlet: path.join(tmp, 'does-not-exist') });
    await scans(h);
    expect(state(h, 'a.hoot')).toBe('needs-owlet');
    expect(h.robot.snapshot().owlet.found).toBe(false);

    h.configure({ owlet: stubOwlet() });
    await until(async () => {
      await h.robot.scan();
      return state(h, 'a.hoot') === 'ready';
    });
  });

  it("reports Owlet's own words when it fails, and tries again with a new Owlet", async () => {
    const robot = dir('robot');
    hoot(path.join(robot, 'a.hoot'));
    const h = await start({ robotDir: robot, owlet: failingOwlet('Device 5 is not licensed for export') });
    await scans(h);
    await until(() => state(h, 'a.hoot') === 'failed');
    const item = h.robot.snapshot().items[0];
    expect(item.error).toContain('not licensed for export');

    // it does not keep retrying the same failure...
    await scans(h, 3);
    expect(state(h, 'a.hoot')).toBe('failed');
    // ...until Owlet changes
    h.configure({ owlet: stubOwlet() });
    await until(async () => {
      await h.robot.scan();
      return state(h, 'a.hoot') === 'ready';
    });
  });

  it('does not convert a file that is still being copied', async () => {
    const robot = dir('robot');
    const file = path.join(robot, 'copying.hoot');
    hoot(file, 1000);
    const h = await start({ robotDir: robot, owlet: stubOwlet() });
    await h.robot.scan();
    hoot(file, 2000); // it grew: a different version of the file
    await h.robot.scan();
    hoot(file, 3000);
    await h.robot.scan();
    expect(state(h, 'copying.hoot')).toBe('queued');
    await scans(h, 2); // now it has stood still for two looks
    await until(() => state(h, 'copying.hoot') === 'ready');
  });

  it('finds logs in subfolders (a USB stick copied across) and cleans up conversions of deleted hoots', async () => {
    const robot = dir('robot');
    const sub = path.join(robot, 'logs', 'day1');
    mkdirSync(sub, { recursive: true });
    hoot(path.join(sub, 'a.hoot'));
    const h = await start({ robotDir: robot, owlet: stubOwlet() });
    await scans(h);
    await until(() => state(h, 'a.hoot') === 'ready');
    expect(readdirSync(path.join(tmp, 'converted')).filter((f) => f.endsWith('.wpilog'))).toHaveLength(1);

    rmSync(path.join(sub, 'a.hoot'));
    await h.robot.scan();
    expect(h.robot.snapshot().items).toEqual([]);
    expect(readdirSync(path.join(tmp, 'converted'))).toEqual([]);
  });
});

d('the server', () => {
  it('lists Driver Station logs as before', async () => {
    const ds = dir('ds');
    copyFileSync(new URL('../public/sample/2026_05_16%2011_38_21%20Sat.dslog', import.meta.url), path.join(ds, 'a.dslog'));
    writeFileSync(path.join(ds, 'ignored.txt'), 'x');
    const h = await start({ dir: ds });
    const logs = await (await get(h, '/api/logs')).json();
    expect(logs.map((l: { name: string }) => l.name)).toEqual(['a.dslog']);
    const body = await get(h, '/api/file?path=a.dslog');
    expect(Number(body.headers.get('content-length'))).toBe(statSync(path.join(ds, 'a.dslog')).size);
    const info = await (await get(h, '/api/info')).json();
    expect(info).toMatchObject({ name: 'pitview-companion', robot: true, desktop: false });
  });

  it('never serves a file the client names, only items it listed', async () => {
    const ds = dir('ds');
    const robot = dir('robot');
    writeFileSync(path.join(tmp, 'secret.wpilog'), 'secret');
    fixtureWpilog(path.join(robot, 'a.wpilog'));
    const h = await start({ dir: ds, robotDir: robot });
    await h.robot.scan();
    for (const bad of ['../secret.wpilog', '/etc/passwd', '..%2Fsecret.wpilog', '', 'a.wpilog', 'deadbeef0000'])
      expect((await get(h, `/api/robot/file?id=${encodeURIComponent(bad)}`)).status).toBe(404);
    for (const bad of ['../secret.wpilog', '/etc/passwd', 'secret.txt', '..\\..\\x.dslog'])
      expect((await get(h, `/api/file?path=${encodeURIComponent(bad)}`)).status).toBe(404);
  });

  it('cannot be told to run a program over HTTP', async () => {
    const h = await start({ robotDir: dir('robot') });
    for (const method of ['POST', 'PUT', 'DELETE'])
      for (const p of ['/api/owlet', '/api/robot', '/api/robot/owlet', '/api/configure'])
        expect((await get(h, p, { method, body: JSON.stringify({ path: '/bin/sh' }) })).status).toBe(405);
    expect(h.robot.snapshot().owlet.configured).toBeNull();
  });

  it('lets other websites read the API only when asked to', async () => {
    const open = await start();
    expect((await get(open, '/api/info')).headers.get('access-control-allow-origin')).toBe('*');
    const closed = await start({ cors: false });
    expect((await get(closed, '/api/info')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('listens only on this computer unless told otherwise', async () => {
    const h = await start();
    const addr = h.server.address() as { address: string };
    expect(addr.address).toBe('127.0.0.1');
  });

  it('serves the built app and falls back to index.html', async () => {
    const dist = dir('dist');
    writeFileSync(path.join(dist, 'index.html'), '<title>app</title>');
    const h = await start({ dist });
    expect(await (await get(h, '/')).text()).toContain('<title>app</title>');
    expect(await (await get(h, '/some/route')).text()).toContain('<title>app</title>');
    expect((await get(h, '/..%2f..%2fetc/passwd')).status).not.toBe(200);
  });

  it('tells the app when the robot folder changes (so it refreshes)', async () => {
    const robot = dir('robot');
    const h = await start({ robotDir: robot });
    const res = await get(h, '/api/watch');
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    fixtureWpilog(path.join(robot, 'new.wpilog'));
    await h.robot.scan();
    const got = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no event')), 3000))]);
    expect(new TextDecoder().decode(got.value)).toContain('event: change');
    await reader.cancel();
  });
});

d('Owlet runner', () => {
  it('finds Owlet: the configured path first, then candidates, then PATH', () => {
    const a = stubOwlet('first');
    const b = stubOwlet('second');
    expect(resolveOwlet(a, [b])).toBe(a);
    expect(resolveOwlet(path.join(tmp, 'missing'), [b])).toBe(b);
    expect(resolveOwlet(null, [path.join(tmp, 'missing')], { PATH: tmp })).toBeNull(); // nothing called owlet in PATH
    stubOwlet('owlet');
    expect(resolveOwlet(null, [], { PATH: `/nonexistent${path.delimiter}${tmp}` })).toBe(path.join(tmp, 'owlet'));
  });

  it('refuses output that is not a .wpilog, and gives up when it takes too long', async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const junk = path.join(tmp, 'junk');
    writeFileSync(junk, '#!/bin/sh\necho not a log > "$4"\n');
    chmodSync(junk, 0o755);
    const r = await convertHoot({ owlet: junk, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/did not write a usable \.wpilog.*does not start with "WPILOG"/);
    expect(existsSync(path.join(tmp, 'out', 'a.wpilog'))).toBe(false);
    expect(readdirSync(path.join(tmp, 'out'))).toEqual([]); // no half-written file left behind

    const slow = path.join(tmp, 'slow');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    const t = await convertHoot({ owlet: slow, input, output: path.join(tmp, 'out', 'b.wpilog'), timeoutMs: 200 });
    expect(t).toEqual({ ok: false, error: 'Owlet was still running after 1 second and was stopped, and nothing of it was kept.' });
    expect(readdirSync(path.join(tmp, 'out'))).toEqual([]);
  });

  it('passes exactly the documented arguments', async () => {
    const input = path.join(tmp, 'it has spaces.hoot'); // spaces must survive: no shell is involved
    hoot(input);
    const r = await convertHoot({ owlet: stubOwlet(), input, output: path.join(tmp, 'out', 'x.wpilog') });
    expect(r).toMatchObject({ ok: true, signals: 1 });
    expect(readFileSync(path.join(tmp, 'out', 'x.wpilog')).subarray(0, 6).toString('latin1')).toBe('WPILOG');
  });
});

/** A script standing in for Owlet. `body` is shell, with the fixture at $FIXTURE and the output path at $4. */
function owletScript(name: string, body: string) {
  const fixture = path.join(tmp, 'fixture.wpilog');
  if (!existsSync(fixture)) fixtureWpilog(fixture);
  const script = path.join(tmp, name);
  writeFileSync(script, `#!/bin/sh\nFIXTURE='${fixture}'\n${body}\n`);
  chmodSync(script, 0o755);
  return script;
}

/** A log of `n` records over `n` seconds, in a file; enough of them to cross the checker's read size. */
function bigWpilog(file: string, n: number) {
  const w = new WPILogWriter();
  const a = w.start('Phoenix6/TalonFX-1/Position', 'double', 0);
  const b = w.start('Phoenix6/TalonFX-1/Velocity', 'double', 0);
  for (let t = 0; t < n; t++) {
    w.double(a, t / 1000, t);
    w.double(b, t / 1000, -t);
  }
  writeFileSync(file, w.bytes());
}

describe('the whole hoot is converted, or nothing is kept', () => {
  it('reads a log to its very end, however it falls across reads, and counts what is in it', async () => {
    const file = path.join(tmp, 'big.wpilog');
    bigWpilog(file, 250_000); // about 8 MB: more than one read
    expect(statSync(file).size).toBeGreaterThan(4 * 1024 * 1024 * 1.5);
    const r = await inspectWPILog(file);
    expect(r).toMatchObject({ ok: true, entries: 2, records: 2 + 500_000, dataRecords: 500_000 });
    expect((r as { seconds: number }).seconds).toBeCloseTo(249.999, 3);
  });

  it('notices a log that stops anywhere short of its end', async () => {
    const small = path.join(tmp, 'small.wpilog');
    bigWpilog(small, 40);
    const whole = readFileSync(small);
    expect(await inspectWPILog(small)).toMatchObject({ ok: true, dataRecords: 80 });
    // every cut: inside the header, between records and in the middle of them, never reported as complete unless it falls exactly between records
    let complete = 0;
    for (let n = 1; n < whole.length; n++) {
      const cut = path.join(tmp, 'cut.wpilog');
      writeFileSync(cut, whole.subarray(0, n));
      const r = await inspectWPILog(cut);
      if (r.ok) complete++;
      else expect(r.error).toBeTruthy();
    }
    // cuts that land on a record boundary are not detectable from the file alone (the shortened log is still valid); every other cut is
    expect(complete).toBeLessThan(whole.length / 4);
    const mid = path.join(tmp, 'mid.wpilog');
    writeFileSync(mid, whole.subarray(0, whole.length - 3));
    expect(await inspectWPILog(mid)).toMatchObject({ ok: false, truncated: true });
  });

  it('refuses a conversion that was cut off, and keeps nothing', async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const cut = owletScript('owlet-cut', 'head -c $(( $(wc -c < "$FIXTURE") - 3 )) "$FIXTURE" > "$4"');
    const r = await convertHoot({ owlet: cut, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/incomplete.*stops in the middle of a record.*not fully converted/s);
    expect(readdirSync(path.join(tmp, 'out'))).toEqual([]);
  });

  it('refuses a conversion with no signals in it', async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const header = path.join(tmp, 'header-only.wpilog');
    writeFileSync(header, new WPILogWriter().bytes());
    const empty = owletScript('owlet-empty', `echo "0 of 41 signals are licensed" >&2\ncp '${header}' "$4"`);
    const r = await convertHoot({ owlet: empty, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/no signals in it\.\nOwlet said: 0 of 41 signals are licensed/);
    expect(readdirSync(path.join(tmp, 'out'))).toEqual([]);
  });

  it('is not failed by a hoot that makes Owlet very chatty', async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    // 20 MB on each stream, far over the 8 MB a buffered run would have allowed
    const chatty = owletScript('owlet-chatty', 'yes "converting... 45%" | head -c 20000000\nyes "warning: a line" | head -c 20000000 >&2\ncp "$FIXTURE" "$4"');
    const r = await convertHoot({ owlet: chatty, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: true, signals: 1 });
    expect((r as { said?: string }).said).toContain('warning: a line');
    expect((r as { said?: string }).said!.length).toBeLessThan(1300); // only the end of it is kept
  });

  it("passes on what Owlet printed, and what it checked: signals and time covered", async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const warns = owletScript('owlet-warns', 'echo "3 signals skipped (not licensed)" >&2\ncp "$FIXTURE" "$4"');
    const r = await convertHoot({ owlet: warns, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: true, signals: 1, records: 6, seconds: 4, said: '3 signals skipped (not licensed)' });
    expect((r as { bytes: number }).bytes).toBe(statSync(path.join(tmp, 'out', 'a.wpilog')).size);
  });

  it('gives a big hoot as long as it needs, and can be stopped when the app closes', async () => {
    expect(timeoutFor(0)).toBe(15 * 60 * 1000);
    expect(timeoutFor(80e6)).toBe(80 * 20 * 1000); // 80 MB: 26 minutes
    expect(timeoutFor(1e9)).toBeGreaterThan(timeoutFor(80e6));

    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const slow = owletScript('owlet-slow', 'sleep 5');
    const stop = new AbortController();
    const running = convertHoot({ owlet: slow, input, output: path.join(tmp, 'out', 'a.wpilog'), signal: stop.signal });
    setTimeout(() => stop.abort(), 150);
    const r = await running;
    expect(r).toEqual({ ok: false, error: 'The conversion was stopped before it finished, and nothing of it was kept.' });
    expect(readdirSync(path.join(tmp, 'out'))).toEqual([]);
  });

  it("says plainly when Owlet can't be started", async () => {
    const input = path.join(tmp, 'a.hoot');
    hoot(input);
    const noExec = path.join(tmp, 'not-executable');
    writeFileSync(noExec, '#!/bin/sh\n');
    chmodSync(noExec, 0o644);
    const r = await convertHoot({ owlet: noExec, input, output: path.join(tmp, 'out', 'a.wpilog') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/^Owlet could not be started: /);
  });

  it('serves a converted hoot with what was checked, and never serves a cut-off file left on disk', async () => {
    const robot = dir('robot');
    const converted = dir('converted');
    hoot(path.join(robot, 'a.hoot'));
    const folder = new RobotFolder({ dir: robot, convertDir: converted, owlet: path.join(tmp, 'nothing-here') });
    for (let i = 0; i < 3; i++) await folder.scan();
    const id = folder.snapshot().items[0].id;
    expect(folder.snapshot().items[0].state).toBe('needs-owlet');

    // a half-written conversion from an earlier run, under the name the real one would have
    const left = path.join(converted, `${id}-a.wpilog`);
    const whole = path.join(tmp, 'whole.wpilog');
    fixtureWpilog(whole);
    writeFileSync(left, readFileSync(whole).subarray(0, readFileSync(whole).length - 5));
    await folder.scan();
    expect(folder.snapshot().items[0].state).toBe('needs-owlet'); // not served as ready
    expect(existsSync(left)).toBe(false); // and gone, so it is made again

    // with Owlet, it is made again, whole, and the numbers come with it
    folder.configure({ owlet: stubOwlet() });
    await until(() => folder.snapshot().items[0]?.state === 'ready');
    expect(folder.snapshot().items[0].converted).toMatchObject({ signals: 1, seconds: 4 });

    // a good file found on disk by a new run is checked once and served with the same numbers
    folder.shutdown();
    const again = new RobotFolder({ dir: robot, convertDir: converted, owlet: path.join(tmp, 'nothing-here') });
    await again.scan();
    expect(again.snapshot().items[0]).toMatchObject({ state: 'ready', converted: { signals: 1, seconds: 4 } });
    again.shutdown();

    // the note that says so sits next to the file; if the file changes after that, it no longer counts
    const out = path.join(converted, readdirSync(converted).find((f) => f.endsWith('.wpilog'))!);
    expect(existsSync(`${out}.json`)).toBe(true);
    writeFileSync(out, readFileSync(out).subarray(0, readFileSync(out).length - 5));
    const cut = new RobotFolder({ dir: robot, convertDir: converted, owlet: path.join(tmp, 'nothing-here') });
    await cut.scan();
    expect(cut.snapshot().items[0].state).toBe('needs-owlet');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.json`)).toBe(false);
    cut.shutdown();
  });
});
