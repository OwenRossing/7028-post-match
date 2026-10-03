// The robot-log folder: where .wpilog and .hoot files from the roboRIO are copied to (a USB stick's contents, or
// whatever you pulled off over the network). Native .wpilog files are served as they are; each .hoot is run through
// Owlet in the background and the converted .wpilog is served in its place.

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { convertHoot, resolveOwlet } from './owlet.mjs';
import { inspectWPILog } from './wpilog-check.mjs';

const ROBOT_RE = /\.(wpilog|hoot)$/i;

export const robotFileRe = ROBOT_RE;

async function list(dir, depth = 3, prefix = '') {
  const out = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (depth > 0 && !item.name.startsWith('.')) out.push(...(await list(full, depth - 1, rel)));
    } else if (ROBOT_RE.test(item.name)) {
      try {
        const s = await stat(full);
        out.push({ name: item.name, path: rel, full, size: s.size, mtime: Math.round(s.mtimeMs) });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

const idOf = (f) => createHash('sha1').update(`${f.path}|${f.size}|${f.mtime}`).digest('hex').slice(0, 12);

export class RobotFolder {
  /**
   * @param {{ dir?: string, convertDir: string, owlet?: string|null, owletCandidates?: string[], onChange?: () => void, convert?: typeof convertHoot }} o
   */
  constructor(o) {
    this.dir = o.dir ?? null;
    this.convertDir = o.convertDir;
    this.configured = o.owlet ?? null;
    this.candidates = o.owletCandidates ?? [];
    this.onChange = o.onChange ?? (() => {});
    this.convert = o.convert ?? convertHoot;
    this.items = [];
    this.seen = new Map(); // id -> consecutive scans it has been seen unchanged
    this.failed = new Map(); // id -> error text
    this.done = new Map(); // id -> what a finished conversion was checked to hold: { signals, records, seconds, bytes, said }
    this.abort = null; // stops the conversion under way
    this.converting = null; // id being converted
    this.queue = [];
    this.timer = null;
    this.lastSig = '';
    this.running = null;
    this.again = false;
  }

  owletPath() {
    return resolveOwlet(this.configured, this.candidates);
  }

  /** Changes folders or the Owlet path. A new Owlet gets another go at everything that failed. */
  configure(o) {
    if (o.dir !== undefined) this.dir = o.dir;
    if (o.owlet !== undefined) {
      this.configured = o.owlet;
      this.failed.clear();
    }
    void this.scan();
  }

  retry() {
    this.failed.clear();
    void this.scan();
  }

  start(intervalMs = 2000) {
    this.stop();
    this.timer = setInterval(() => void this.scan(), intervalMs);
    void this.scan();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops watching and stops a conversion that is under way (nothing of it is kept). */
  shutdown() {
    this.stop();
    this.abort?.abort();
  }

  outFor(f) {
    return path.join(this.convertDir, `${f.id}-${f.name.replace(/\.hoot$/i, '')}.wpilog`);
  }

  /** Looks at the folder. A request made while a look is under way triggers one more afterwards, and resolves when that is done. */
  scan() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.scanOnce();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async scanOnce() {
    const found = this.dir && existsSync(this.dir) ? (await list(this.dir)).map((f) => ({ ...f, id: idOf(f) })) : [];
    const owlet = this.owletPath();
    const next = [];
    const nowSeen = new Map();
    for (const f of found) {
      const kind = /\.hoot$/i.test(f.name) ? 'hoot' : 'wpilog';
      const base = { id: f.id, name: f.name, path: f.path, kind, size: f.size, mtime: f.mtime };
      nowSeen.set(f.id, (this.seen.get(f.id) ?? 0) + 1);
      if (kind === 'wpilog') {
        next.push({ ...base, state: 'ready', full: f.full });
        continue;
      }
      const out = this.outFor(f);
      const converted = await this.verified(f.id, out);
      if (converted) next.push({ ...base, state: 'ready', full: out, source: f.full, converted });
      else if (this.failed.has(f.id)) next.push({ ...base, state: 'failed', error: this.failed.get(f.id), source: f.full });
      else if (!owlet) next.push({ ...base, state: 'needs-owlet', source: f.full });
      else {
        const busy = this.converting === f.id;
        // wait until the file has stopped changing (it may still be copying) before converting
        if (!busy && !this.queue.includes(f.id) && (nowSeen.get(f.id) ?? 0) >= 2) this.queue.push(f.id);
        next.push({ ...base, state: busy ? 'converting' : 'queued', source: f.full });
      }
    }
    this.seen = nowSeen;
    for (const id of [...this.done.keys()]) if (!nowSeen.has(id)) this.done.delete(id);
    this.items = next;
    this.queue = this.queue.filter((id) => next.some((i) => i.id === id));
    void this.drain();
    await this.prune(next);
    this.changed();
  }

  async drain() {
    if (this.converting || !this.queue.length) return;
    const id = this.queue.shift();
    const item = this.items.find((i) => i.id === id);
    const owlet = this.owletPath();
    if (!item || !owlet) return void this.drain();
    this.converting = id;
    item.state = 'converting';
    this.changed();
    this.abort = new AbortController();
    let result;
    try {
      result = await this.convert({ owlet, input: item.source, output: this.outFor({ id, name: item.name }), signal: this.abort.signal });
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    this.abort = null;
    this.converting = null;
    if (result.ok) {
      const done = { signals: result.signals ?? 0, records: result.records ?? 0, seconds: result.seconds ?? 0, bytes: result.bytes ?? 0, said: result.said };
      this.done.set(id, done);
      await this.remember(this.outFor({ id, name: item.name }), done);
    } else this.failed.set(id, result.error);
    await this.scan();
    void this.drain();
  }

  /**
   * What is known about the converted file of a hoot, or null when there is none worth serving. A file found on disk
   * that this run did not write is read through once first: only a whole .wpilog with signals in it is ever served.
   */
  async verified(id, out) {
    if (!existsSync(out) || statSync(out).size === 0) return null;
    const known = this.done.get(id) ?? (await this.recall(out));
    if (known) {
      this.done.set(id, known);
      return known;
    }
    const r = await inspectWPILog(out);
    if (!r.ok || r.entries === 0 || r.dataRecords === 0) {
      await rm(out, { force: true });
      await rm(`${out}.json`, { force: true });
      return null;
    }
    const done = { signals: r.entries, records: r.records, seconds: r.seconds, bytes: r.bytes };
    this.done.set(id, done);
    await this.remember(out, done);
    return done;
  }

  /**
   * A small note next to a converted file saying it was read through, whole, at this size and time: so the next launch
   * need not read hundreds of MB again, while a file that has changed since (cut short, replaced) is read again.
   */
  async remember(out, done) {
    try {
      const s = await stat(out);
      await writeFile(`${out}.json`, JSON.stringify({ size: s.size, mtimeMs: Math.round(s.mtimeMs), done }));
    } catch {
      /* not worth failing for: it will just be read again next time */
    }
  }

  async recall(out) {
    try {
      const note = JSON.parse(await readFile(`${out}.json`, 'utf8'));
      const s = await stat(out);
      return note.size === s.size && note.mtimeMs === Math.round(s.mtimeMs) && note.done?.signals > 0 ? note.done : null;
    } catch {
      return null;
    }
  }

  /** Deletes converted files that no .hoot in the folder refers to any more, and leftovers of an interrupted conversion. */
  async prune(items) {
    if (!existsSync(this.convertDir)) return;
    const keep = new Set(items.filter((i) => i.kind === 'hoot').map((i) => i.id));
    try {
      for (const f of await readdir(this.convertDir)) {
        const id = f.split('-')[0];
        const leftover = f.endsWith('.part.wpilog') && !this.converting;
        const orphan = !f.endsWith('.part.wpilog') && /^[0-9a-f]{12}$/.test(id) && !keep.has(id) && this.converting !== id;
        if (leftover || orphan) await rm(path.join(this.convertDir, f), { force: true });
      }
    } catch {
      /* the folder is not ours to worry about */
    }
  }

  changed() {
    const sig = this.items.map((i) => `${i.id}:${i.state}`).join('|') + `#${this.owletPath() ?? ''}#${this.dir ?? ''}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.onChange();
    }
  }

  snapshot() {
    const owlet = this.owletPath();
    return {
      dir: this.dir,
      owlet: { path: owlet, configured: this.configured, found: !!owlet },
      items: this.items.map(({ full, source, ...rest }) => rest),
    };
  }

  /** The file to serve for an item: the converted .wpilog (or the .wpilog itself), or with `source` the original. Only ids from the current listing. */
  fileFor(id, which = 'default') {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    if (which === 'source') return item.source ?? item.full;
    return item.state === 'ready' ? item.full : null;
  }
}

