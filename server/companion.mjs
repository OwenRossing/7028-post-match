#!/usr/bin/env node
// PitView companion server, and the engine of the desktop app.
//
// Runs on the Driver Station laptop, serves the built PitView app, and exposes the DS log folder and a robot-log
// folder (read-only) so the app can list, download and live-watch logs. Hoot logs in the robot-log folder are run
// through CTRE's Owlet in the background and served as .wpilog. Useful when:
//   - you want the pit crew to open the latest match from another laptop/tablet on the same network (--lan)
//   - the browser can't use folder access (Firefox/Safari)
//   - you want .hoot logs converted for you (--robot-dir and --owlet)
//
// Usage: node server/companion.mjs [--dir "C:\Users\Public\Documents\FRC\Log Files"] [--port 5801] [--lan]
//                                  [--robot-dir <folder>] [--owlet <path to owlet>] [--convert-dir <folder>]
// No dependencies. Only .dslog/.dsevents files in --dir and .wpilog/.hoot files in --robot-dir are ever served,
// and the only program it ever runs is the Owlet you point it at, with fixed arguments.

import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RobotFolder } from './robot.mjs';

export const VERSION = '1.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(here, '..', 'dist');
const LOG_RE = /\.(dslog|dsevents)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const defaultDsDir = () =>
  process.platform === 'win32' ? 'C:\\Users\\Public\\Documents\\FRC\\Log Files' : path.join(os.homedir(), 'FRC', 'Log Files');

async function listLogs(dir, depth = 3, prefix = '') {
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
      if (depth > 0) out.push(...(await listLogs(full, depth - 1, rel)));
    } else if (LOG_RE.test(item.name)) {
      try {
        const s = await stat(full);
        out.push({ name: item.name, path: rel, size: s.size, mtime: Math.round(s.mtimeMs) });
      } catch {
        /* file vanished */
      }
    }
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res, full) {
  const s = statSync(full);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store' });
  createReadStream(full).pipe(res);
}

/**
 * Starts the server and returns a handle. Options:
 *   dir          Driver Station log folder
 *   robotDir     folder the robot's .wpilog / .hoot files are copied to
 *   owlet        path to Owlet (else owletCandidates, else PATH)
 *   owletCandidates  other places to look for Owlet
 *   convertDir   where converted .wpilog files are kept
 *   dist         the built app to serve
 *   port         0 picks a free one
 *   lan          listen on every interface instead of only this computer
 *   cors         let other websites read the API (the command line does; the desktop app does not)
 *   desktop      says the desktop app is running this
 */
