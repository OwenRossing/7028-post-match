import { useMemo } from 'react';
import { problemStops, stepProblem, type Mode, type Problem, type Span } from '../../lib/analysis';
import { collapseRepeats } from '../../lib/chartGroup';
import { Icon } from '../Icon';
import { useGroupValue, type ViewCtx } from './types';

const MODE_LABEL: Record<Mode, string> = { disabled: 'Disabled', auto: 'Auto', teleop: 'Teleop', test: 'Test' };

/** The shaded bands on the charts, in words. */
const BAND = {
  brownout: { title: 'Brownout', severity: 'bad', text: 'Battery voltage sagged low enough that the roboRIO cut power to the motors.' },
  noComms: { title: 'No comms', severity: 'bad', text: 'The Driver Station could not hear from the robot.' },
  stall: { title: 'Robot code not responding', severity: 'warn', text: 'The robot was connected but its code stopped reporting, from a slow loop or stuck code.' },
} as const;

const inSpan = (spans: Span[], t: number) => spans.find((s) => t >= s.start - 0.02 && t <= s.end + 0.02);
const oneLine = (s: string) => s.split('\n')[0].trim();

/**
 * Graphs: one fixed-height card. With nothing pinned it lists the problems as chips;
 * once a time is pinned it says what is going on there. It is always the same size,
 * so clicking never moves the charts.
 */
export function Moment({ ctx, draw }: { ctx: ViewCtx; draw?: (t: number) => { top: { name: string; amps: number }[]; total: number; volts: number } }) {
  const { group, parsed, tf, problems } = ctx;
  const { events, analysis } = parsed;
  const pinned = useGroupValue(group, 'pin', () => group.pinned);

  const list = useMemo(() => problemStops(problems), [problems]);
  const active = pinned == null ? undefined : list.find((p) => Math.abs(p.t - pinned) < 0.05);
  const goto = (p: Problem & { t: number }) => ctx.jumpTo(p.t, { chart: p.chart, width: 12 });
  const prev = pinned == null ? undefined : stepProblem(list, pinned, -1);
  const next = pinned == null ? undefined : stepProblem(list, pinned, 1);

  const bands = useMemo(() => {
    if (pinned == null) return [];
    const pairs = [
      ['brownout', analysis.brownouts],
      ['noComms', analysis.noComms],
      ['stall', analysis.codeStalls],
    ] as const;
    return pairs.flatMap(([k, spans]) => (inSpan(spans, pinned) ? [BAND[k]] : []));
  }, [pinned, analysis]);
  const mode = pinned == null ? undefined : analysis.modes.find((m) => pinned >= m.start && pinned < m.end)?.mode;

  const drawn = useMemo(() => (pinned == null ? undefined : draw?.(pinned)), [pinned, draw]);

  const near = useMemo(() => {
    if (pinned == null || !events) return { shown: [], more: 0 };
    const all = collapseRepeats(
      events.events
        .filter((e) => Math.abs(e.t - pinned) <= 2 && e.kind !== 'print' && !e.tags.includes('tracer'))
        .sort((a, b) => Math.abs(a.t - pinned) - Math.abs(b.t - pinned)),
      (e) => oneLine(e.text),
    );
    return { shown: all.slice(0, 3).sort((a, b) => a[0].t - b[0].t), more: Math.max(0, all.length - 3) };
  }, [pinned, events]);

  // a click that is not exactly on a problem still borrows the closest one within 2 s, unless it is inside a shaded band
  const close =
    active || bands.length || pinned == null
      ? undefined
      : list.filter((p) => Math.abs(p.t - pinned) <= 2).sort((a, b) => Math.abs(a.t - pinned) - Math.abs(b.t - pinned))[0];
  const shown = active ?? close;
  const sev = shown?.severity ?? bands[0]?.severity ?? 'ok';
  const title = shown?.title ?? bands[0]?.title ?? 'Nothing flagged at this time';
  const text = shown?.detail ?? (bands.length ? bands.map((b) => b.text).join(' ') : 'Click another spot to look somewhere else.');

  return (
    <div className={`moment ${pinned == null ? 'idle' : ''}`}>
      {pinned == null ? (
        <>
          <div className="mo-hint">
            <Icon name="target" size={20} />
            <div title="Triangles are errors and warnings. Hover one to read it, click it to see what was going on.">
              <b>{list.length ? 'Pick a problem' : 'Nothing flagged'}</b>
              <span>or click a chart or triangle</span>
            </div>
          </div>
          {list.length > 0 && (
            <div className="mo-chips" aria-label="Problems in this log">
              {list.map((p) => (
                <button key={p.id} className="mo-chip" onClick={() => goto(p)} title={p.title}>
                  <span className={`mo-light ${p.severity}`} />
                  <span className="mo-chip-text">{p.title}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mo-main">
            <div className="mo-head">
              <span className={`mo-light ${sev}`} />
              <b className="mo-title">{title}</b>
              <span className="mo-time">
                {tf.fmt(pinned)}
                {mode && ` · ${MODE_LABEL[mode]}`}
              </span>
            </div>
            <p className={`mo-text ${drawn?.top.length ? 'one' : ''}`} title={text}>
              {text}
            </p>
            {drawn && drawn.top.length > 0 && (
              <p className="mo-draw" title={drawn.top.map((d) => `${d.name} ${d.amps.toFixed(0)} A`).join(', ')}>
                Drawing then: {drawn.top.map((d, k) => [k ? ' · ' : '', <b key={d.name}>{d.name}</b>, ` ${d.amps.toFixed(0)} A`])}
                {Number.isFinite(drawn.total) && ` · ${drawn.total.toFixed(0)} A total`}
                {Number.isFinite(drawn.volts) && ` · ${drawn.volts.toFixed(1)} V`}
              </p>
            )}
          </div>
          {near.shown.length > 0 && (
            <div className="mo-side">
              {near.shown.map(([e, n]) => (
                <div key={e.id} className="mo-msg" title={oneLine(e.text)}>
                  <span className={`ev-kind k-${e.kind}`} />
                  <b>{tf.fmt(e.t).replace(/\.\d+$/, (m) => m.slice(0, 2))}</b> {oneLine(e.text)}
                  {n > 1 && <span className="mo-n"> ×{n}</span>}
                </div>
              ))}
              {near.more > 0 && <div className="mo-more">+{near.more} more nearby</div>}
            </div>
          )}
          <div className="mo-actions">
            {list.length > 0 && (
              <>
                <button className="btn icon round" disabled={!prev} onClick={() => prev && goto(prev)} title="Previous problem" aria-label="Previous problem">
                  <Icon name="chevronLeft" size={16} />
                </button>
                <button className="btn icon round" disabled={!next} onClick={() => next && goto(next)} title="Next problem" aria-label="Next problem">
                  <Icon name="chevronRight" size={16} />
                </button>
              </>
            )}
            <button className="btn icon round" onClick={() => group.pin(null, false)} title="Clear (Esc)" aria-label="Clear the selected time">
              <Icon name="x" size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
