// Parser for FRC Driver Station .dsevents files (format version 4).
//
// Layout (big endian): 20 byte header (int32 version, LabVIEW timestamp), then records of
//   LabVIEW timestamp (16 bytes) · int32 length · UTF-8 text
// Robot messages are tagged ("<TagVersion>1 <time> 01:23.456 <count> 1 <flags> 1 <Code> -1003 <details> ...")
// and one record can hold several of them, newest first. DS diagnostics are plain "Info ..." text.

import { lvToUnix } from './time';

export type EventKind = 'error' | 'warning' | 'print' | 'ds' | 'fms';
export type EventLevel = 'error' | 'warning' | 'info';

export interface DSEvent {
  id: number;
  /** Seconds since the start of the paired .dslog (or of this file when unpaired). */
  t: number;
  kind: EventKind;
  level: EventLevel;
  text: string;
  code?: number;
  location?: string;
  stack?: string;
  /** Robot program time in seconds, when the robot tagged the message. */
  robotTime?: number;
  tags: string[];
  /** Signature used to group repeats of the same message. */
  sig: string;
}

export interface FmsInfo {
  t: number;
  matchType: string;
  matchNumber: number;
  replay: number;
  fieldTime?: string;
}

export interface Sample<T> {
  t: number;
  value: T;
}

export interface Joystick {
  slot: number;
  name: string;
  axes: number;
  buttons: number;
  povs: number;
}

export interface EventsMeta {
  eventName?: string;
  fms?: FmsInfo;
  dsVersion?: string;
  robotLanguage?: string;
  wpilibVersion?: string;
  rioImage?: string;
  team?: number;
  gameData: Sample<string>[];
  joysticks: Joystick[];
  railFaults: Sample<{ v12: number; v5: number; v3_3: number }>[];
  powerCounters: Sample<{ commsTimeouts: number; brownouts: number }>[];
  rioStats: Sample<{ diskMB: number; memMB: number; laptopCpu: number; laptopBatt: number }>[];
  pings: Sample<Record<string, string>>[];
}

export interface DSEventsFile {
  version: number;
  startTime: number;
  events: DSEvent[];
  meta: EventsMeta;
}

const TAG_RE = /<(TagVersion|time|count|flags|Code|details|location|stack|message)>/g;
const TRACER_LINE = /^\s*(.+?\(\)|[\w.$]+):\s*(\d+\.\d+)s\s*$/;

function parseRobotTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function splitTags(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = [...chunk.matchAll(TAG_RE)];
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : chunk.length;
    out[m[1]] = chunk.slice(start, end).replace(/^ /, '').replace(/\s+$/, '');
  });
  return out;
}

export function isTracerText(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => TRACER_LINE.test(l));
}

/** Parses "\tFoo.periodic(): 0.0123s" lines into [name, seconds] pairs. */
export function parseTracer(text: string): [string, number][] {
  const out: [string, number][] = [];
  for (const line of text.split('\n')) {
    const m = TRACER_LINE.exec(line);
    if (m) out.push([m[1], Number(m[2])]);
  }
  return out;
}

