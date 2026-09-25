// Renders the PitView logo (same design as public/favicon.svg) to PNG app icons, with no dependencies.
// Usage: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Geometry in a 64×64 design space (matches favicon.svg).
const line = [[9, 38], [19, 38], [24, 23], [32, 49], [39, 29], [43, 38], [55, 38]];

function shade(x, y, full) {
  // Rounded square (full-bleed square for maskable icons).
  const r = full ? 0 : 14;
  const cx = Math.min(Math.max(x, r), 64 - r);
  const cy = Math.min(Math.max(y, r), 64 - r);
  if (Math.hypot(x - cx, y - cy) > r || x < 0 || y < 0 || x > 64 || y > 64) return null;
  const t = (x + y) / 128;
  let c = [47 + (27 - 47) * t, 111 + (63 - 111) * t, 237 + (148 - 237) * t];
  if (Math.hypot(x - 51, y - 18) <= 5) c = [247, 201, 72];
  for (let i = 0; i < line.length - 1; i++)
    if (segDist(x, y, ...line[i], ...line[i + 1]) <= 2.5) c = [255, 255, 255];
  return c;
}

function render(size, full) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  // Maskable icons keep the logo inside the central safe zone.
  const scale = full ? 0.8 : 1;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          let u = ((x + (sx + 0.5) / ss) / size) * 64;
          let v = ((y + (sy + 0.5) / ss) / size) * 64;
          u = 32 + (u - 32) / scale;
          v = 32 + (v - 32) / scale;
          let c = shade(u, v, false);
          if (!c && full) c = [27, 63, 148];
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      const i = (y * size + x) * 4;
      if (a) {
        buf[i] = r / a;
        buf[i + 1] = g / a;
        buf[i + 2] = b / a;
      }
      buf[i + 3] = (a / (ss * ss)) * 255;
    }
  return png(size, buf);
}

writeFileSync(new URL('../public/icon-192.png', import.meta.url), render(192, false));
writeFileSync(new URL('../public/icon-512.png', import.meta.url), render(512, false));
writeFileSync(new URL('../public/icon-maskable-512.png', import.meta.url), render(512, true));
console.log('icons written');
