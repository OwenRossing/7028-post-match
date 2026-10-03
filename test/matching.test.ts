import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planPlacements } from '../src/lib/aggregate';
import { makeDataset, score, type LogClass } from './helpers/dataset';

const fmt = (n: number) => `${(100 * n).toFixed(0)}%`;

/** Prints what the engine got right and wrong on the synthetic pool, to the file named by MATCH_REPORT when set. */
function report(title: string, ds: ReturnType<typeof makeDataset>, placed: { name: string; key: string }[], ms: number) {
  const s = score(ds, placed);
  const lines = [`# ${title}`, `${ds.matches.length} matches, ${ds.logs.length} robot logs, planned in ${ms.toFixed(0)} ms`];
  for (const [cls, v] of [...s.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const precision = v.tp + v.fp ? v.tp / (v.tp + v.fp) : 1;
    const recall = v.tp + v.fn ? v.tp / (v.tp + v.fn) : 1;
    lines.push(`${String(cls).padEnd(52)} placed right ${String(v.tp).padStart(4)}  wrong ${String(v.fp).padStart(3)} (other event ${String(v.wrongEvent).padStart(3)})  missed ${String(v.fn).padStart(4)}  precision ${fmt(precision)} recall ${fmt(recall)}`);
  }
  if (process.env.MATCH_REPORT) writeFileSync(process.env.MATCH_REPORT, lines.join('\n') + '\n', { flag: 'a' });
  return s;
}

describe('matching engine on a season-sized pool', () => {
  it('scores itself: everything dropped into one pool', () => {
    const ds = makeDataset();
    const t0 = performance.now();
    const moves = planPlacements(ds.known, ds.candidates, () => false, () => false);
    const ms = performance.now() - t0;
    const s = report('one pool, nothing told', ds, moves, ms);
    const all = s.get('all')!;
    // wrongly placed logs are the expensive mistake: a wrong match is worse than an unsorted one
    expect(all.fp).toBe(0);
    expect(all.tp / (all.tp + all.fn)).toBeGreaterThan(0.9);
    expect(ms).toBeLessThan(5000);
  });

  it('scores itself: each log added to the event it was recorded at', () => {
    const ds = makeDataset();
    const eventOfLog = new Map(ds.logs.map((l) => [l.name, l.event]));
    const eventOfMatch = new Map(ds.matches.map((m) => [m.key, m.event]));
    const t0 = performance.now();
    const moves = planPlacements(ds.known, ds.candidates, () => false, () => false, { eventOfLog: (n) => eventOfLog.get(n), eventOfMatch: (k) => eventOfMatch.get(k) });
    const ms = performance.now() - t0;
    const s = report('each log added to its own event', ds, moves, ms);
    const all = s.get('all')!;
    expect(all.fp).toBe(0);
    expect(all.tp / (all.tp + all.fn)).toBeGreaterThan(0.9);
    // putting a log in its event never makes things worse than leaving it in the pool
    const pool = score(ds, planPlacements(ds.known, ds.candidates, () => false, () => false)).get('all')!;
    expect(all.tp).toBeGreaterThanOrEqual(pool.tp);
  });
});

export type { LogClass };
