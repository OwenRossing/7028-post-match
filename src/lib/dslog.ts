// Parser for FRC Driver Station .dslog files (format version 4, 2022+).
//
// Layout (big endian): a 20 byte header (int32 version, LabVIEW timestamp), then one record every 20 ms:
//   u8 trip time (x/2 ms) · i8 packet loss (x*4 %) · u16 battery (x/256 V) · u8 roboRIO CPU (x/2 %)
//   u8 status flags (active low) · u8 CAN util (x/2 %) · u8 Wi-Fi dB (x/2) · u16 Wi-Fi Mb (x/256)
//   4 byte power distribution header, byte 3 = type (33 REV PDH, 25 CTRE PDP, else none)
//   REV:  CAN id, 27 bytes of 10 bit currents packed LSB first (3 per 32 bits), 4 × u8 (x/16 A), temperature
//   CTRE: CAN id, 21 bytes of 10 bit currents packed MSB first (6 per 64 bits), resistance, voltage, temperature
// Based on AdvantageScope's DSLogReader, orangelight/DSLOG-Reader and the frcture docs.

import { lvToUnix } from './time';

/** Status flags, stored active-high after decoding. */
export const FLAG = {
  BROWNOUT: 0x80,
  WATCHDOG: 0x40,
  DS_TELEOP: 0x20,
  DS_AUTO: 0x10,
  DS_DISABLED: 0x08,
  ROBOT_TELEOP: 0x04,
  ROBOT_AUTO: 0x02,
  ROBOT_DISABLED: 0x01,
} as const;

/**
 * Mode bits reported by the robot program. When the robot is connected but none are set, the robot code
 * did not report its mode for that packet (slow or stuck loop, code restarting, or no code at all).
 */
export const ROBOT_MODE_MASK = FLAG.ROBOT_TELEOP | FLAG.ROBOT_AUTO | FLAG.ROBOT_DISABLED;

export const PD_NONE = 0;
export const PD_REV = 1;
export const PD_CTRE = 2;
export type PdTypeName = 'none' | 'rev' | 'ctre';

const HEADER_SIZE = 20;
const BASE_RECORD = 14;
const REV_SIZE = 33;
const CTRE_SIZE = 25;
const REV_ID = 33;
const CTRE_ID = 25;

export const PERIOD = 0.02;

export interface DSLog {
  version: number;
  /** Unix seconds (UTC) of the first record. */
  startTime: number;
  period: number;
  count: number;
  /** Seconds since log start for every record. */
  time: Float64Array;
  tripMs: Float32Array;
  /** Percent, 0–100. */
  packetLoss: Float32Array;
  voltage: Float32Array;
  /** Percent, 0–100. */
  cpu: Float32Array;
  /** Percent, 0–100. */
  can: Float32Array;
  wifiDb: Float32Array;
  wifiMb: Float32Array;
  /** Decoded (active-high) status flags, see FLAG. */
  flags: Uint8Array;
  /** 1 when the DS was receiving packets from the robot (the DS logs voltage 0xFFFF otherwise). */
  comms: Uint8Array;
  pdKind: Uint8Array;
  pdType: PdTypeName;
  pdCanId: number | null;
  channelCount: number;
  /** One array per channel, NaN where no power distribution data was logged. */
  currents: Float32Array[];
  totalCurrent: Float32Array;
  pdTemp: Float32Array;
  /** True when the file ends partway through a record (e.g. the DS is still writing it). */
  truncated: boolean;
}

function recordSize(typeByte: number): number {
  if (typeByte === REV_ID) return BASE_RECORD + REV_SIZE;
  if (typeByte === CTRE_ID) return BASE_RECORD + CTRE_SIZE;
  return BASE_RECORD;
}

export function readVersion(bytes: Uint8Array): number {
  if (bytes.byteLength < 4) return -1;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0);
}

