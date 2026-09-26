import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { computeStats, findProblems, type Problem, type Span } from '../../lib/analysis';
import { fmtSpan } from '../../lib/time';
import { Icon, type IconName } from '../Icon';
import { Navigator, TimelineLegend } from '../Navigator';
import { EventsView } from './EventsView';
import { useGroupValue, type EventFilter, type ViewCtx } from './types';

type Scope = 'focus' | 'all' | 'zoom';

const fix = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Findings the pit crew has ticked off, remembered per log on this computer. */
export function useChecked(logKey: string) {
  const storageKey = `pitview.checked.${logKey}`;
  const [checked, setChecked] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (id: string) =>
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* storage full or blocked: ticks just won't persist */
        }
        return next;
      }),
    [storageKey],
  );
  return [checked, toggle] as const;
}

/** Details: the verdict and fix list, then everything else as collapsed rows that each say what is inside. */
export function Overview({ ctx, eventFilter }: { ctx: ViewCtx; eventFilter: EventFilter & { nonce: number } }) {
  const { parsed, group, theme, tf } = ctx;
  const { log, events, analysis } = parsed;
  const range = useGroupValue(group, 'range', () => group.range);
  const zoomed = useMemo(() => group.isZoomedFrom(parsed.analysis.focus), [group, range, parsed.analysis.focus]);
  const [scope, setScope] = useState<Scope>('focus');
  const effectiveScope: Scope = scope === 'zoom' && !zoomed ? 'focus' : scope;

  const span: Span = useMemo(() => {
    if (effectiveScope === 'all') return { start: 0, end: analysis.duration };
    if (effectiveScope === 'zoom') return range;
    return analysis.focus;
  }, [effectiveScope, analysis, range]);

  const stats = useMemo(() => computeStats(log, events, analysis, span), [log, events, analysis, span]);
  const problems = useMemo(() => findProblems(log, events, analysis, stats), [log, events, analysis, stats]);
  const meta = events?.meta;
  const [checked, toggleChecked] = useChecked(ctx.entry.key);
  const fixNow = problems.filter((p) => p.severity === 'bad');
  const watch = problems.filter((p) => p.severity === 'warn');
  const notes = problems.filter((p) => p.severity === 'info');
  const openBad = fixNow.filter((p) => !checked.has(p.id)).length;
  const openWarn = watch.filter((p) => !checked.has(p.id)).length;
  // the first unticked problem starts expanded, so the answer is on screen without a click
  const firstOpen = [...fixNow, ...watch].find((p) => !checked.has(p.id))?.id ?? null;
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const openId = expanded === undefined ? firstOpen : expanded;

  // "Related messages", the errors tile and "/" all land on the Messages row
  const [msgOpen, setMsgOpen] = useState(false);
  useEffect(() => {
    if (!eventFilter.nonce) return;
    setMsgOpen(true);
    const t = setTimeout(() => document.getElementById('dsec-messages')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    return () => clearTimeout(t);
  }, [eventFilter.nonce]);
  useEffect(() => {
    const search = () => {
      setMsgOpen(true);
      setTimeout(() => {
        const el = document.getElementById('events-search');
        el?.scrollIntoView({ block: 'center' });
        el?.focus();
      }, 60);
    };
    window.addEventListener('pitview:search-messages', search);
    return () => window.removeEventListener('pitview:search-messages', search);
  }, []);

  const focusLabel = analysis.match ? analysis.match.label : analysis.runs.length ? 'Enabled time' : 'Connected time';

  const numbersSummary = [
    `Trip ${fix(stats.trip.avg)} ms`,
    `CPU ${fix(stats.cpu.avg, 0)}%`,
    `CAN ${fix(stats.can.max, 0)}% max`,
    stats.current.available ? `${fix(stats.current.peak, 0)} A peak` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const robotSummary =
    [meta?.robotLanguage && `${meta.robotLanguage} ${meta.wpilibVersion ?? ''}`.trim(), meta?.dsVersion && `DS ${meta.dsVersion}`].filter(Boolean).join(' · ') ||
    (meta?.team ? `Team ${meta.team}` : 'No .dsevents file');

  // One sentence that answers "is the robot OK?"
  let tone: 'bad' | 'warn' | 'ok';
  let headline: string;
  let sub: string;
  if (openBad) {
    tone = 'bad';
    headline = `${plural(openBad, 'thing')} to fix`;
    sub = openWarn ? `and ${openWarn} to keep an eye on` : 'before the next match';
  } else if (openWarn) {
    tone = 'warn';
    headline = fixNow.length ? 'Fixes checked' : 'Nothing critical';
    sub = `${plural(openWarn, 'thing')} to keep an eye on`;
  } else if (fixNow.length + watch.length) {
    tone = 'ok';
    headline = 'All checked';
    sub = 'Everything on the list is ticked off.';
  } else {
    tone = 'ok';
    headline = 'All good';
    sub = 'No brownouts, comms drops or code problems.';
  }
  const rowProps = (p: Problem) => ({
    p,
    ctx,
    done: checked.has(p.id),
    open: openId === p.id,
    onToggle: () => toggleChecked(p.id),
    onOpen: () => setExpanded(openId === p.id ? null : p.id),
  });

  return (
    <div className="page summary">
      <header className={`status ${tone}`}>
        <span className="status-icon">
          <Icon name={tone === 'ok' ? 'checkCircle' : tone === 'warn' ? 'alert' : 'alertCircle'} size={30} />
        </span>
        <div>
          <h2 className="status-title">{headline}</h2>
          <p className="status-sub">{sub}</p>
        </div>
      </header>

      {fixNow.length > 0 && (
        <section className="fixsec">
          <h3 className="fixsec-title">Fix now</h3>
          <ul className="fixlist">
            {fixNow.map((p) => (
              <FixRow key={p.id} {...rowProps(p)} />
            ))}
          </ul>
        </section>
      )}

      {watch.length > 0 && (
        <section className="fixsec">
          <h3 className="fixsec-title">Keep an eye on</h3>
          <ul className="fixlist">
            {watch.map((p) => (
              <FixRow key={p.id} {...rowProps(p)} />
            ))}
          </ul>
        </section>
      )}

      {log && <Kpis ctx={ctx} stats={stats} part="vitals" />}

      <div className="dsecs">
        <Section
          id="dsec-messages"
          title="Messages"
          summary={events ? `${plural(stats.events.error, 'error')} · ${plural(stats.events.warning, 'warning')}` : 'No .dsevents file'}
          open={msgOpen}
          onToggle={setMsgOpen}
        >
          <EventsView ctx={ctx} initial={eventFilter} />
        </Section>

        {notes.length > 0 && (
          <Section title="Notes" summary={notes.map((p) => p.title).join(' · ')}>
            <ul className="fixlist">
              {notes.map((p) => (
                <FixRow key={p.id} {...rowProps(p)} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Numbers" summary={numbersSummary}>
          <div className="toolbar">
            <span className="label">Looking at</span>
            <div className="seg" role="tablist">
              <button className={effectiveScope === 'focus' ? 'on' : ''} onClick={() => setScope('focus')}>
                {focusLabel}
              </button>
              <button className={effectiveScope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
                Whole log
              </button>
              {zoomed && (
                <button className={effectiveScope === 'zoom' ? 'on' : ''} onClick={() => setScope('zoom')}>
                  Zoomed range
                </button>
              )}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>
              {tf.fmt(span.start)} → {tf.fmt(span.end)} ({fmtSpan(span.end - span.start)})
            </span>
          </div>
          {log && (
            <div className="dsec-nav">
              <Navigator group={group} analysis={analysis} log={log} theme={theme} interactive={false} onJump={(t) => ctx.jumpTo(t)} height={70} />
              <TimelineLegend theme={theme} />
            </div>
          )}
          {log && <Kpis ctx={ctx} stats={stats} part="more" />}
        </Section>

        {analysis.loopCulprits.length > 0 && (
          <Section
            title="Slow loop steps"
            summary={`${analysis.loopCulprits[0].name} · up to ${(analysis.loopCulprits[0].worst * 1000).toFixed(0)} ms`}
          >
            <p className="muted dsec-note">
              From WPILib's loop timing printouts. The worst step each time the loop overran; framework entries (like robotPeriodic) include everything they call.
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Step</th>
                  <th className="r">Times worst</th>
                  <th className="r">Worst time</th>
                </tr>
              </thead>
              <tbody>
                {analysis.loopCulprits.slice(0, 8).map((c) => (
                  <tr key={c.name}>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {c.name} {c.framework && <span className="badge">framework</span>}
                    </td>
                    <td className="r">{c.count}</td>
                    <td className="r" style={{ color: c.worst > 0.02 ? 'var(--warn)' : undefined }}>
                      {(c.worst * 1000).toFixed(1)} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dsec-actions">
              <button className="btn small ghost" onClick={() => ctx.showEvents({ tag: 'tracer' })}>
                View timings
              </button>
            </div>
          </Section>
        )}

        {analysis.canDevices.length > 0 && (
          <Section
            title="CAN devices"
            summary={`${plural(analysis.canDevices.length, 'device')} reporting problems · ${plural(
              analysis.canDevices.reduce((a, d) => a + d.count, 0),
              'message',
            )}`}
          >
            <table className="data">
              <thead>
                <tr>
                  <th>Device</th>
                  <th className="r">Messages</th>
                  <th className="r">Errors</th>
                  <th className="r">First seen</th>
                </tr>
              </thead>
              <tbody>
                {analysis.canDevices.map((d) => (
                  <tr key={d.device} className="clickable" onClick={() => ctx.jumpTo(d.firstT)}>
                    <td>{d.device}</td>
                    <td className="r">{d.count}</td>
                    <td className="r">{d.errors}</td>
                    <td className="r muted">{tf.fmt(d.firstT)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dsec-actions">
              <button className="btn small ghost" onClick={() => ctx.showEvents({ tag: 'can' })}>
                View messages
              </button>
            </div>
          </Section>
        )}

        {analysis.runs.length > 0 && (
          <Section title="Enabled periods" summary={analysis.runs.length === 1 ? analysis.runs[0].label : plural(analysis.runs.length, 'period')}>
            <table className="data">
              <tbody>
                {analysis.runs.map((r, i) => (
                  <tr key={i} className="clickable" onClick={() => ctx.jumpTo((r.start + r.end) / 2, { width: r.end - r.start + 6 })}>
                    <td>
                      <b>{r.label}</b>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.autoTime > 0 && `Auto ${fmtSpan(r.autoTime)}`}
                        {r.autoTime > 0 && r.teleopTime > 0 && ' · '}
                        {r.teleopTime > 0 && `Teleop ${fmtSpan(r.teleopTime)}`}
                        {r.testTime > 0 && ` · Test ${fmtSpan(r.testTime)}`}
                      </div>
                    </td>
                    <td className="r muted">{tf.fmt(r.start)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <Section title="Robot & driver station" summary={robotSummary}>
          <dl className="kv">
            {meta?.team && (
              <>
                <dt>Team</dt>
                <dd>{meta.team}</dd>
              </>
            )}
            {meta?.eventName && (
              <>
                <dt>Event</dt>
                <dd>{meta.eventName}</dd>
              </>
            )}
            {meta?.fms && meta.fms.matchType !== 'None' && (
              <>
                <dt>FMS match</dt>
                <dd>
                  {meta.fms.matchType} {meta.fms.matchNumber}
                  {meta.fms.replay > 1 ? ` (replay ${meta.fms.replay})` : ''}
                </dd>
              </>
            )}
            {meta?.dsVersion && (
              <>
                <dt>Driver Station</dt>
                <dd>{meta.dsVersion}</dd>
              </>
            )}
            {meta?.robotLanguage && (
              <>
                <dt>Robot code</dt>
                <dd>
                  {meta.robotLanguage} {meta.wpilibVersion}
                </dd>
              </>
            )}
            {meta?.rioImage && (
              <>
                <dt>roboRIO image</dt>
                <dd className="mono" style={{ fontSize: 12 }}>
                  {meta.rioImage}
                </dd>
              </>
            )}
            {log && (
              <>
                <dt>Power distribution</dt>
                <dd>
                  {log.pdType === 'rev' ? 'REV PDH' : log.pdType === 'ctre' ? 'CTRE PDP' : 'Not logged'}
                  {log.pdCanId != null && log.pdType !== 'none' ? ` (CAN ${log.pdCanId})` : ''}
                </dd>
              </>
            )}
            {meta && meta.rioStats.length > 0 && (
              <>
                <dt>roboRIO free memory</dt>
                <dd>{Math.min(...meta.rioStats.map((s) => s.value.memMB).filter((m) => m > 0), Infinity).toString().replace('Infinity', '–')} MB (min)</dd>
                <dt>DS laptop battery</dt>
                <dd>{meta.rioStats[meta.rioStats.length - 1].value.laptopBatt}%</dd>
              </>
            )}
            {meta && meta.gameData.some((g) => g.value) && (
              <>
                <dt>Game data</dt>
                <dd>{meta.gameData.filter((g) => g.value).map((g) => `"${g.value}"`).join(', ')}</dd>
              </>
            )}
          </dl>
          {!meta && <p className="muted">Add the .dsevents file for team, match and version details.</p>}
        </Section>

        {meta && meta.joysticks.length > 0 && (
          <Section title="Controllers" summary={plural(meta.joysticks.length, 'controller')}>
            <table className="data">
              <tbody>
                {meta.joysticks.map((j) => (
                  <tr key={j.slot}>
                    <td className="faint" style={{ width: 28 }}>
                      {j.slot}
                    </td>
                    <td>{j.name}</td>
                    <td className="r faint" style={{ fontSize: 12 }}>
                      {j.axes}a · {j.buttons}b · {j.povs}p
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
      </div>
    </div>
  );
}

/** One collapsed row: a title, a one-line summary of what is inside, and a chevron. */
function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id?: string;
  title: string;
  summary: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="dsec" id={id} open={open} onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined}>
      <summary>
        <span className="dsec-title">{title}</span>
        <span className="dsec-sum">{summary}</span>
        <Icon name="chevronDown" size={18} />
      </summary>
      <div className="dsec-body">{children}</div>
    </details>
  );
}

function FixRow({
  p,
  ctx,
  done,
  open,
  onToggle,
  onOpen,
}: {
  p: Problem;
  ctx: ViewCtx;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const canGraph = p.t != null && Number.isFinite(p.t) && !!ctx.parsed.log;
  const canMessages = !!p.tag && !!ctx.parsed.events;
  return (
    <li className={`fix ${p.severity} ${done ? 'done' : ''} ${open ? 'open' : ''}`}>
      <button
        className="fix-check"
        role="checkbox"
        aria-checked={done}
        aria-label={`Mark "${p.title}" as checked`}
        title={done ? 'Checked - tap to undo' : 'Tick off once you have checked this'}
        onClick={onToggle}
      >
        {done && <Icon name="check" size={15} />}
      </button>
      <button className="fix-main" onClick={onOpen} aria-expanded={open}>
        <span className="fix-title">{p.title}</span>
        {p.fix && <span className="fix-do">{p.fix}</span>}
      </button>
      <span className="fix-chevron" aria-hidden="true">
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={18} />
      </span>
      {open && (
        <div className="fix-more">
          <p>{p.detail}</p>
          {(canGraph || canMessages) && (
            <div className="fix-links">
              {canGraph && (
                <button className="btn pill primary" onClick={() => ctx.jumpTo(p.t!, { chart: p.chart })}>
                  Show on graph
                </button>
              )}
              {canMessages && (
                <button className="btn pill" onClick={() => ctx.showEvents({ tag: p.tag })}>
                  Related messages
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Stat tiles. "vitals" = the four numbers that decide if the robot is OK to run; "more" = everything else, smaller. */
function Kpis({ ctx, stats, part }: { ctx: ViewCtx; stats: ReturnType<typeof computeStats>; part: 'vitals' | 'more' }) {
  const s = stats;
  const vClass = s.voltage.min < 7 ? 'bad' : s.voltage.min < 8 ? 'warn' : 'good';
  const tiles: {
    label: string;
    icon: IconName;
    value: string;
    unit?: string;
    sub: string;
    cls?: string;
    vital?: boolean;
    onClick: () => void;
  }[] = [
    {
      label: 'Lowest battery',
      icon: 'battery',
      value: fix(s.voltage.min, 2),
      unit: 'V',
      sub: Number.isFinite(s.voltage.minT) ? `at ${ctx.tf.fmt(s.voltage.minT)}` : '–',
      cls: vClass,
      vital: true,
      onClick: () => ctx.jumpTo(s.voltage.minT, { chart: 'voltage' }),
    },
    {
      label: 'Resting battery',
      icon: 'battery',
      value: fix(s.voltage.resting, 2),
      unit: 'V',
      sub: 'before enabling',
      cls: s.voltage.resting < 12 ? 'bad' : s.voltage.resting < 12.3 ? 'warn' : undefined,
      onClick: () => ctx.jumpTo(stats.span.start, { chart: 'voltage' }),
    },
    {
      label: 'Brownouts',
      icon: 'zap',
      value: String(s.brownouts.count),
      sub: s.brownouts.count ? `${fmtSpan(s.brownouts.duration)} total` : 'none',
      cls: s.brownouts.count ? 'bad' : 'good',
      vital: true,
      onClick: () => ctx.jumpTo(Number.isFinite(s.brownouts.firstT) ? s.brownouts.firstT : s.voltage.minT, { chart: 'voltage' }),
    },
    {
      label: 'Comms drops',
      icon: 'wifiOff',
      value: String(s.comms.drops),
      sub: s.comms.drops ? `${s.comms.enabledDrops} while enabled · ${fmtSpan(s.comms.dropTime)}` : 'none',
      cls: s.comms.enabledDrops ? 'bad' : s.comms.drops ? 'warn' : 'good',
      vital: true,
      onClick: () => ctx.jumpTo(Number.isFinite(s.comms.firstDropT) ? s.comms.firstDropT : stats.span.start, { chart: 'comms' }),
    },
    {
      label: 'Code not responding',
      icon: 'cpu',
      // total time is what hurts; a count of tiny blips looks scarier than it is
      value: s.codeStalls.count ? fix(s.codeStalls.duration, 1) : '0',
      unit: s.codeStalls.count ? 's' : undefined,
      sub: s.codeStalls.count ? `${s.codeStalls.count} gap${s.codeStalls.count === 1 ? '' : 's'} · longest ${fmtSpan(s.codeStalls.longest)}` : 'none',
      cls: s.codeStalls.longest >= 1 ? 'bad' : s.codeStalls.enabledCount >= 3 ? 'warn' : 'good',
      vital: true,
      onClick: () => ctx.jumpTo(Number.isFinite(s.codeStalls.longestT) ? s.codeStalls.longestT : stats.span.start, { chart: 'cpu' }),
    },
    {
      label: 'Trip time',
      icon: 'activity',
      value: fix(s.trip.avg),
      unit: 'ms',
      sub: `p95 ${fix(s.trip.p95)} · max ${fix(s.trip.max)} ms`,
      cls: s.trip.p95 > 25 ? 'warn' : undefined,
      onClick: () => ctx.jumpTo(s.trip.maxT, { chart: 'comms' }),
    },
    {
      label: 'roboRIO CPU',
      icon: 'cpu',
      value: fix(s.cpu.avg, 0),
      unit: '%',
      sub: `avg · max ${fix(s.cpu.max, 0)}%`,
      cls: s.cpu.avg >= 85 ? 'warn' : undefined,
      onClick: () => ctx.jumpTo(s.cpu.maxT, { chart: 'cpu' }),
    },
    {
      label: 'CAN utilization',
      icon: 'gauge',
      value: fix(s.can.max, 0),
      unit: '%',
      sub: `max · avg ${fix(s.can.avg, 0)}%`,
      cls: s.can.max >= 90 ? 'warn' : undefined,
      onClick: () => ctx.jumpTo(s.can.maxT, { chart: 'cpu' }),
    },
  ];
  if (s.current.available)
    tiles.push({
      label: 'Peak current',
      icon: 'bolt',
      value: fix(s.current.peak, 0),
      unit: 'A',
      sub: `avg ${fix(s.current.avg, 0)} A · ${fix(s.current.ah, 2)} Ah used`,
      onClick: () => ctx.jumpTo(s.current.peakT, { chart: 'current' }),
    });
  if (ctx.parsed.events)
    tiles.push({
      label: 'Messages',
      icon: 'list',
      value: String(s.events.error),
      unit: s.events.error === 1 ? 'error' : 'errors',
      sub: `${s.events.warning} warnings · ${s.events.print} prints`,
      cls: s.events.error ? 'warn' : undefined,
      onClick: () => ctx.showEvents({ kind: 'error' }),
    });

  const shown = tiles.filter((t) => (part === 'vitals' ? t.vital : !t.vital));
  return (
    <div className={`kpis ${part === 'vitals' ? 'vitals' : 'kpis-compact'}`}>
      {shown.map((t) => (
        <button key={t.label} className={`kpi ${t.cls ?? ''}`} onClick={t.onClick}>
          <span className="k-label">
            <Icon name={t.icon} size={13} /> {t.label}
          </span>
          <span className="k-value">
            {t.value}
            {t.unit && <small>{t.unit}</small>}
          </span>
          <span className="k-sub">{t.sub}</span>
        </button>
      ))}
    </div>
  );
}