export async function startCompanion(o = {}) {
  const state = { dir: o.dir ?? defaultDsDir() };
  const dist = o.dist ?? DEFAULT_DIST;
  const cors = o.cors !== false;
  const host = o.lan ? '0.0.0.0' : '127.0.0.1';

  // ---- Change notifications (Server-Sent Events) ----
  const clients = new Set();
  let notifyTimer = null;
  const notify = () => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      for (const res of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`);
    }, 250);
  };

  const robot = new RobotFolder({
    dir: o.robotDir ?? null,
    convertDir: o.convertDir ?? path.join(os.tmpdir(), 'pitview-converted'),
    owlet: o.owlet ?? null,
    owletCandidates: o.owletCandidates ?? [],
    onChange: notify,
  });

  let lastSig = '';
  const pollDs = async () => {
    const sig = (await listLogs(state.dir)).map((f) => `${f.path}:${f.size}:${f.mtime}`).sort().join('|');
    if (lastSig && sig !== lastSig) notify();
    lastSig = sig;
  };
  let watcher = null;
  const armWatch = () => {
    watcher?.close();
    watcher = null;
    if (!existsSync(state.dir)) return;
    try {
      watcher = watch(state.dir, { recursive: true }, (_evt, name) => {
        if (!name || LOG_RE.test(String(name))) notify();
      });
      watcher.on('error', () => undefined);
    } catch {
      /* recursive watch unsupported: polling still works */
    }
  };
  armWatch();
  const poll = setInterval(() => void pollDs(), 2000);
  void pollDs();
  robot.start();

  /** Resolves a client supplied relative path, refusing anything outside the DS folder or not a log file. */
  function safeLogPath(rel) {
    if (typeof rel !== 'string' || !LOG_RE.test(rel)) return null;
    const full = path.resolve(state.dir, rel);
    const relative = path.relative(state.dir, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return full;
  }

  function serveStatic(res, pathname) {
    if (!existsSync(dist)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>PitView companion</title><body style="font-family:system-ui;padding:32px;max-width:640px">` +
          `<h1>PitView companion is running</h1><p>The app hasn't been built yet. Run <code>npm run build</code> in the project folder, then reload.</p>` +
          `<p>Serving logs from <code>${state.dir.replace(/</g, '&lt;')}</code>.</p></body>`,
      );
      return;
    }
    let file = path.resolve(dist, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(path.resolve(dist))) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // a missing file (a script, an image) is a 404; only page routes fall back to the app
      if (path.extname(pathname)) {
        res.writeHead(404).end();
        return;
      }
      file = path.join(dist, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      // Lets an https:// hosted PitView reach this server on localhost (Chrome Private Network Access).
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    try {
      switch (url.pathname) {
        case '/api/info':
          return sendJson(res, 200, {
            name: 'pitview-companion',
            version: VERSION,
            dir: state.dir,
            exists: existsSync(state.dir),
            robot: true,
            desktop: !!o.desktop,
          });
        case '/api/logs':
          return sendJson(res, 200, await listLogs(state.dir));
        case '/api/file': {
          const full = safeLogPath(url.searchParams.get('path'));
          if (!full || !existsSync(full)) return sendJson(res, 404, { error: 'Not found' });
          return sendFile(res, full);
        }
        case '/api/robot':
          return sendJson(res, 200, robot.snapshot());
        case '/api/robot/file': {
          // by id from the current listing only: a client never names a path
          const full = robot.fileFor(String(url.searchParams.get('id') ?? ''), url.searchParams.get('which') === 'source' ? 'source' : 'default');
          if (!full || !existsSync(full)) return sendJson(res, 404, { error: 'Not found' });
          return sendFile(res, full);
        }
        case '/api/watch': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 15000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        default:
          return serveStatic(res, url.pathname);
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, resolve);
  });
  const port = server.address().port;

  return {
    port,
    url: `http://localhost:${port}`,
    server,
    robot,
    /** Changes folders or the Owlet path while running. */
    configure(c) {
      if (c.dir !== undefined) {
        state.dir = c.dir;
        lastSig = '';
        armWatch();
        notify();
      }
      robot.configure({ dir: c.robotDir, owlet: c.owlet });
    },
    async close() {
      clearInterval(poll);
      clearTimeout(notifyTimer);
      robot.shutdown();
      watcher?.close();
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---- Command line ----
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const dir = path.resolve(String(arg('dir', process.env.PITVIEW_LOG_DIR ?? defaultDsDir())));
  const robotArg = arg('robot-dir', process.env.PITVIEW_ROBOT_DIR ?? null);
  const robotDir = robotArg && robotArg !== true ? path.resolve(String(robotArg)) : null;
  const owlet = arg('owlet', process.env.PITVIEW_OWLET ?? null);
  const lan = arg('lan', false) === true;
  const convertDir = arg('convert-dir', undefined);
  const handle = await startCompanion({
    dir,
    robotDir,
    owlet: owlet && owlet !== true ? String(owlet) : null,
    convertDir: typeof convertDir === 'string' ? path.resolve(convertDir) : undefined,
    port: Number(arg('port', process.env.PORT ?? 5801)),
    lan,
  });
  console.log(`\n  PitView companion ${VERSION}`);
  console.log(`  Logs:  ${dir}${existsSync(dir) ? '' : '  (folder not found yet, will pick it up when it appears)'}`);
  if (robotDir) {
    const snap = handle.robot.snapshot();
    console.log(`  Robot: ${robotDir}${existsSync(robotDir) ? '' : '  (folder not found yet)'}`);
    console.log(`  Owlet: ${snap.owlet.found ? snap.owlet.path : 'not found: .hoot files will wait until you pass --owlet <path>'}`);
  } else console.log('  Add --robot-dir <folder> to pick up .wpilog / .hoot files from the roboRIO (and --owlet <path> to convert hoots).');
  console.log(`  Open:  http://localhost:${handle.port}`);
  if (lan) {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`         http://${a.address}:${handle.port}  (other devices)`);
  } else console.log('  Add --lan to let other devices on the network connect.');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.code === 'EADDRINUSE' ? 'That port is already in use. Pick another with --port.' : err);
    process.exit(1);
  });
}