export function parseDSLog(bytes: Uint8Array): DSLog {
  if (bytes.byteLength < HEADER_SIZE) throw new Error('File is too small to be a .dslog');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getInt32(0);
  if (version !== 4) {
    throw new Error(
      version === 3
        ? 'This .dslog uses format v3 (2021 or older). Only v4 (2022+) is supported.'
        : `Unsupported .dslog version ${version}`,
    );
  }
  const startTime = lvToUnix(view, 4);
  const len = bytes.byteLength;

  // Pass 1: count records (their size depends on the power distribution type).
  let count = 0;
  let pos = HEADER_SIZE;
  let revCount = 0;
  let ctreCount = 0;
  while (pos + BASE_RECORD <= len) {
    const type = bytes[pos + 13];
    const size = recordSize(type);
    if (pos + size > len) break;
    if (type === REV_ID) revCount++;
    else if (type === CTRE_ID) ctreCount++;
    count++;
    pos += size;
  }
  const truncated = pos !== len;
  const channelCount = revCount > 0 ? 24 : ctreCount > 0 ? 16 : 0;
  const pdType: PdTypeName = revCount >= ctreCount ? (revCount > 0 ? 'rev' : 'none') : 'ctre';

  const time = new Float64Array(count);
  const tripMs = new Float32Array(count);
  const packetLoss = new Float32Array(count);
  const voltage = new Float32Array(count);
  const cpu = new Float32Array(count);
  const can = new Float32Array(count);
  const wifiDb = new Float32Array(count);
  const wifiMb = new Float32Array(count);
  const flags = new Uint8Array(count);
  const commsArr = new Uint8Array(count);
  const pdKind = new Uint8Array(count);
  const currents = Array.from({ length: channelCount }, () => new Float32Array(count).fill(NaN));
  const totalCurrent = new Float32Array(count).fill(NaN);
  const pdTemp = new Float32Array(count).fill(NaN);
  let pdCanId: number | null = null;

  // Pass 2: decode.
  pos = HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    time[i] = i * PERIOD;
    flags[i] = ~bytes[pos + 5] & 0xff;
    const rawVoltage = view.getUint16(pos + 2);
    const comms = rawVoltage !== 0xffff;
    commsArr[i] = comms ? 1 : 0;

    const volts = rawVoltage / 256;
    voltage[i] = comms && volts < 20 ? volts : NaN;
    tripMs[i] = comms ? bytes[pos] * 0.5 : NaN;
    packetLoss[i] = comms ? Math.min(Math.max(view.getInt8(pos + 1) * 4, 0), 100) : NaN;
    cpu[i] = comms ? bytes[pos + 4] * 0.5 : NaN;
    can[i] = comms ? bytes[pos + 6] * 0.5 : NaN;
    wifiDb[i] = comms ? bytes[pos + 7] * 0.5 : NaN;
    wifiMb[i] = comms ? view.getUint16(pos + 8) / 256 : NaN;

    const type = bytes[pos + 13];
    const pd = pos + BASE_RECORD;
    if (!comms) {
      // Stale power distribution data is repeated while disconnected; leave it as NaN.
    } else if (type === REV_ID) {
      pdKind[i] = PD_REV;
      pdCanId = bytes[pd];
      const base = pd + 1;
      let total = 0;
      for (let ch = 0; ch < 20; ch++) {
        const word = view.getUint32(base + Math.floor(ch / 3) * 4, true);
        const amps = ((word >>> ((ch % 3) * 10)) & 0x3ff) / 8;
        currents[ch][i] = amps;
        total += amps;
      }
      for (let ch = 20; ch < 24; ch++) {
        const amps = bytes[base + 27 + (ch - 20)] / 16;
        currents[ch][i] = amps;
        total += amps;
      }
      totalCurrent[i] = total;
      pdTemp[i] = bytes[base + 31];
    } else if (type === CTRE_ID) {
      pdKind[i] = PD_CTRE;
      pdCanId = bytes[pd];
      const base = pd + 1;
      let total = 0;
      for (let ch = 0; ch < 16; ch++) {
        const bit0 = Math.floor(ch / 6) * 64 + (ch % 6) * 10;
        let v = 0;
        for (let b = 0; b < 10; b++) {
          const p = bit0 + b;
          v = (v << 1) | ((bytes[base + (p >> 3)] >> (7 - (p & 7))) & 1);
        }
        const amps = v / 8;
        if (ch < channelCount) currents[ch][i] = amps;
        total += amps;
      }
      totalCurrent[i] = total;
      pdTemp[i] = bytes[base + 23];
    }
    pos += recordSize(type);
  }

  return {
    version,
    startTime,
    period: PERIOD,
    count,
    time,
    tripMs,
    packetLoss,
    voltage,
    cpu,
    can,
    wifiDb,
    wifiMb,
    flags,
    comms: commsArr,
    pdKind,
    pdType,
    pdCanId,
    channelCount,
    currents,
    totalCurrent,
    pdTemp,
    truncated,
  };
}

/** Typed arrays of a parsed log, for transferring out of a worker without copying. */
export function dslogTransferables(log: DSLog): ArrayBuffer[] {
  const arrays = [
    log.time, log.tripMs, log.packetLoss, log.voltage, log.cpu, log.can, log.wifiDb, log.wifiMb,
    log.flags, log.comms, log.pdKind, log.totalCurrent, log.pdTemp, ...log.currents,
  ];
  return arrays.map((a) => a.buffer as ArrayBuffer);
}
