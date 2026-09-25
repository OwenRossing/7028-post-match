// Builds prototypes/sample-data.js from the real sample log, so the design
// prototypes show real numbers. Run: node prototypes/extract.mjs
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { parseDSLog } = await server.ssrLoadModule('/src/lib/dslog.ts');
const { parseDSEvents } = await server.ssrLoadModule('/src/lib/dsevents.ts');
const { analyze, computeStats, findProblems } = await server.ssrLoadModule('/src/lib/analysis.ts');

const base = 'public/sample/2026_05_16 11_38_21 Sat.';
const log = parseDSLog(new Uint8Array(readFileSync(base + 'dslog')));
const events = parseDSEvents(new Uint8Array(readFileSync(base + 'dsevents')), log.startTime);
const analysis = analyze(log, events);
const span = analysis.focus;
const stats = computeStats(log, events, analysis, span);
const problems = findProblems(log, events, analysis, stats);
const m0 = analysis.match?.start ?? span.start;

// downsample the match to 4 points per second (min for voltage so dips survive)
const step = 0.25;
const series = { t: [], v: [], i: [], trip: [], loss: [], cpu: [], can: [], comms: [] };
for (let t = span.start; t <= span.end; t += step) {
  const a = Math.round(t / log.period), b = Math.round((t + step) / log.period);
  let vmin = Infinity, imax = 0, trip = 0, loss = 0, cpu = 0, can = 0, comms = 1, n = 0;
  for (let k = a; k < b && k < log.count; k++) {
    if (!Number.isNaN(log.voltage[k])) vmin = Math.min(vmin, log.voltage[k]);
    if (!Number.isNaN(log.totalCurrent[k])) imax = Math.max(imax, log.totalCurrent[k]);
    trip += log.tripMs[k]; loss += log.packetLoss[k]; cpu += log.cpu[k]; can += log.can[k];
    comms = Math.min(comms, log.comms[k]); n++;
  }
  const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
  series.t.push(r(t - m0, 2));
  series.v.push(Number.isFinite(vmin) ? r(vmin, 2) : null);
  series.i.push(r(imax));
  series.trip.push(r(trip / n));
  series.loss.push(r(loss / n));
  series.cpu.push(r(cpu / n));
  series.can.push(r(can / n));
  series.comms.push(comms);
}
const rel = (s) => ({ start: +(s.start - m0).toFixed(2), end: +(s.end - m0).toFixed(2) });
const inSpan = (s) => s.end >= span.start && s.start <= span.end;

const channels = stats.channels.filter((c) => c.peak > 0.5).sort((a, b) => b.ah - a.ah).slice(0, 12)
  .map((c) => ({ ch: c.ch, ah: +c.ah.toFixed(3), peak: +c.peak.toFixed(1), avg: +(c.avg ?? 0).toFixed(1) }));

const evs = (events?.events ?? []).filter((e) => (e.kind === 'error' || e.kind === 'warning') && !e.tags.includes('tracer') && e.t >= span.start && e.t <= span.end)
  .map((e) => ({ t: +(e.t - m0).toFixed(2), kind: e.kind, tags: e.tags, text: e.text.split('\n')[0].slice(0, 90) }));

const data = {
  title: analysis.title,
  event: events?.meta.eventName, team: events?.meta.team,
  duration: +(span.end - span.start).toFixed(1),
  start: +(span.start - m0).toFixed(2), end: +(span.end - m0).toFixed(2),
  auto: analysis.match ? rel({ start: analysis.match.autoStart, end: analysis.match.autoEnd }) : null,
  teleop: analysis.match ? rel({ start: analysis.match.teleopStart, end: analysis.match.teleopEnd }) : null,
  noComms: analysis.noComms.filter(inSpan).map(rel),
  stalls: analysis.codeStalls.filter(inSpan).map(rel),
  brownouts: analysis.brownouts.filter(inSpan).map(rel),
  series,
  channels,
  events: evs,
  problems: problems.map((p) => ({ id: p.id, severity: p.severity, title: p.title, fix: p.fix, t: p.t != null && Number.isFinite(p.t) ? +(p.t - m0).toFixed(2) : null })),
  stats: {
    vmin: +stats.voltage.min.toFixed(2), vminT: +(stats.voltage.minT - m0).toFixed(2), vrest: +stats.voltage.resting.toFixed(2),
    brownouts: stats.brownouts.count, drops: stats.comms.drops, enabledDrops: stats.comms.enabledDrops,
    stallTime: +stats.codeStalls.duration.toFixed(1), stallCount: stats.codeStalls.count,
    tripAvg: +stats.trip.avg.toFixed(1), cpuAvg: Math.round(stats.cpu.avg), canMax: Math.round(stats.can.max),
    peakA: Math.round(stats.current.peak), ah: +stats.current.ah.toFixed(2),
    errors: stats.events.error, warnings: stats.events.warning,
  },
  canDevices: analysis.canDevices.map((d) => ({ device: d.device, count: d.count })),
  loop: analysis.loopCulprits.slice(0, 3).map((c) => ({ name: c.name, ms: +(c.worst * 1000).toFixed(1) })),
};
writeFileSync('prototypes/sample-data.js', 'window.SAMPLE = ' + JSON.stringify(data) + ';\n');
console.log('points', series.t.length, 'problems', problems.length, 'events', evs.length, 'channels', channels.length);
await server.close();
