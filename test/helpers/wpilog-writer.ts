// Builds .wpilog bytes for tests. Field widths are the smallest that fit, like the real writer, so the
// parser sees 1-byte ids/sizes and multi-byte timestamps.

const enc = new TextEncoder();

function width(n: number): number {
  let w = 1;
  while (n >= 2 ** (8 * w)) w++;
  return w;
}

function uint(n: number, len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
  return out;
}

function u32(n: number): number[] {
  return uint(n, 4);
}

function lenStr(s: string): number[] {
  const b = enc.encode(s);
  return [...u32(b.length), ...b];
}

export class WPILogWriter {
  private out: number[] = [];
  private next = 1;

  constructor(extraHeader = '') {
    const h = enc.encode(extraHeader);
    this.out.push(...enc.encode('WPILOG'), 0x00, 0x01, ...u32(h.length), ...h);
  }

  private record(id: number, ts: number, payload: number[]) {
    const idW = width(id);
    const sizeW = width(payload.length);
    const micros = Math.round(ts * 1e6);
    const tsW = width(micros);
    this.out.push(idW - 1 | ((sizeW - 1) << 2) | ((tsW - 1) << 4), ...uint(id, idW), ...uint(payload.length, sizeW), ...uint(micros, tsW), ...payload);
  }

  start(name: string, type: string, ts = 0, metadata = ''): number {
    const id = this.next++;
    this.record(0, ts, [0, ...u32(id), ...lenStr(name), ...lenStr(type), ...lenStr(metadata)]);
    return id;
  }

  finish(id: number, ts: number) {
    this.record(0, ts, [1, ...u32(id)]);
  }

  setMetadata(id: number, ts: number, metadata: string) {
    this.record(0, ts, [2, ...u32(id), ...lenStr(metadata)]);
  }

  boolean(id: number, ts: number, v: boolean) {
    this.record(id, ts, [v ? 1 : 0]);
  }

  int64(id: number, ts: number, v: number) {
    this.record(id, ts, [...uint(v, 8)]);
  }

  float(id: number, ts: number, v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v, true);
    this.record(id, ts, [...new Uint8Array(b.buffer)]);
  }

  double(id: number, ts: number, v: number) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, true);
    this.record(id, ts, [...new Uint8Array(b.buffer)]);
  }

  string(id: number, ts: number, s: string) {
    this.record(id, ts, [...enc.encode(s)]);
  }

  raw(id: number, ts: number, bytes: number[]) {
    this.record(id, ts, bytes);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
