// Reads a whole .wpilog from disk, record by record, to see that it is complete: a header, then records that end
// exactly at the end of the file. Used on what Owlet writes, so a conversion that stopped half way is never kept.
// It streams, so a log of hundreds of MB never has to be in memory at once.

import { open } from 'node:fs/promises';

const CHUNK = 4 * 1024 * 1024;

/** Little-endian unsigned integer of up to 8 bytes (exact up to 2^53, far beyond any log's timestamps). */
function uint(buf, at, len) {
  let v = 0;
  for (let i = len - 1; i >= 0; i--) v = v * 256 + buf[at + i];
  return v;
}

/**
 * @returns {Promise<
 *   | { ok: true, bytes: number, entries: number, records: number, dataRecords: number, seconds: number }
 *   | { ok: false, error: string, truncated?: boolean }
 * >}
 */
export async function inspectWPILog(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12 || head.toString('latin1', 0, 6) !== 'WPILOG') return { ok: false, error: 'It is not a WPILib data log: it does not start with "WPILOG".' };
    if (head[7] !== 1) return { ok: false, error: `Unsupported .wpilog version ${head[7]}.${head[6]}.` };
    const start = 12 + head.readUInt32LE(8);
    if (start > size) return { ok: false, truncated: true, error: 'The .wpilog ends inside its header.' };

    let buf = Buffer.alloc(0);
    let off = 0; // next unread byte in buf
    let fileAt = start; // next byte of the file not yet in buf
    let entries = 0;
    let records = 0;
    let dataRecords = 0;
    let first = Infinity;
    let last = -Infinity;

    // make sure at least `need` bytes are available from `off`; false when the file has run out
    const have = async (need) => {
      while (buf.length - off < need) {
        if (fileAt >= size) return false;
        const want = Math.max(CHUNK, need - (buf.length - off));
        const next = Buffer.allocUnsafe(Math.min(want, size - fileAt));
        const { bytesRead: n } = await fh.read(next, 0, next.length, fileAt);
        if (n === 0) return false;
        fileAt += n;
        buf = Buffer.concat([buf.subarray(off), next.subarray(0, n)]);
        off = 0;
      }
      return true;
    };

    for (;;) {
      if (!(await have(1))) break; // clean end: no bytes left over
      const flags = buf[off];
      const idLen = (flags & 3) + 1;
      const sizeLen = ((flags >> 2) & 3) + 1;
      const tsLen = ((flags >> 4) & 7) + 1;
      const headLen = 1 + idLen + sizeLen + tsLen;
      if (!(await have(headLen))) return cut(size, buf, off);
      const id = uint(buf, off + 1, idLen);
      const payload = uint(buf, off + 1 + idLen, sizeLen);
      const ts = uint(buf, off + 1 + idLen + sizeLen, tsLen);
      if (!(await have(headLen + payload))) return cut(size, buf, off);
      records++;
      if (id === 0) {
        if (payload > 0 && buf[off + headLen] === 0) entries++; // a "start" control record: one signal
      } else {
        dataRecords++;
        if (ts < first) first = ts;
        if (ts > last) last = ts;
      }
      off += headLen + payload;
    }
    return { ok: true, bytes: size, entries, records, dataRecords, seconds: dataRecords ? Math.max(0, last - first) / 1e6 : 0 };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    await fh?.close();
  }
}

function cut(size, buf, off) {
  const left = buf.length - off;
  return { ok: false, truncated: true, error: `The .wpilog stops in the middle of a record (${left.toLocaleString('en-US')} bytes of it, at ${(size - left).toLocaleString('en-US')} of ${size.toLocaleString('en-US')}).` };
}
