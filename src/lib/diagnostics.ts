// A short plain-text summary of how a match was read, to paste into a bug report instead of sending the log.
// Only numbers the app decoded (and one raw record), never the log's messages.

import type { LogEntry } from './library';
import { fmtSpan } from './time';
import type { ParsedLog } from './workerClient';

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '–');

function stats(arr: ArrayLike<number>): { peak: number; mean: number; n: number } {
  let peak = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isNaN(v)) continue;
    if (v > peak) peak = v;
    sum += v;
    n++;
  }
  return { peak: n ? peak : NaN, mean: n ? sum / n : NaN, n };
}

export function diagnosticsText(entry: LogEntry, parsed: ParsedLog): string {
  const { log, events, analysis } = parsed;
  const out: string[] = ['PitView diagnostics'];
  const files = [entry.dslog, entry.dsevents, ...(entry.extras ?? []).map((x) => x.file)].filter(Boolean);
  out.push(`files: ${files.map((f) => `${f!.name}${f!.size ? ` (${f!.size} bytes)` : ''}`).join(', ') || 'none'}`);

  if (!log) out.push('.dslog: none');
  else {
    const connected = log.comms.reduce((a, c) => a + c, 0);
    out.push(
      `.dslog: format v${log.version} · ${log.count} records (${fmtSpan(analysis.duration)}) · starts ${new Date(log.startTime * 1000).toISOString()} · ${
        log.truncated ? 'still being written' : 'complete'
      }`,
    );
    out.push(`connected to the robot: ${((100 * connected) / Math.max(1, log.count)).toFixed(1)}% of records`);
    out.push(
      `power distribution: ${log.pdType}${log.pdCanId != null ? ` · CAN id ${log.pdCanId}` : ''} · records by type byte ${JSON.stringify(log.typeBytes)} (33 = REV PDH, 25 = CTRE PDP)`,
    );
    if (log.pdSample) out.push(`first record with power data (#${log.pdSample.index}, ${log.pdSample.bytes.length} bytes): ${hex(log.pdSample.bytes)}`);
    else out.push('no record carried power distribution data');

    if (log.channelCount) {
      const per = log.currents.map((a, ch) => ({ ch, ...stats(a) }));
      const used = per.filter((c) => c.peak >= 1).length;
      const all = per.reduce((best, c) => (c.peak > best.peak ? c : best), { ch: -1, peak: 0, mean: 0, n: 0 });
      out.push(`channels (peak A / mean A / readings): ${per.map((c) => `${c.ch}: ${n1(c.peak)}/${n1(c.mean)}/${c.n}`).join(' · ')}`);
      out.push(`channels at 1 A or more at some point: ${used} of ${log.channelCount} · biggest single reading: ${n1(all.peak)} A on channel ${all.ch} (the heatmap colour scale)`);
      const t = stats(log.totalCurrent);
      out.push(`total current: peak ${n1(t.peak)} A, mean ${n1(t.mean)} A`);
    } else out.push('no channels were decoded');
    const v = stats(log.voltage);
    out.push(`battery: lowest ${v.n ? Math.min(...log.voltage.filter((x) => !Number.isNaN(x))).toFixed(2) : '–'} V, highest ${n1(v.peak)} V`);
    out.push(`enabled: ${fmtSpan(analysis.runs.reduce((a, r) => a + r.autoTime + r.teleopTime + r.testTime, 0))} · ${analysis.runs.length} period(s)`);
  }

  if (!events) out.push('.dsevents: none');
  else {
    const count = (k: string) => events.events.filter((e) => e.kind === k).length;
    out.push(
      `.dsevents: ${events.events.length} messages (${count('error')} errors, ${count('warning')} warnings) · DS ${events.meta.dsVersion ?? '?'} · team ${events.meta.team ?? '?'} · ${events.meta.eventName ?? 'no event name'}`,
    );
  }
  for (const x of parsed.extras)
    out.push(`robot log ${x.name}: ${x.ok ? `${x.role} · ${x.signals?.length ?? 0} signals · ${x.alignment ? `${x.alignment.confidence} (${x.alignment.method ?? 'none'})` : 'not lined up'}` : `unreadable: ${x.error}`}`);
  for (const w of parsed.warnings) out.push(`warning: ${w}`);
  return out.join('\n');
}
