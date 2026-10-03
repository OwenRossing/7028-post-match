// Which robot logs belong to which matches, and what is remembered about that between visits.
//
// A match is a LogEntry. Robot logs (.wpilog) are attached to it by key, kept here rather than on the entries so
// they survive the DS folder being rescanned. A robot log that fits no match yet starts a match of its own (a
// "robot match", key `robot:<log name>`); when a Driver Station log that it belongs to turns up, the robot match
// joins it and goes away.

import { planPlacements, type Candidate, type KnownLog, type Move, type RioAnchors } from './aggregate';
import type { HootProbe } from './hoot';
import { idb } from './idb';
import { candidateOf, robotCandidateOf, type ExtraFile, type ExtraKind, type FileRef, type LogEntry } from './library';

type Db = Pick<typeof idb, 'get' | 'set' | 'del'>;

interface SavedExtra {
  name: string;
  size: number;
  mtime: number;
  kind: ExtraKind;
  role?: string;
  anchors?: RioAnchors;
  startUnix?: number;
  decoded?: boolean;
  hoot?: HootProbe;
}

interface RobotMatch {
  startTime: number;
  title: string;
}

export const robotKey = (firstLogName: string) => `robot:${firstLogName}`;
export const isRobotKey = (key: string) => key.startsWith('robot:');

export class RobotLogStore {
  private attached = new Map<string, ExtraFile[]>();
  private matches = new Map<string, RobotMatch>();
  /** `${log name}@${match key}` pairs the user took off by hand: never added again automatically. */
  private dismissed = new Set<string>();

  constructor(private db: Db = idb) {}

  /** A file kept in browser storage, read back on demand. */
  private ref(m: { name: string; size: number; mtime: number }): FileRef {
    return {
      name: m.name,
      size: m.size,
      mtime: m.mtime,
      read: async () => {
        const data = await this.db.get<ArrayBuffer>('files', m.name);
        if (!data) throw new Error(`${m.name} is no longer saved in this browser`);
        return data;
      },
    };
  }

  async load(): Promise<void> {
    const saved = (await this.db.get<Record<string, SavedExtra[]>>('kv', 'attachments')) ?? {};
    for (const [key, list] of Object.entries(saved))
      this.attached.set(
        key,
        list.map((m) => ({ kind: m.kind, file: this.ref(m), role: m.role, anchors: m.anchors, startUnix: m.startUnix, decoded: m.decoded, hoot: m.hoot })),
      );
    const robot = (await this.db.get<Record<string, RobotMatch>>('kv', 'robotMatches')) ?? {};
    for (const [key, m] of Object.entries(robot)) this.matches.set(key, m);
    for (const d of (await this.db.get<string[]>('kv', 'dismissed')) ?? []) this.dismissed.add(d);
  }

  /** Writes everything down. `skip` says which matches are not to be remembered (the sample); `dropped` are file names that may now be unused. */
  async save(skip: (key: string) => boolean = () => false, dropped: string[] = []): Promise<void> {
    try {
      const out: Record<string, SavedExtra[]> = {};
      const inUse = new Set<string>();
      for (const [key, list] of this.attached) {
        if (skip(key)) continue;
        // logs from the robot-log folder are read from there again next visit: nothing of them is saved
        const own = list.filter((x) => !x.remote);
        if (!own.length) continue;
        out[key] = own.map((x) => ({
          kind: x.kind,
          name: x.file.name,
          size: x.file.size,
          mtime: x.file.mtime,
          role: x.role,
          anchors: x.anchors,
          startUnix: x.startUnix,
          decoded: x.decoded,
          hoot: x.hoot,
        }));
        own.forEach((x) => inUse.add(x.file.name));
      }
      await this.db.set('kv', 'attachments', out);
      await this.db.set('kv', 'robotMatches', Object.fromEntries([...this.matches].filter(([key]) => out[key])));
      await this.db.set('kv', 'dismissed', [...this.dismissed]);
      for (const name of dropped) if (!inUse.has(name)) await this.db.del('files', name);
    } catch {
      /* browser storage unavailable: it all stays for this visit only */
    }
  }

  /** Keeps a log's bytes in browser storage and returns a reference that reads them back. */
  async keep(name: string, size: number, mtime: number, data: ArrayBuffer): Promise<FileRef> {
    await this.db.set('files', name, data);
    return this.ref({ name, size, mtime });
  }

  async clear(): Promise<void> {
    this.attached.clear();
    this.matches.clear();
    this.dismissed.clear();
    await this.save();
  }

  // ---------- Reading ----------

  extrasFor(key: string): ExtraFile[] | undefined {
    return this.attached.get(key);
  }

  isRobotMatch(key: string): boolean {
    return this.matches.has(key);
  }

  has(name: string, key: string): boolean {
    return !!this.attached.get(key)?.some((x) => x.file.name === name);
  }

  isDismissed(name: string, key: string): boolean {
    return this.dismissed.has(`${name}@${key}`);
  }

  /** Every distinct log that can be placed on a match, once. */
  known(): KnownLog[] {
    const seen = new Map<string, KnownLog>();
    for (const list of this.attached.values())
      for (const x of list) if (x.anchors && !seen.has(x.file.name)) seen.set(x.file.name, { name: x.file.name, anchors: x.anchors });
    return [...seen.values()];
  }

  /** Whether a version of a file from the robot-log folder is attached anywhere. */
  hasRemote(remoteId: string): boolean {
    for (const list of this.attached.values()) if (list.some((x) => x.remote && x.remoteId === remoteId)) return true;
    return false;
  }

