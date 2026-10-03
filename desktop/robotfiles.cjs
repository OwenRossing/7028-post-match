'use strict';
// Putting robot logs the user dropped on the page into the robot-log folder, where the engine finds them and runs
// Owlet on the hoots. Only .hoot and .wpilog files are copied, and only into that folder, under their own name.

const fs = require('node:fs');
const path = require('node:path');

const ROBOT_FILE = /\.(hoot|wpilog)$/i;

/** `name`, or `name (2)`, `name (3)` … in `dir`, whichever is free. */
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('Too many files with this name in the folder.');
}

/**
 * Copies each file into `dir`. Resolves { copied, skipped, failed }: `skipped` are files that are already there (same
 * name and size, or dropped from the folder itself), `failed` say why. A copy is made under a temporary name and renamed
 * when it is whole, so the folder watcher never sees half of a big file.
 */
async function copyIntoRobotFolder(paths, dir) {
  const out = { copied: [], skipped: [], failed: [] };
  if (!Array.isArray(paths)) return out;
  fs.mkdirSync(dir, { recursive: true });
  for (const p of paths.slice(0, 500)) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    const name = path.basename(p);
    try {
      if (!ROBOT_FILE.test(name)) throw new Error('Only .hoot and .wpilog files are copied to the robot-log folder.');
      const src = fs.statSync(p);
      if (!src.isFile()) throw new Error('This is not a file.');
      const same = path.join(dir, name);
      if (path.resolve(p) === path.resolve(same) || (fs.existsSync(same) && fs.statSync(same).size === src.size)) {
        out.skipped.push(name);
        continue;
      }
      const dest = freeName(dir, name);
      const part = path.join(dir, `.${dest}.part`); // not a .hoot/.wpilog name, so the engine ignores it until it is renamed
      try {
        await fs.promises.copyFile(p, part, fs.constants.COPYFILE_EXCL);
        await fs.promises.rename(part, path.join(dir, dest));
      } catch (err) {
        await fs.promises.rm(part, { force: true });
        throw err;
      }
      out.copied.push(dest);
    } catch (err) {
      out.failed.push({ name, error: String((err && err.message) || err) });
    }
  }
  return out;
}

module.exports = { copyIntoRobotFolder, ROBOT_FILE };
