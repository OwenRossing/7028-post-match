import type { Analysis, LogSummary } from './analysis';
import type { DSEventsFile } from './dsevents';
import type { DSLog } from './dslog';

export interface ParsedLog {
  log: DSLog | null;
  events: DSEventsFile | null;
  analysis: Analysis;
  warnings: string[];
}

export interface WorkerRequest {
  id: number;
  kind: 'full' | 'summary';
  dslog?: ArrayBuffer;
  dsevents?: ArrayBuffer;
}

export type WorkerResponse =
  | { id: number; ok: true; parsed?: ParsedLog; summary?: LogSummary }
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

  request(kind: WorkerRequest['kind'], dslog?: ArrayBuffer, dsevents?: ArrayBuffer): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const transfer = [dslog, dsevents].filter(Boolean) as ArrayBuffer[];
      this.w.postMessage({ id, kind, dslog, dsevents } satisfies WorkerRequest, transfer);
    });
  }
}

// One worker for logs the user is looking at, one for background library indexing.
const viewer = new WorkerChannel();
const indexer = new WorkerChannel();

export async function parseLog(dslog?: ArrayBuffer, dsevents?: ArrayBuffer): Promise<ParsedLog> {
  const res = await viewer.request('full', dslog, dsevents);
  if (!res.ok) throw new Error(res.error);
  return res.parsed!;
}

export async function summarizeLog(dslog?: ArrayBuffer, dsevents?: ArrayBuffer): Promise<LogSummary> {
  const res = await indexer.request('summary', dslog, dsevents);
  if (!res.ok) throw new Error(res.error);
  return res.summary!;
}