function tagsFor(kind: EventKind, text: string, location = '', code?: number): string[] {
  const tags: string[] = [];
  const hay = `${text} ${location}`;
  if (/\bCAN\b|canivore|talon|pigeon|spark ?(max|flex)|cancoder|candle|phoenix|REVLib/i.test(hay)) tags.push('can');
  if (/Loop time of .* overrun|loop overrun|Watchdog not fed/i.test(text)) tags.push('loop');
  if (isTracerText(text)) tags.push('tracer', 'loop');
  if (code === 44004 || /lost communication/i.test(text)) tags.push('comms');
  if (/^NT: /.test(text)) tags.push('nt');
  if (/Ping Results/.test(text)) tags.push('ping');
  if (/brownout/i.test(text)) tags.push('brownout');
  if (/Rail Faults/.test(text)) tags.push('rail');
  if (/^Joystick \d/.test(text)) tags.push('joystick');
  if (/Game (Specific )?Data|Game data update/i.test(text)) tags.push('gamedata');
  if (/Disk Free/.test(text)) tags.push('riostats');
  if (/Unhandled exception|quit unexpectedly|Robots should not quit|crashed|Exception in thread|terminate called|Caught .*exception|segmentation fault|Traceback \(most recent/i.test(hay))
    tags.push('crash');
  if (/Robot program startup complete|\*+ Robot program starting|Robot program starting/i.test(text)) tags.push('startup');
  if (kind === 'fms') tags.push('fms');
  return [...new Set(tags)];
}

function signature(kind: EventKind, text: string, code?: number, location?: string): string {
  if (isTracerText(text)) return `${kind}|tracer`;
  const norm = text
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return `${kind}|${code ?? ''}|${(location ?? '').replace(/\d+/g, '#')}|${norm}`;
}

function extractMeta(meta: EventsMeta, text: string, t: number, teamVotes: Map<number, number>) {
  let m: RegExpExecArray | null;
  if ((m = /FMS Event Name:\s*(\S+)/.exec(text))) meta.eventName = m[1];
  if ((m = /FMS Connected:\s+(.+?) - (\d+):(\d+)(?:, Field Time: ([\d/ :]+))?/.exec(text))) {
    const matchType = m[1].trim();
    if (matchType !== 'None' || !meta.fms)
      meta.fms = { t, matchType, matchNumber: Number(m[2]), replay: Number(m[3]), fieldTime: m[4]?.trim() };
  }
  if ((m = /Driver Station - Version ([\d.]+)/.exec(text))) meta.dsVersion = m[1];
  if ((m = /^(Java|C\+\+|Python|LabVIEW|Kotlin|\w+) (\d{4}\.[\d.]+?)(FRC_roboRIO\S*?_v[\d.]*\d)(\w*)$/.exec(text))) {
    meta.robotLanguage = m[1];
    meta.wpilibVersion = m[2];
    meta.rioImage = m[3];
  }
  const joyRe = /Joystick (\d+): \((.*?)\)(\d+) axes, (\d+) buttons, (\d+) POVs/g;
  const joys = [...text.matchAll(joyRe)];
  if (joys.length) {
    for (const j of joys) {
      const js: Joystick = { slot: +j[1], name: j[2], axes: +j[3], buttons: +j[4], povs: +j[5] };
      const existing = meta.joysticks.findIndex((x) => x.slot === js.slot);
      if (existing >= 0) meta.joysticks[existing] = js;
      else meta.joysticks.push(js);
    }
    meta.joysticks.sort((a, b) => a.slot - b.slot);
  }
  if ((m = /^Game Specific Data(.*)$/.exec(text))) meta.gameData.push({ t, value: m[1].trim() });
  if ((m = /Rail Faults: 12V - (\d+), 5V - (\d+), 3\.3V - (\d+)/.exec(text)))
    meta.railFaults.push({ t, value: { v12: +m[1], v5: +m[2], v3_3: +m[3] } });
  if ((m = /Communications Timeout: (\d+) Input Voltage Brownouts: (\d+)/.exec(text)))
    meta.powerCounters.push({ t, value: { commsTimeouts: +m[1], brownouts: +m[2] } });
  if ((m = /Disk Free (\d+) MB, Memory Free (\d+) MB\. DS Laptop: CPU (\d+)% Batt (\d+)%/.exec(text)))
    meta.rioStats.push({ t, value: { diskMB: +m[1], memMB: +m[2], laptopCpu: +m[3], laptopBatt: +m[4] } });
  if (/Ping Results:/.test(text)) {
    const status: Record<string, string> = {};
    for (const p of text.matchAll(/(link|DS radio|robot radio|roboRIO|FMS)(?:\([^)]*\))?-(\w+)/g)) status[p[1]] = p[2];
    meta.pings.push({ t, value: status });
  }
  for (const ip of text.matchAll(/\b10\.(\d{1,2})\.(\d{1,2})\.\d{1,3}\b/g)) {
    const team = Number(ip[1]) * 100 + Number(ip[2]);
    if (team > 0) teamVotes.set(team, (teamVotes.get(team) ?? 0) + 1);
  }
  for (const r of text.matchAll(/roboRIO-(\d+)-FRC/gi)) {
    const team = Number(r[1]);
    teamVotes.set(team, (teamVotes.get(team) ?? 0) + 5);
  }
}

/**
 * Parses a .dsevents file.
 * @param baseTime unix start time of the paired .dslog; event times are made relative to it.
 */
