'use strict';
// PitView desktop app. Starts the engine (server/companion.mjs) inside the app, on this computer only, and shows the
// PitView page it serves. The engine watches the Driver Station log folder and the robot-log folder and runs CTRE's
// Owlet on .hoot files; this file holds the settings and the native dialogs.

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { copyIntoRobotFolder } = require('./robotfiles.cjs');

// Tests (and portable installs) can keep everything in one folder.
if (process.env.PITVIEW_USER_DATA) app.setPath('userData', process.env.PITVIEW_USER_DATA);

const APP = path.join(__dirname, 'app'); // the built web app and the engine, put here by prepare.mjs
const isWin = process.platform === 'win32';
const OWLET = isWin ? 'owlet.exe' : 'owlet';
// The page lives at one address so the browser keeps its saved logs between launches (they belong to the address).
const PORTS = [7028, 7029, 7030, 7031, 7032, 7033, 7034, 7035, 0];

let win = null;
let engine = null;
let settings = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function defaults() {
  return {
    dsDir: isWin ? 'C:\\Users\\Public\\Documents\\FRC\\Log Files' : path.join(os.homedir(), 'FRC', 'Log Files'),
    robotDir: path.join(app.getPath('documents'), 'PitView', 'Robot logs'),
    owlet: null,
  };
}

function loadSettings() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaults();
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

/** Places Owlet is looked for when no path has been chosen: beside the app, in the data folder, in Documents/PitView, then PATH. */
function owletCandidates() {
  const dirs = [app.getPath('userData'), path.join(app.getPath('documents'), 'PitView'), path.dirname(app.getPath('exe'))];
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
  return dirs.map((d) => path.join(d, OWLET));
}

async function startEngine() {
  const { startCompanion } = await import(pathToFileURL(path.join(APP, 'server', 'companion.mjs')).href);
  fs.mkdirSync(settings.robotDir, { recursive: true });
  const options = {
    dir: settings.dsDir,
    robotDir: settings.robotDir,
    owlet: settings.owlet,
    owletCandidates: owletCandidates(),
    convertDir: path.join(app.getPath('userData'), 'converted'),
    dist: path.join(APP, 'dist'),
    lan: false, // this computer only
    cors: false, // and no other website may read it
    desktop: true,
  };
  for (const port of PORTS) {
    try {
      return await startCompanion({ ...options, port });
    } catch (err) {
      if (err && err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('Could not start the engine: no port was free.');
}

const view = () => {
  const owlet = engine.robot.owletPath();
  return { dsDir: settings.dsDir, robotDir: settings.robotDir, owlet: { path: owlet, found: !!owlet }, platform: process.platform, version: app.getVersion() };
};

/** Only the page this app serves may use the bridge. */
const trusted = (event) => {
  try {
    return new URL(event.senderFrame.url).origin === new URL(engine.url).origin;
  } catch {
    return false;
  }
};

function registerIpc() {
  ipcMain.handle('pitview:settings', (e) => (trusted(e) ? view() : null));

  ipcMain.handle('pitview:choose', async (e, kind) => {
    if (!trusted(e) || (kind !== 'ds' && kind !== 'robot')) return view();
    const current = kind === 'ds' ? settings.dsDir : settings.robotDir;
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'ds' ? 'Driver Station log folder' : 'Robot log folder',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) {
      if (kind === 'ds') settings.dsDir = r.filePaths[0];
      else {
        settings.robotDir = r.filePaths[0];
        fs.mkdirSync(settings.robotDir, { recursive: true });
      }
      saveSettings();
      engine.configure({ dir: settings.dsDir, robotDir: settings.robotDir });
    }
    return view();
  });

  ipcMain.handle('pitview:owlet', async (e) => {
    if (!trusted(e)) return view();
    const r = await dialog.showOpenDialog(win, {
      title: 'Locate Owlet (CTRE\'s hoot converter)',
      defaultPath: settings.owlet || app.getPath('downloads'),
      properties: ['openFile'],
      filters: isWin ? [{ name: 'Owlet', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (!r.canceled && r.filePaths[0]) {
      settings.owlet = r.filePaths[0];
      saveSettings();
      engine.configure({ owlet: settings.owlet });
    }
    return view();
  });

  ipcMain.handle('pitview:open', async (e, kind) => {
    if (!trusted(e) || (kind !== 'ds' && kind !== 'robot')) return;
    const dir = kind === 'ds' ? settings.dsDir : settings.robotDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle('pitview:retry', (e) => {
    if (trusted(e)) engine.robot.retry();
  });

  // Robot logs dropped on the page: copied into the robot-log folder, where the engine converts hoots and the page finds them.
  ipcMain.handle('pitview:addRobot', async (e, paths) => {
    if (!trusted(e)) return { copied: [], skipped: [], failed: [] };
    const result = await copyIntoRobotFolder(paths, settings.robotDir);
    if (result.copied.length) void engine.robot.scan();
    return result;
  });
}

function buildMenu() {
  const openDir = (dir) => () => {
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'PitView',
        submenu: [
          { label: 'Open robot logs folder', click: () => openDir(settings.robotDir)() },
          { label: 'Open Driver Station logs folder', click: () => openDir(settings.dsDir)() },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      { label: 'Help', submenu: [{ label: 'PitView on GitHub', click: () => shell.openExternal('https://github.com/OwenRossing/7028-post-match') }] },
    ]),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: '#0d1015',
    title: 'PitView',
    icon: path.join(APP, 'dist', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));
  const local = (url) => url.startsWith(engine.url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !local(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (local(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  void win.loadURL(engine.url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // The page may copy to the clipboard (Copy diagnostics) and nothing else: no camera, location, notifications…
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
    settings = loadSettings();
    try {
      engine = await startEngine();
    } catch (err) {
      dialog.showErrorBox('PitView could not start', String((err && err.message) || err));
      app.quit();
      return;
    }
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (engine) void engine.close();
  });
}
