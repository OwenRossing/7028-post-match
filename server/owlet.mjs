// Running CTRE's Owlet to turn a Phoenix .hoot log into a .wpilog.
// Owlet does the reading, and enforces CTRE's own licensing (what it will export depends on your device licences);
// this only finds it and runs it, with fixed arguments and no shell, and checks that what it wrote is the whole log.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectWPILog } from './wpilog-check.mjs';

const NAMES = process.platform === 'win32' ? ['owlet.exe', 'owlet'] : ['owlet'];

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Where Owlet is: the configured path, else a candidate path, else a folder on PATH. Null if it can't be found. */
export function resolveOwlet(configured, candidates = [], env = process.env) {
  if (configured && isFile(configured)) return configured;
  for (const c of candidates) if (c && isFile(c)) return c;
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) for (const name of NAMES) if (isFile(path.join(dir, name))) return path.join(dir, name);
  return null;
}

/** True when the file starts with the "WPILOG" marker. */
export async function isWPILogFile(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(6);
    const { bytesRead } = await fh.read(buf, 0, 6, 0);
    return bytesRead === 6 && buf.toString('latin1') === 'WPILOG';
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/** The last few lines of what a program printed (progress output uses \r to redraw one line). */
const lines = (s, n, max) => String(s ?? '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).slice(-n).join('\n').slice(-max);

/** Keeps only the end of a stream, however much is written to it: a big log makes Owlet chatty, and that must never fail it. */
class Tail {
  text = '';
  push(chunk) {
    this.text += chunk.toString('utf8');
    if (this.text.length > 32768) this.text = this.text.slice(-16384);
  }
}

const waited = (ms) => {
  const n = ms >= 90_000 ? Math.round(ms / 60_000) : Math.max(1, Math.round(ms / 1000));
  return `${n} ${ms >= 90_000 ? 'minute' : 'second'}${n === 1 ? '' : 's'}`;
};

/** How long to give Owlet: a quarter of an hour at least, and 20 seconds for every MB of hoot. A log is never cut short by a clock that was too tight. */
export const timeoutFor = (bytes) => Math.max(15 * 60 * 1000, (bytes / 1e6) * 20 * 1000);

/**
 * Converts one hoot: `owlet -f wpilog <input> <output>`. Writes to a temporary name, reads all of what came out to see
 * that it is a whole .wpilog with signals in it, and only then moves it into place. Resolves
 * { ok: true, signals, records, seconds, bytes, said } (`said` is anything Owlet printed) or { ok: false, error } with
 * Owlet's own words. Nothing partial is ever left behind as a result.
 * `signal` stops a conversion that is under way (the app is closing).
 */
export async function convertHoot({ owlet, input, output, timeoutMs, signal }) {
  await mkdir(path.dirname(output), { recursive: true });
  const tmp = output.replace(/\.wpilog$/i, '') + '.part.wpilog';
  await rm(tmp, { force: true });
  let limit = timeoutMs;
  if (limit == null) {
    try {
      limit = timeoutFor((await stat(input)).size);
    } catch {
      limit = timeoutFor(0);
    }
  }

  const run = await new Promise((resolve) => {
    const out = new Tail();
    const err = new Tail();
    let timedOut = false;
    let stopped = false;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stdout: out.text, stderr: err.text, timedOut, stopped });
    };
    let child;
    try {
      child = spawn(owlet, ['-f', 'wpilog', input, tmp], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ spawnError: String(e?.message ?? e), stdout: '', stderr: '' });
    }
    // stopping means stopping: do not wait for a child of Owlet's that still holds the pipes open
    const kill = () => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, sig: 'SIGKILL' });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limit);
    const onAbort = () => {
      stopped = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => finish({ spawnError: String(e?.message ?? e) }));
    child.on('close', (code, sig) => finish({ code, sig }));
  });

  const said = lines(run.stderr, 12, 1200) || lines(run.stdout, 12, 1200);
  const fail = async (error) => {
    await rm(tmp, { force: true });
    return { ok: false, error };
  };

  if (run.spawnError) return fail(`Owlet could not be started: ${run.spawnError}`);
  if (run.stopped) return fail('The conversion was stopped before it finished, and nothing of it was kept.');
  if (run.timedOut) {
    return fail(`Owlet was still running after ${waited(limit)} and was stopped, and nothing of it was kept.${said ? `\nOwlet said: ${lines(run.stderr || run.stdout, 6, 600)}` : ''}`);
  }
  if (run.code !== 0) {
    return fail(lines(run.stderr, 6, 600) || lines(run.stdout, 6, 600) || `Owlet stopped with ${run.sig ? `signal ${run.sig}` : `exit code ${run.code}`} and wrote no message.`);
  }

  // Owlet says it is done. Check that it wrote all of a log, not just the start of one.
  const info = await inspectWPILog(tmp);
  if (!info.ok) {
    const body = info.truncated
      ? `Owlet finished, but its .wpilog is incomplete: ${info.error} The .hoot was not fully converted.`
      : `Owlet finished, but did not write a usable .wpilog: ${info.error}`;
    return fail(said ? `${body}\nOwlet said: ${said}` : body);
  }
  if (info.entries === 0 || info.dataRecords === 0) {
    const body = 'Owlet finished, but the .wpilog it wrote has no signals in it.';
    return fail(said ? `${body}\nOwlet said: ${said}` : body);
  }

  await rm(output, { force: true });
  await rename(tmp, output);
  return { ok: true, signals: info.entries, records: info.records, seconds: info.seconds, bytes: info.bytes, said: said || undefined };
}