export function parseDSEvents(bytes: Uint8Array, baseTime?: number): DSEventsFile {
  if (bytes.byteLength < 20) throw new Error('File is too small to be a .dsevents');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getInt32(0);
  if (version !== 4) throw new Error(`Unsupported .dsevents version ${version}`);
  const startTime = lvToUnix(view, 4);
  const base = baseTime ?? startTime;
  const decoder = new TextDecoder('utf-8');

  const events: DSEvent[] = [];
  const meta: EventsMeta = {
    gameData: [],
    joysticks: [],
    railFaults: [],
    powerCounters: [],
    rioStats: [],
    pings: [],
  };
  const teamVotes = new Map<number, number>();

  const push = (e: Omit<DSEvent, 'id' | 'tags' | 'sig'>) => {
    const tags = tagsFor(e.kind, e.text, e.location, e.code);
    events.push({ ...e, id: events.length, tags, sig: signature(e.kind, e.text, e.code, e.location) });
  };

  let pos = 20;
  while (pos + 20 <= bytes.byteLength) {
    const wall = lvToUnix(view, pos);
    const length = view.getInt32(pos + 16);
    if (length < 0 || pos + 20 + length > bytes.byteLength) break; // partially written record
    const raw = decoder.decode(bytes.subarray(pos + 20, pos + 20 + length));
    pos += 20 + length;
    const t = wall - base;

    if (raw.includes('<TagVersion>')) {
      // Chunks are stored newest first; reverse so they read in order.
      const chunks = raw.split('<TagVersion>').filter((c) => c.trim()).reverse();
      let tracerLines: string[] = [];
      let tracerTime: number | undefined;
      const flushTracer = () => {
        if (tracerLines.length) {
          push({ t, kind: 'print', level: 'info', text: tracerLines.join('\n'), robotTime: tracerTime });
          tracerLines = [];
        }
      };
      for (const chunk of chunks) {
        const tags = splitTags('<TagVersion>' + chunk);
        const robotTime = parseRobotTime(tags.time);
        if ('message' in tags) {
          const text = tags.message.replace(/^\s+$/, '');
          if (!text.trim()) continue;
          if (TRACER_LINE.test(text)) {
            if (!tracerLines.length) tracerTime = robotTime;
            tracerLines.push(text.trim());
            continue;
          }
          flushTracer();
          extractMeta(meta, text.trim(), t, teamVotes);
          push({ t, kind: 'print', level: 'info', text: text.trim(), robotTime });
        } else {
          flushTracer();
          const flagsNum = Number(tags.flags ?? 0);
          const code = tags.Code !== undefined ? Number(tags.Code) : undefined;
          const location = tags.location?.trim() || undefined;
          const text = (tags.details ?? '').replace(/\s+$/, '').replace(/^\s*\n/, '');
          const fromDs = location === 'Driver Station' || (code !== undefined && code >= 44000 && code < 45000);
          const level: EventLevel = flagsNum & 1 ? 'error' : 'warning';
          const kind: EventKind = fromDs ? 'ds' : level;
          extractMeta(meta, text, t, teamVotes);
          push({
            t,
            kind,
            level,
            text: isTracerText(text) ? text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') : text.trim(),
            code: Number.isFinite(code) ? code : undefined,
            location,
            stack: tags.stack?.trim() || undefined,
            robotTime,
          });
        }
      }
      flushTracer();
    } else {
      // Plain DS text. "Info" prefixes can be glued together ("Info 26.0Info FMS Event Name: X").
      const text = raw.trim();
      if (!text) continue;
      if (/^FMS Connected/.test(text)) {
        extractMeta(meta, text, t, teamVotes);
        push({ t, kind: 'fms', level: 'info', text: text.replace(/\s*\n\s*/g, ' ') });
        continue;
      }
      const parts = text.split(/Info (?=\S)/).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        extractMeta(meta, part, t, teamVotes);
        const kind: EventKind = /^FMS/.test(part) ? 'fms' : 'ds';
        // A bare version number ("26.0") on its own is the DS announcing itself.
        const clean = /^\d+\.\d+$/.test(part) ? `Driver Station version ${part}` : part;
        if (!meta.dsVersion && /^\d+\.\d+$/.test(part)) meta.dsVersion = part;
        push({ t, kind, level: 'info', text: clean });
      }
    }
  }

  let bestTeam: number | undefined;
  let bestVotes = 0;
  teamVotes.forEach((votes, team) => {
    if (votes > bestVotes) {
      bestVotes = votes;
      bestTeam = team;
    }
  });
  meta.team = bestTeam;

  events.sort((a, b) => a.t - b.t || a.id - b.id);
  events.forEach((e, i) => (e.id = i));
  return { version, startTime, events, meta };
}
