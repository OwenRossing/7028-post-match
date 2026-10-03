'use strict';
// Looking for a copy of CTRE's Owlet that the user has just downloaded. This only ever *suggests* a file: the app asks
// before it will run it (see main.cjs), because anything saved in Downloads could be named owlet.exe.

const fs = require('node:fs');
const path = require('node:path');

const NAMES = process.platform === 'win32' ? ['owlet.exe', 'owlet'] : ['owlet'];

/**
 * An Owlet in `dir`: a file named owlet(.exe) right there, or inside a folder whose name mentions owlet (a download that
 * was unzipped), to `depth` folders down. The most recently saved one if there are several. Null if none.
 */
function findOwletIn(dir, { depth = 4, names = NAMES } = {}) {
  const wanted = (n) => names.some((x) => x.toLowerCase() === n.toLowerCase());
  const hits = [];
  const read = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).slice(0, 5000);
    } catch {
      return [];
    }
  };
  const search = (d, left) => {
    for (const e of read(d)) {
      const full = path.join(d, e.name);
      if (e.isFile() && wanted(e.name)) hits.push(full);
      else if (e.isDirectory() && left > 0) search(full, left - 1);
    }
  };
  for (const e of read(dir)) {
    const full = path.join(dir, e.name);
    if (e.isFile() && wanted(e.name)) hits.push(full);
    else if (e.isDirectory() && /owlet/i.test(e.name)) search(full, depth);
  }
  let best = null;
  let bestTime = -1;
  for (const h of hits) {
    try {
      if (!looksRunnable(h)) continue;
      const t = fs.statSync(h).mtimeMs;
      if (t > bestTime) [best, bestTime] = [h, t];
    } catch {
      /* gone */
    }
  }
  return best;
}

/** On Windows a program starts with "MZ"; a file that does not is not worth suggesting. Elsewhere there is nothing to check. */
function looksRunnable(file, platform = process.platform) {
  if (platform !== 'win32') return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(2);
    return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === 'MZ';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The name of a zip in `dir` that looks like the Owlet download, if it has not been unzipped. */
function owletZipIn(dir) {
  try {
    return fs.readdirSync(dir).find((n) => /owlet.*\.zip$/i.test(n)) ?? null;
  } catch {
    return null;
  }
}

module.exports = { findOwletIn, looksRunnable, owletZipIn, NAMES };
