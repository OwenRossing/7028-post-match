import type { Confidence } from '../../lib/aggregate';
import { robotLogDiagnostics } from '../../lib/diagnostics';
import type { ExtraInfo } from '../../lib/extras';
import { fmtSpan } from '../../lib/time';
import { CopyDiagnostics } from './CopyDiagnostics';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

const FIT: Record<Confidence, string> = {
  high: 'Lines up with the match',
  medium: 'Probably lines up',
  low: 'Weak match, treat with care',
  none: 'Not lined up',
};

/** One line for a folded row: who wrote the logs, how many, and whether they all line up. */
export function robotSummary(extras: ExtraInfo[]): string {
  if (!extras.length) return 'None added';
  const ok = extras.filter((x) => x.ok);
  if (!ok.length) return `${plural(extras.length, 'log')}, none readable`;
  const readable = ok.filter((x) => x.decoded !== false);
  const unread = ok.length - readable.length;
  const aligned = readable.filter((x) => x.alignment && x.alignment.confidence !== 'none').length;
  const roles = [...new Set(ok.map((x) => x.role))].join(' + ');
  return `${roles}${ok.length > 1 ? ` · ${ok.length} logs` : ''}${unread ? ` · ${unread} not readable yet` : ''}${aligned === readable.length ? '' : ` · ${readable.length - aligned} not lined up`}`;
}

/** What a robot log is, how it lines up with the match, and every signal in it. `waiting` is for a match with no Driver Station log yet. */
export function RobotLogCard({ info: x, onRemove, waiting = false }: { info: ExtraInfo; onRemove: () => void; waiting?: boolean }) {
  const a = x.alignment;
  return (
    <div className="robot-log">
      <div className="robot-log-head">
        <b>{x.name}</b>
        <span className="faint">{[x.role, size(x.size), x.duration != null && fmtSpan(x.duration)].filter(Boolean).join(' · ')}</span>
        <button className="btn small ghost" onClick={onRemove} title="Take this log off the match">
          Remove
        </button>
      </div>
      {!x.ok ? (
        <p className="robot-log-note bad">{x.error}</p>
      ) : x.decoded === false ? (
        <>
          <p className="robot-log-note">
            <b>Kept, not readable yet.</b> {x.note}
          </p>
          <CopyDiagnostics
            build={() => robotLogDiagnostics([x])}
            label="Copy hoot diagnostics"
            note="A description of this file (first bytes, readable text, how compressed it looks) to paste here. The file itself is not included."
          />
        </>
      ) : (
        <>
          {waiting && !a ? (
            <p className="robot-log-note">Waiting for the Driver Station log of this match, to line this up with.</p>
          ) : (
            <p className={`robot-log-note ${a ? a.confidence : ''}`}>
              <b>{a ? FIT[a.confidence] : 'Not checked'}.</b> {a?.detail}
            </p>
          )}
          {x.truncated && <p className="robot-log-note muted">The robot was still writing this log: the last record is partly written.</p>}
          <details className="robot-log-signals">
            <summary>
              {plural(x.signals?.length ?? 0, 'signal')}
              {x.consoleLines ? ` · ${plural(x.consoleLines, 'console line')}` : ''}
            </summary>
            <div className="info-list">
              {(x.signals ?? []).slice(0, 400).map((s) => (
                <div key={s.name} className="info-item static signal">
                  <span className="mono">{s.name}</span>
                  <span className="faint">
                    {s.type} · {s.count.toLocaleString()}
                  </span>
                </div>
              ))}
              {(x.signals?.length ?? 0) > 400 && <p className="muted info-empty">…and {(x.signals!.length - 400).toLocaleString()} more.</p>}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
