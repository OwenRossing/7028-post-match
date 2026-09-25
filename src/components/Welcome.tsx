import { DS_LOG_PATH, folderSupported } from '../lib/folder';
import type { LogEntry } from '../lib/library';
import { fmtDateTime } from '../lib/time';
import type { Library } from '../lib/useLibrary';
import { Icon } from './Icon';
import { KeyBar } from './KeyBar';

interface Props {
  library: Library;
  recent: LogEntry[];
  onOpenFiles: () => void;
  onOpen: (key: string) => void;
  onSample: () => void;
  onLatestMatch: () => void;
}

const VERDICT_TEXT = { ok: 'Looked healthy', warn: 'Worth a look', bad: 'Had problems' } as const;

/** Home: one obvious thing to do. */
export function Welcome({ library, recent, onOpenFiles, onOpen, onSample, onLatestMatch }: Props) {
  const { folder } = library;
  const latest = recent.find((e) => e.summary?.isMatch);
  const others = recent.filter((e) => e !== latest).slice(0, 5);

  return (
    <div className="welcome">
      {latest ? (
        <>
          <div className="welcome-eyebrow">Latest match</div>
          <h1>{latest.summary?.title ?? latest.key}</h1>
          <p className="welcome-sub">
            {latest.summary?.verdict && <span className={`dot ${latest.summary.verdict}`} />}
            {[latest.summary?.verdict && VERDICT_TEXT[latest.summary.verdict], latest.summary?.eventName, fmtDateTime(latest.startTime)]
              .filter(Boolean)
              .join('  ·  ')}
          </p>
          <button className="btn pill primary big" onClick={onLatestMatch}>
            Open <kbd>L</kbd>
          </button>
        </>
      ) : (
        <>
          <img className="welcome-icon" src="./favicon.svg" alt="" />
          <h1>PitView</h1>
          <p className="welcome-sub">See what went wrong in your last match.</p>
          <button className="btn pill primary big" onClick={onOpenFiles}>
            Open log files
          </button>
        </>
      )}

      <div className="welcome-links">
        {folder.status === 'connected' ? (
          <span className="welcome-watching">
            <span className="live-dot" /> Watching {folder.name}
          </span>
        ) : folder.status === 'needs-permission' ? (
          <button className="link" onClick={() => library.reconnectFolder()}>
            Reconnect the DS folder
          </button>
        ) : folderSupported() ? (
          <button className="link" onClick={() => library.connectFolder()} title={DS_LOG_PATH}>
            Watch the Driver Station folder
          </button>
        ) : null}
        {latest ? (
          <button className="link" onClick={onOpenFiles}>
            Open other files
          </button>
        ) : (
          <button className="link" onClick={onSample}>
            Try a sample match
          </button>
        )}
      </div>
      <p className="welcome-hint">You can also drop .dslog files anywhere on this page.</p>

      {others.length > 0 && (
        <section className="welcome-recent">
          <h3>Recent</h3>
          <ul className="plain-list">
            {others.map((e) => (
              <li key={e.key}>
                <button onClick={() => onOpen(e.key)}>
                  <span className={`dot ${e.summary?.verdict ?? 'none'}`} />
                  <span className="pl-title">{e.summary?.title ?? e.key}</span>
                  <span className="pl-sub">{fmtDateTime(e.startTime)}</span>
                  <Icon name="chevronRight" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <KeyBar fixed tabs={false} keys={[...(latest ? ([['L', 'latest match']] as [string, string][]) : []), ['O', 'open files'], ['S', 'your logs'], ['D', 'light / dark']]} />
    </div>
  );
}
