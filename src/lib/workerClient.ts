import type { Analysis, LogSummary } from './analysis';
import type { DSEventsFile } from './dsevents';
import type { DSLog } from './dslog';
import type { ExtraInfo } from './extras';
import type { HootProbe } from './hoot';
import type { ExtraKind } from './library';

export interface ParsedLog {
  log: DSLog | null;
  events: DSEventsFile | null;
  analysis: Analysis;
  /** What each attached log holds and how it lines up, in the order they were attached. */
  extras: ExtraInfo[];
  warnings: string[];
}

/** An attached log on its way to the worker. */
export interface ExtraPayload {
  name: string;
  kind: ExtraKind;
  data: ArrayBuffer;
  /** For a .hoot already described when it was added: the description, with `data` left empty. */
  hoot?: HootProbe;
}

export interface WorkerRequest {
  id: number;
  /** `probe` only looks inside attached logs (to decide which matches they belong to); it needs no DS files. */
  kind: 'full' | 'summary' | 'probe';
  dslog?: ArrayBuffer;
  dsevents?: ArrayBuffer;
  extras?: ExtraPayload[];
}

export type WorkerResponse =
  | { id: number; ok: true; parsed?: ParsedLog; summary?: LogSummary; probed?: ExtraInfo[] }
  | { id: number; ok: false; error: string };

class WorkerChannel {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        p?.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        this.pending.forEach((p) => p.reject(new Error(e.message || 'The log parser crashed')));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    }
    return this.worker;
  }

  request(kind: WorkerRequest['kind'], dslog?: ArrayBuffer, dsevents?: ArrayBuffer, extras?: ExtraPayload[]): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const transfer = [dslog, dsevents, ...(extras ?? []).map((x) => x.data)].filter(Boolean) as ArrayBuffer[];
      this.w.postMessage({ id, kind, dslog, dsevents, extras } satisfies WorkerRequest, transfer);
    });
  }
}

// One worker for logs the user is looking at, one for background library indexing.
const viewer = new WorkerChannel();
const indexer = new WorkerChannel();

export async function parseLog(dslog?: ArrayBuffer, dsevents?: ArrayBuffer, extras?: ExtraPayload[]): Promise<ParsedLog> {
  const res = await viewer.request('full', dslog, dsevents, extras);
  if (!res.ok) throw new Error(res.error);
  return res.parsed!;
}

/** Looks inside logs without a match to line them up against: what they are, how long, and their clock. */
export async function probeExtras(extras: ExtraPayload[]): Promise<ExtraInfo[]> {
  const res = await indexer.request('probe', undefined, undefined, extras);
  if (!res.ok) throw new Error(res.error);
  return res.probed!;
}

export async function summarizeLog(dslog?: ArrayBuffer, dsevents?: ArrayBuffer): Promise<LogSummary> {
  const res = await indexer.request('summary', dslog, dsevents);
  if (!res.ok) throw new Error(res.error);
  return res.summary!;
}
