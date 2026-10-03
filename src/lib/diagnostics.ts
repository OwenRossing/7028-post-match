// A short plain-text summary of how a match was read, to paste into a bug report instead of sending the log.
// Only numbers the app decoded (and one raw record), never the log's messages.

import type { ExtraInfo } from './extras';
import type { LogEntry } from './library';
import { fmtSpan } from './time';
import { hootProbeLines } from './hoot';
import { matchLabel } from './wpilog';
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

/**
 * What is inside robot logs, for working out how to read and chart them: who wrote each, whether it has a clock and
 * the field's name for the match, how it lined up, and every signal with its type, record count and what the logger
 * said about it. Signal names are your robot's own; console messages are not included.
 */
export function robotLogDiagnostics(infos: ExtraInfo[], maxSignals = 400): string {
  const out: string[] = [];
  for (const x of infos) {
    if (!x.ok) {
      out.push(`robot log ${x.name} (${x.size} bytes): unreadable: ${x.error}`);
      continue;
    }
    if (x.decoded === false && x.hoot) {
      out.push(`robot log ${x.name}: ${x.role} · ${(x.size / 1e6).toFixed(1)} MB`, ...hootProbeLines(x.hoot));
      continue;
    }
    const a = x.anchors;
    out.push(`robot log ${x.name}: ${x.role} · ${(x.size / 1e6).toFixed(1)} MB · ${fmtSpan(x.duration ?? 0)} · ${x.truncated ? 'still being written' : 'complete'}`);
    out.push(
      `  robot clock: ${a?.clockOffset != null ? `yes, starts ${x.clock ? new Date(x.clock.start * 1000).toISOString() : '?'}` : 'none'} · field match name: ${
        a?.ids.length ? a.ids.map((i) => `${matchLabel(i)}${i.event ? ` (${i.event})` : ''}`).join(', ') : 'none'
      } · enabled periods: ${a?.enabled.length ?? 0}${a?.enabled.length ? ` (first ${a.enabled[0].start.toFixed(1)}–${a.enabled[0].end.toFixed(1)} s)` : ''} · console lines: ${x.consoleLines ?? 0}`,
    );
    if (x.note) out.push(...x.note.split('\n').map((l) => `  ${l}`));
    out.push(`  lined up with the match: ${x.alignment ? `${x.alignment.confidence}${x.alignment.method ? ` by ${x.alignment.method}` : ''}. ${x.alignment.detail}` : 'not checked'}`);
    const sig = x.signals ?? [];
    out.push(`  ${sig.length} signals (name | type | records | metadata)${sig.length > maxSignals ? `, first ${maxSignals}` : ''}:`);
    for (const s of sig.slice(0, maxSignals)) out.push(`  ${s.name} | ${s.type} | ${s.count}${s.metadata ? ` | ${s.metadata}` : ''}`);
  }
  return out.join('\n');
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
  if (parsed.extras.length) out.push(robotLogDiagnostics(parsed.extras));
  for (const w of parsed.warnings) out.push(`warning: ${w}`);
  return out.join('\n');
}
