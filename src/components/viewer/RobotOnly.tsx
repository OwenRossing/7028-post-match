import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import type { LogEntry } from '../../lib/library';
import { useProbe } from '../../lib/useProbe';
import { fmtDateTime } from '../../lib/time';
import { FileChips } from '../FileChips';
import { Scrim } from '../Scrim';
import { useState } from 'react';
import { RobotLogCard } from './RobotLogCard';

/**
 * A match that so far has only robot logs. There is nothing for the Driver Station parser to read, so this says
 * what the match is made of and what is missing, and joins its DS log automatically when one that belongs to it arrives.
 */
export function RobotOnly({
  entry,
  headSlot,
  onAddLogs,
  onRemoveLog,
  onRemove,
}: {
  entry: LogEntry;
  headSlot?: HTMLElement | null;
  onAddLogs: () => void;
  onRemoveLog: (name: string) => void;
  onRemove: () => void;
}) {
  const info = useProbe(entry);
  const [menu, setMenu] = useState(false);
  const head = (
    <div className="vhead">
      <span className="head-light none" title="No Driver Station log yet" />
      <div className="vhead-title">
        <h1>{entry.robot?.title ?? 'Robot log'}</h1>
        <span className="vhead-sub">
          Robot log only<span className="vhead-date"> · {fmtDateTime(entry.startTime)}</span>
        </span>
        <FileChips entry={entry} compact showMissing />
      </div>
      <div className="viewer-actions">
        <div className="menu-wrap">
          <button className="btn icon round" onClick={() => setMenu((m) => !m)} aria-label="More">
            <Icon name="more" size={18} />
          </button>
          {menu && (
            <>
              <Scrim onClose={() => setMenu(false)} />
              <div className="menu" onClick={() => setMenu(false)}>
                <button className="item" onClick={onAddLogs}>
                  <span>
                    Add robot logs
                    <small>Another roboRIO or CTRE .wpilog for this match</small>
                  </span>
                </button>
                <hr />
                <button className="item danger" onClick={onRemove}>
                  <span>Remove this match</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div className="viewer">
      {headSlot ? createPortal(head, headSlot) : <div className="viewer-head">{head}</div>}
      <div className="page robot-only">
        <section className="ro-hint">
          <h2>No Driver Station log for this match yet</h2>
          <p>
            Drop its <b>.dslog</b> and <b>.dsevents</b> anywhere on the page, or connect the Driver Station folder. If they belong to this match they join it by themselves, and
            the Board and Graphs appear.
          </p>
        </section>
        <section className="ro-logs">
          <h3>Robot logs</h3>
          {info === null && (
            <p className="muted">
              <span className="spinner" style={{ width: 12, height: 12 }} /> Reading…
            </p>
          )}
          {info?.map((x) => (
            <RobotLogCard key={x.name} info={x} waiting onRemove={() => onRemoveLog(x.name)} />
          ))}
          <div className="info-actions">
            <button className="btn small" onClick={onAddLogs}>
              Add robot logs
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
