// Copies the built web app and the engine next to the Electron code, so the app is one self-contained folder.
// Run `npm run build` in the project folder first.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'app');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('The web app is not built yet. Run "npm run build" in the project folder first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'server'), { recursive: true });
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
// The page is served from disk by the app itself, so it is always current: no service worker to keep a stale copy.
for (const f of readdirSync(path.join(out, 'dist'))) if (/^(sw|workbox-.*)\.js(\.map)?$/.test(f)) rmSync(path.join(out, 'dist', f));
for (const f of readdirSync(path.join(root, 'server'))) if (f.endsWith('.mjs')) cpSync(path.join(root, 'server', f), path.join(out, 'server', f));

// electron-builder takes the app icon from build/icon.png
mkdirSync(path.join(here, 'build'), { recursive: true });
cpSync(path.join(root, 'public', 'icon-512.png'), path.join(here, 'build', 'icon.png'));
console.log('Prepared desktop/app');
