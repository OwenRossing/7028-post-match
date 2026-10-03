import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Confidence } from '../../lib/aggregate';
import type { ExtraInfo } from '../../lib/extras';
import { fmtDateTime, fmtSpan } from '../../lib/time';
import type { ViewCtx } from './types';

interface Item {
  id: string;
  title: string;
  summary: string;
  body: ReactNode;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== '' && v !== false);
  if (!shown.length) return <p className="muted info-empty">Nothing logged.</p>;
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Info: everything about the match that is not a measurement, as folded rows. */
export function Info({ ctx }: { ctx: ViewCtx }) {
  const { parsed, entry, tf } = ctx;
  const { log, events, analysis } = parsed;
  const meta = events?.meta;
  const start = log?.startTime ?? events?.startTime ?? entry.startTime;
  const [open, setOpen] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const fms = meta?.fms && meta.fms.matchType !== 'None' ? meta.fms : undefined;
  const mem = meta?.rioStats.map((s) => s.value.memMB).filter((m) => m > 0) ?? [];
  const items: Item[] = [
    {
      id: 'match',
      title: 'Match',
      summary: [analysis.title, meta?.eventName, fmtDateTime(start)].filter(Boolean).join(' · '),
      body: (
        <Kv
          rows={[
            ['Event', meta?.eventName],
            ['FMS match', fms && `${fms.matchType} ${fms.matchNumber}${fms.replay > 1 ? ` (replay ${fms.replay})` : ''}`],
            ['Team', meta?.team],
            ['Started', fmtDateTime(start)],
            ['Log length', fmtSpan(analysis.duration)],
            [
              'Game data',
              meta?.gameData
                .filter((g) => g.value)
                .map((g) => `"${g.value}"`)
                .join(', '),
            ],
          ]}
        />
      ),
    },
    {
      id: 'periods',
      title: 'Enabled periods',
      summary:
        analysis.runs.length === 1
          ? analysis.runs[0].label
          : analysis.runs.length
            ? plural(analysis.runs.length, 'period')
            : 'Never enabled',
      body: analysis.runs.length ? (
        <div className="info-list">
          {analysis.runs.map((r, i) => (
            <button key={i} className="info-item" onClick={() => ctx.jumpTo((r.start + r.end) / 2, { width: r.end - r.start + 6 })}>
              <b>{r.label}</b>
              <span className="muted">
                {[
                  r.autoTime > 0 && `Auto ${fmtSpan(r.autoTime)}`,
                  r.teleopTime > 0 && `Teleop ${fmtSpan(r.teleopTime)}`,
                  r.testTime > 0 && `Test ${fmtSpan(r.testTime)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="faint">{tf.fmt(r.start)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted info-empty">The robot was not enabled in this log.</p>
      ),
    },
    {
      id: 'robot',
      title: 'Robot',
      summary:
        [meta?.robotLanguage && `${meta.robotLanguage} ${meta.wpilibVersion ?? ''}`.trim(), log && pdName(log.pdType)]
          .filter(Boolean)
          .join(' · ') || 'Not logged',
      body: (
        <Kv
          rows={[
            ['Robot code', meta?.robotLanguage && `${meta.robotLanguage} ${meta.wpilibVersion ?? ''}`],
            ['roboRIO image', meta?.rioImage && <span className="mono">{meta.rioImage}</span>],
            [
              'Power distribution',
              log && `${pdName(log.pdType)}${log.pdCanId != null && log.pdType !== 'none' ? ` (CAN ${log.pdCanId})` : ''}`,
            ],
            ['roboRIO free memory', mem.length ? `${Math.min(...mem)} MB (lowest)` : undefined],
          ]}
        />
      ),
    },
    {
      id: 'ds',
      title: 'Driver station',
      summary:
        [meta?.dsVersion && `DS ${meta.dsVersion}`, meta && plural(meta.joysticks.length, 'controller')].filter(Boolean).join(' · ') ||
        'Not logged',
      body: (
        <>
          <Kv
            rows={[
              ['Driver Station', meta?.dsVersion],
              ['Laptop battery', meta?.rioStats.length ? `${meta.rioStats[meta.rioStats.length - 1].value.laptopBatt}%` : undefined],
            ]}
          />
          {meta && meta.joysticks.length > 0 && (
            <div className="info-list">
              {meta.joysticks.map((j) => (
                <div key={j.slot} className="info-item static">
                  <b>Port {j.slot}</b>
                  <span>{j.name}</span>
                  <span className="faint">
                    {j.axes} axes · {j.buttons} buttons · {j.povs} POVs
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ),
    },
    {
      id: 'robot-logs',
      title: 'Robot logs',
      summary: robotSummary(parsed.extras),
      body: (
        <>
          {parsed.extras.length === 0 && (
            <p className="muted info-empty">
              Nothing added yet. Add the roboRIO's .wpilog (or CTRE's, converted to .wpilog) for this match.
            </p>
          )}
          {parsed.extras.map((x) => (
            <RobotLog key={x.name} info={x} onRemove={() => ctx.removeLog(x.name)} />
          ))}
          <div className="info-actions">
            <button className="btn small" onClick={ctx.addLogs}>
              Add robot logs
            </button>
          </div>
        </>
      ),
    },
    {
      id: 'files',
      title: 'Files',
      summary: entry.key,
      body: (
        <Kv
          rows={[
            ['.dslog', entry.dslog ? `${entry.dslog.name}${entry.dslog.size ? ` · ${size(entry.dslog.size)}` : ''}` : 'Missing'],
            [
              '.dsevents',
              entry.dsevents ? `${entry.dsevents.name}${entry.dsevents.size ? ` · ${size(entry.dsevents.size)}` : ''}` : 'Missing',
            ],
            [
              'Opened from',
              {
                folder: 'The DS log folder',
                companion: 'The companion server',
                saved: 'Saved in this browser',
                upload: 'Opened files',
                sample: 'The sample log',
              }[entry.source],
            ],
            ['Still recording', log?.truncated ? 'Yes, the last record is partly written' : undefined],
            ['Warnings', parsed.warnings.join(' · ')],
          ]}
        />
      ),
    },
  ];

  const cur = Math.min(sel, items.length - 1);
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  useEffect(() => {
    rootRef.current?.querySelector('.g-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-back')) return;
    let handled = true;
    if (e.key === 'ArrowDown') setSel(Math.min(items.length - 1, cur + 1));
    else if (e.key === 'ArrowUp') setSel(Math.max(0, cur - 1));
    else if (e.key === ' ' || e.key === 'Enter') toggle(items[cur].id);
    else if (e.key === 'e') setOpen((o) => (o.length < items.length ? items.map((i) => i.id) : []));
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, []);

  return (
    <div className="page info-page" ref={rootRef}>
      <div className="g-list">
        <section className="g-sec">
          {items.map((it, i) => {
            const on = open.includes(it.id);
            return (
              <div key={it.id} className={`g-item ${on ? 'open' : ''}`}>
                <div className={`g-row info-row ${i === cur ? 'sel' : ''}`} onClick={() => (setSel(i), toggle(it.id))}>
                  <svg
                    className="g-chev"
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    style={{ transform: on ? 'rotate(90deg)' : undefined }}
                    aria-hidden="true"
                  >
                    <path
                      d="M3 1.5 6.8 5 3 8.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="g-name">{it.title}</span>
                  <span className="info-sum">{it.summary}</span>
                </div>
                {on && <div className="info-body">{it.body}</div>}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

const FIT: Record<Confidence, string> = {
  high: 'Lines up with the match',
  medium: 'Probably lines up',
  low: 'Weak match, treat with care',
  none: 'Not lined up',
};

function robotSummary(extras: ExtraInfo[]): string {
  if (!extras.length) return 'None added';
  const ok = extras.filter((x) => x.ok);
  if (!ok.length) return `${plural(extras.length, 'log')}, none readable`;
  const aligned = ok.filter((x) => x.alignment && x.alignment.confidence !== 'none').length;
  const roles = [...new Set(ok.map((x) => x.role))].join(' + ');
  return `${roles}${ok.length > 1 ? ` · ${ok.length} logs` : ''}${aligned === ok.length ? '' : ` · ${ok.length - aligned} not lined up`}`;
}

function RobotLog({ info: x, onRemove }: { info: ExtraInfo; onRemove: () => void }) {
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
      ) : (
        <>
          <p className={`robot-log-note ${a ? a.confidence : ''}`}>
            <b>{a ? FIT[a.confidence] : 'Not checked'}.</b> {a?.detail}
          </p>
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

function pdName(t: string) {
  return t === 'rev' ? 'REV PDH' : t === 'ctre' ? 'CTRE PDP' : 'No power distribution data';
}
