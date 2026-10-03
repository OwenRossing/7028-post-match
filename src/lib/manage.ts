// Deleting matches from the library. Which of PitView's own copies go, what is only hidden, and how to say so.
//
// Files on disk are never touched: the Driver Station folder and the robot-log folder are only read. A match that comes
// from one of them is hidden instead (and stays hidden through rescans) until the user shows it again.

import { summaryKeyOf, type LogEntry } from './library';

export interface DeletePlan {
  /** Matches that leave the library. */
  keys: string[];
  /** File names of copies kept in this browser (the DS logs of those matches): deleted. */
  saved: string[];
  /** Matches that come from a watched folder or the companion: hidden, because a rescan would bring them back. */
  hide: string[];
  /** Library summaries cached for these matches (without the version suffix): deleted. */
  summaryKeys: string[];
  counts: {
    total: number;
    /** Matches saved in this browser. */
    saved: number;
    /** Matches from a watched folder or the companion. */
    watched: number;
    /** Matches that only have robot logs. */
    robotOnly: number;
    sample: number;
    /** Robot logs attached to them. */
    robotLogs: number;
  };
}

export function planDelete(entries: Iterable<LogEntry>, keys: Iterable<string>): DeletePlan {
  const wanted = new Set(keys);
  const plan: DeletePlan = { keys: [], saved: [], hide: [], summaryKeys: [], counts: { total: 0, saved: 0, watched: 0, robotOnly: 0, sample: 0, robotLogs: 0 } };
  for (const e of entries) {
    if (!wanted.has(e.key)) continue;
    plan.keys.push(e.key);
    plan.counts.total++;
    plan.counts.robotLogs += e.extras?.length ?? 0;
    // a saved copy of the same files can sit under a match that a folder now shows, so the names go whatever the source
    for (const f of [e.dslog, e.dsevents]) if (f) plan.saved.push(f.name);
    if (e.robot) plan.counts.robotOnly++;
    else if (e.source === 'folder' || e.source === 'companion') {
      plan.counts.watched++;
      plan.hide.push(e.key);
    } else if (e.source === 'sample') plan.counts.sample++;
    else {
      plan.counts.saved++;
      plan.summaryKeys.push(summaryKeyOf(e));
    }
  }
  return plan;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What to ask the user before deleting, in plain words: what is removed, what is only hidden, and that files stay. */
export function describeDelete(plan: DeletePlan, opts: { all?: boolean } = {}): string {
  const c = plan.counts;
  const head = opts.all ? `Clear the whole library (${plural(c.total, 'match', 'matches')})?` : `Delete ${plural(c.total, 'match', 'matches')}?`;
  const lines: string[] = [];
  if (c.saved) lines.push(`• ${plural(c.saved, 'saved match', 'saved matches')}: removed from this browser.`);
  if (c.robotOnly) lines.push(`• ${plural(c.robotOnly, 'robot-log-only match', 'robot-log-only matches')}: removed.`);
  if (c.watched)
    lines.push(
      `• ${plural(c.watched, 'match', 'matches')} from a watched folder: hidden. The files in the folder are not touched, and Show hidden brings ${c.watched === 1 ? 'it' : 'them'} back.`,
    );
  if (c.sample) lines.push('• The sample log: closed.');
  if (c.robotLogs) lines.push(`• ${plural(c.robotLogs, 'attached robot log')} ${c.robotLogs === 1 ? 'goes' : 'go'} with ${c.total === 1 ? 'it' : 'them'}.`);
  if (opts.all) lines.push('', 'Matches that arrive from now on still appear.');
  return [head, '', ...lines].join('\n');
}
