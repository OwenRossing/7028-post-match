#!/usr/bin/env node
// PitView companion server.
//
// Runs on the Driver Station laptop, serves the built PitView app, and exposes the DS log folder
// (read-only) so the app can list, download and live-watch logs. Useful when:
//   - you want the pit crew to open the latest match from another laptop/tablet on the same network (--lan)
//   - the browser can't use folder access (Firefox/Safari)
//
// Usage: node server/companion.mjs [--dir "C:\Users\Public\Documents\FRC\Log Files"] [--port 5801] [--lan]
// No dependencies. Only .dslog/.dsevents files inside --dir are ever served.

import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const DEFAULT_DIR =
  process.platform === 'win32' ? 'C:\\Users\\Public\\Documents\\FRC\\Log Files' : path.join(os.homedir(), 'FRC', 'Log Files');
const LOG_DIR = path.resolve(String(arg('dir', process.env.PITVIEW_LOG_DIR ?? DEFAULT_DIR)));
const PORT = Number(arg('port', process.env.PORT ?? 5801));
const LAN = arg('lan', false) === true;
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // Lets an https:// hosted PitView reach this server on localhost (Chrome Private Network Access).
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

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

/** Resolves a client supplied relative path, refusing anything outside LOG_DIR or not a log file. */
function safeLogPath(rel) {
  if (typeof rel !== 'string' || !LOG_RE.test(rel)) return null;
  const full = path.resolve(LOG_DIR, rel);
  const relative = path.relative(LOG_DIR, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

// ---- Change notifications (Server-Sent Events) ----
const clients = new Set();
let lastSig = '';
let notifyTimer = null;

function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    for (const res of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`);
  }, 250);
}

async function pollForChanges() {
  const files = await listLogs(LOG_DIR);
  const sig = files.map((f) => `${f.path}:${f.size}:${f.mtime}`).sort().join('|');
  if (lastSig && sig !== lastSig) notify();
  lastSig = sig;
}

if (existsSync(LOG_DIR)) {
  try {
    watch(LOG_DIR, { recursive: true }, (_evt, name) => {
      if (!name || LOG_RE.test(String(name))) notify();
    });
  } catch {
    /* recursive watch unsupported: polling below still works */
  }
}
setInterval(() => void pollForChanges(), 2000);
void pollForChanges();

// ---- Static app ----
function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>PitView companion</title><body style="font-family:system-ui;padding:32px;max-width:640px">` +
        `<h1>PitView companion is running</h1><p>The app hasn't been built yet. Run <code>npm run build</code> in the project folder, then reload.</p>` +
        `<p>Serving logs from <code>${LOG_DIR.replace(/</g, '&lt;')}</code>.</p></body>`,
    );
    return;
  }
  let file = path.resolve(DIST, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file).toLowerCase();
  const immutable = pathname.includes('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  cors(res);
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
        return sendJson(res, 200, { name: 'pitview-companion', version: VERSION, dir: LOG_DIR, exists: existsSync(LOG_DIR) });
      case '/api/logs':
        return sendJson(res, 200, await listLogs(LOG_DIR));
      case '/api/file': {
        const full = safeLogPath(url.searchParams.get('path'));
        if (!full || !existsSync(full)) return sendJson(res, 404, { error: 'Not found' });
        const s = statSync(full);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': s.size,
          'Cache-Control': 'no-store',
        });
        createReadStream(full).pipe(res);
        return;
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
        return serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  PitView companion ${VERSION}`);
  console.log(`  Logs:  ${LOG_DIR}${existsSync(LOG_DIR) ? '' : '  (folder not found yet, will pick it up when it appears)'}`);
  console.log(`  Open:  http://localhost:${PORT}`);
  if (LAN) {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`         http://${a.address}:${PORT}  (other devices)`);
  } else console.log('  Add --lan to let other devices on the network connect.');
  console.log('');
});
