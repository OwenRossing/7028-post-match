'use strict';
// What the page is allowed to ask of the desktop app. Nothing here takes a path or a program from the page: folders and
// Owlet are chosen in native dialogs in the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pitviewDesktop', {
  settings: () => ipcRenderer.invoke('pitview:settings'),
  chooseFolder: (kind) => ipcRenderer.invoke('pitview:choose', kind),
  locateOwlet: () => ipcRenderer.invoke('pitview:owlet'),
  openFolder: (kind) => ipcRenderer.invoke('pitview:open', kind),
  retryConversions: () => ipcRenderer.invoke('pitview:retry'),
  // Takes the dropped or picked File objects themselves, never paths: only a real file the user chose has one.
  addRobotFiles: (files) => {
    const paths = [];
    for (const f of Array.from(files || [])) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch {
        /* not a file from disk */
      }
    }
    return ipcRenderer.invoke('pitview:addRobot', paths);
  },
});
