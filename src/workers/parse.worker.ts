/// <reference lib="webworker" />
import { analyze, summarize } from '../lib/analysis';
import { parseDSEvents, type DSEventsFile } from '../lib/dsevents';
import { dslogTransferables, parseDSLog, type DSLog } from '../lib/dslog';
import type { WorkerRequest, WorkerResponse } from '../lib/workerClient';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const message = (err: unknown) => String((err as Error)?.message ?? err);

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, kind, dslog, dsevents } = e.data;
  try {
    let log: DSLog | null = null;
    let logError: string | undefined;
    if (dslog) {
      try {
        log = parseDSLog(new Uint8Array(dslog));
      } catch (err) {
        logError = message(err);
      }
    }
    let events: DSEventsFile | null = null;
    let eventsError: string | undefined;
    if (dsevents) {
      try {
        events = parseDSEvents(new Uint8Array(dsevents), log?.startTime);
      } catch (err) {
        eventsError = message(err);
      }
    }
    if (!log && !events) throw new Error(logError ?? eventsError ?? 'No readable log files');

    if (kind === 'summary') {
      const res: WorkerResponse = { id, ok: true, summary: summarize(log, events) };
      ctx.postMessage(res);
    } else {
      const warnings = [logError && `.dslog: ${logError}`, eventsError && `.dsevents: ${eventsError}`].filter(Boolean) as string[];
      const res: WorkerResponse = { id, ok: true, parsed: { log, events, analysis: analyze(log, events), warnings } };
      ctx.postMessage(res, log ? dslogTransferables(log) : []);
    }
  } catch (err) {
    const res: WorkerResponse = { id, ok: false, error: message(err) };
    ctx.postMessage(res);
  }
};