  /** Takes off every robot-folder log whose version is not in `keep` (the file is gone or has changed). Returns whether anything went. */
  removeRemoteExcept(keep: Set<string>): boolean {
    let changed = false;
    for (const [key, list] of [...this.attached]) {
      const rest = list.filter((x) => !x.remote || keep.has(x.remoteId ?? ''));
      if (rest.length === list.length) continue;
      changed = true;
      if (rest.length) this.attached.set(key, rest);
      else {
        this.attached.delete(key);
        this.matches.delete(key);
      }
    }
    return changed;
  }

  /** Robot-folder logs the user has hidden with Remove. */
  hiddenRemote(): number {
    return [...this.dismissed].filter((d) => d.endsWith('@remote')).length;
  }

  showHiddenRemote(): void {
    for (const d of [...this.dismissed]) if (d.endsWith('@remote')) this.dismissed.delete(d);
  }

  /** Where `name` is attached. */
  keysOf(name: string): string[] {
    return [...this.attached].filter(([, l]) => l.some((x) => x.file.name === name)).map(([k]) => k);
  }

  // ---------- Changing ----------

  /** Attaches a log to a match, replacing an earlier copy with the same name. */
  add(key: string, extra: ExtraFile): void {
    const rest = (this.attached.get(key) ?? []).filter((x) => x.file.name !== extra.file.name);
    this.attached.set(key, [...rest, extra]);
    this.dismissed.delete(`${extra.file.name}@${key}`);
  }

  /** Starts a match that has only robot logs so far. */
  addRobotMatch(key: string, match: RobotMatch): void {
    this.matches.set(key, match);
  }

  /** Takes a log off a match, by hand: it will not be put back automatically. A robot match left with no logs goes away. */
  remove(key: string, name: string): void {
    const removed = (this.attached.get(key) ?? []).find((x) => x.file.name === name);
    // a log from the robot-log folder would otherwise come straight back next time the folder is read
    if (removed?.remote) this.dismissed.add(`${name}@remote`);
    const rest = (this.attached.get(key) ?? []).filter((x) => x.file.name !== name);
    if (rest.length) this.attached.set(key, rest);
    else {
      this.attached.delete(key);
      this.matches.delete(key);
    }
    this.dismissed.add(`${name}@${key}`);
  }

  /** Forgets a match and everything attached to it. Returns the log names that were on it. */
  dropMatch(key: string): string[] {
    const names = (this.attached.get(key) ?? []).map((x) => x.file.name);
    this.attached.delete(key);
    this.matches.delete(key);
    return names;
  }

  /** The library's entries with robot logs attached and robot matches present. Returns the same map when nothing changes. */
  applyTo(m: Map<string, LogEntry>): Map<string, LogEntry> {
    let out = m;
    const edit = () => (out === m ? (out = new Map(m)) : out);
    for (const [key, r] of this.matches)
      if (!m.has(key)) edit().set(key, { key, source: 'saved', startTime: r.startTime, robot: { title: r.title } });
    for (const [key, e] of [...out]) {
      if (e.robot && !this.matches.has(key)) {
        edit().delete(key);
        continue;
      }
      const x = this.attached.get(key);
      if (e.extras !== x) edit().set(key, { ...e, extras: x });
    }
    return out;
  }

  // ---------- Joining ----------

  /** Where to place every known log among the matches that have a Driver Station log, and robot matches that can now join one. */
  joinPlan(entries: Iterable<LogEntry>): { adds: Move[]; absorbed: string[] } {
    const list = [...entries];
    const cands = list.map(candidateOf).filter((c): c is Candidate => !!c);
    const moves = planPlacements(this.known(), cands, (n, k) => this.has(n, k), (n, k) => this.isDismissed(n, k));

    // A robot match's logs are of one match: if one of them fits a DS match, they all do.
    const adds = [...moves];
    const absorbed: string[] = [];
    const has = (name: string, key: string) => this.has(name, key) || adds.some((a) => a.name === name && a.key === key);
    for (const key of this.matches.keys()) {
      const logs = (this.attached.get(key) ?? []).map((x) => x.file.name);
      if (!logs.length) continue;
      const targets = new Set(adds.filter((a) => logs.includes(a.name)).map((a) => a.key));
      // already wholly on a DS match (added earlier): this robot match is redundant
      for (const c of cands) if (logs.every((n) => this.has(n, c.key))) targets.add(c.key);
      for (const t of targets)
        for (const n of logs) if (!has(n, t) && !this.isDismissed(n, t)) adds.push({ name: n, key: t, why: 'it belongs with the other robot logs of this match' });
      if ([...targets].some((t) => logs.every((n) => has(n, t)))) absorbed.push(key);
    }
    return { adds, absorbed };
  }

  /** Applies a join plan. Returns which matches (by key) gained logs. */
  applyJoin(plan: { adds: Move[]; absorbed: string[] }): string[] {
    const gained = new Set<string>();
    for (const a of plan.adds) {
      const src = [...this.attached.values()].flat().find((x) => x.file.name === a.name);
      if (!src || this.has(a.name, a.key)) continue;
      this.add(a.key, src);
      gained.add(a.key);
    }
    for (const key of plan.absorbed) {
      this.attached.delete(key);
      this.matches.delete(key);
    }
    return [...gained];
  }

  /** A robot match as a candidate for another robot log (by the field's name for it, else by the clock). */
  robotCandidates(entries: Iterable<LogEntry>): Candidate[] {
    return [...entries].map(robotCandidateOf).filter((c): c is Candidate => !!c);
  }
}
