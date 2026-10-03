/// <reference lib="webworker" />
import { analyze, computeStats, summarize } from '../lib/analysis';
import { boardMetrics, buildBoard } from '../lib/board';
import { parseDSEvents, type DSEventsFile } from '../lib/dsevents';
import { dslogTransferables, parseDSLog, type DSLog } from '../lib/dslog';
import { compactAnchor, dsAnchor } from '../lib/aggregate';
import { describeExtra, linkBoots } from '../lib/extras';
import { extractRobotSignals, type RobotSignal } from '../lib/robotSeries';
import type { WorkerRequest, WorkerResponse } from '../lib/workerClient';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const message = (err: unknown) => String((err as Error)?.message ?? err);

/** A robot log bigger than this is listed on the Info page but not put on the graphs: it would need about 4 bytes of memory for every 3 of the file, twice. */
const MAX_GRAPH_BYTES = 400e6;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, kind, dslog, dsevents, extras } = e.data;
  try {
    if (kind === 'probe') {
      const res: WorkerResponse = { id, ok: true, probed: (extras ?? []).map((x) => describeExtra(x.name, x.kind, x.data, null, x.hoot, x.note)) };
      ctx.postMessage(res);
      return;
    }
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
      const analysis = analyze(log, events);
      const stats = computeStats(log, events, analysis, analysis.focus);
      const summary = summarize(log, events, analysis, stats);
      summary.metrics = boardMetrics(buildBoard(log, events, analysis, stats));
      summary.anchor = compactAnchor(dsAnchor(log, events, analysis));
      const res: WorkerResponse = { id, ok: true, summary };
      ctx.postMessage(res);
    } else {
      const analysis = analyze(log, events);
      const anchor = extras?.length ? dsAnchor(log, events, analysis) : null;
      const described = (extras ?? []).map((x) => describeExtra(x.name, x.kind, x.data, anchor, x.hoot, x.note));
      linkBoots(described); // a Phoenix log has nothing to line up by: it goes by the roboRIO log of the same boot
      // Every signal of the logs that line up, on the Driver Station log's grid, to graph per-motor use and the rest.
      const robot: RobotSignal[] = [];
      const tooBig: string[] = [];
      if (log)
        described.forEach((info, i) => {
          const al = info.alignment;
          if (!info.ok || info.decoded === false || !al || (al.confidence !== 'high' && al.confidence !== 'medium')) return;
          if (extras![i].data.byteLength > MAX_GRAPH_BYTES) {
            tooBig.push(`${info.name}: too big to put on the graphs (${Math.round(extras![i].data.byteLength / 1e6)} MB). Its signals are listed on the Info page.`);
            return;
          }
          try {
            robot.push(...extractRobotSignals(new Uint8Array(extras![i].data), info.name, al.offset, log.count, log.period));
          } catch {
            /* a log that cannot be read in full is still listed on the Info page */
          }
        });
      const warnings = [
        logError && `.dslog: ${logError}`,
        eventsError && `.dsevents: ${eventsError}`,
        ...described.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`),
        ...tooBig,
      ].filter(Boolean) as string[];
      const res: WorkerResponse = { id, ok: true, parsed: { log, events, analysis, extras: described, robot, warnings } };
      ctx.postMessage(res, [...(log ? dslogTransferables(log) : []), ...robot.map((s) => s.arr.buffer)]);
    }
  } catch (err) {
    const res: WorkerResponse = { id, ok: false, error: message(err) };
    ctx.postMessage(res);
  }
};
