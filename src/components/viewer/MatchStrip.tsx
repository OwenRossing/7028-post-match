import type { Span } from '../../lib/analysis';
import type { Instance } from '../../lib/board';
import type { Tone } from './Board';
import type { ViewCtx } from './types';

/** The match as one thin bar: auto, teleop, dropouts and brownouts, plus where the selected row happened. */
export function MatchStrip({
  ctx,
  range,
  marks,
  active,
  tone,
}: {
  ctx: ViewCtx;
  range: Span;
  marks: Instance[];
  active: number;
  tone: Tone;
}) {
  const { analysis } = ctx.parsed;
  const span = Math.max(range.end - range.start, 1e-6);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - range.start) / span) * 100));
  const seg = (s: Span) => ({ left: `${pct(s.start)}%`, width: `${Math.max(pct(s.end) - pct(s.start), 0.15)}%` });
  const inRange = (s: Span) => s.end > range.start && s.start < range.end;
  const m = analysis.match;
  const labels: [number, string][] = [];
  if (m?.autoStart != null) labels.push([m.autoStart, 'Auto']);
  if (m?.teleopStart != null) labels.push([m.teleopStart, 'Teleop']);

  return (
    <div className="mstrip" aria-hidden="true">
      <div className="mstrip-track">
        {analysis.modes
          .filter((s) => s.mode !== 'disabled' && inRange(s))
          .map((s, i) => (
            <i key={`m${i}`} className={`ms-seg ${s.mode}`} style={seg(s)} />
          ))}
        {analysis.noComms.filter(inRange).map((s, i) => (
          <i key={`n${i}`} className="ms-seg nocomms" style={seg(s)} />
        ))}
        {analysis.brownouts.filter(inRange).map((s, i) => (
          <i key={`b${i}`} className="ms-seg brownout" style={seg(s)} />
        ))}
        {marks
          .slice(0, 400)
          .map((x, i) =>
            x.end != null && x.end - x.t > span / 200 ? (
              <i
                key={`x${i}`}
                className={`ms-mark span ${tone ?? ''} ${i === active ? 'on' : ''}`}
                style={seg({ start: x.t, end: x.end })}
              />
            ) : (
              <i key={`x${i}`} className={`ms-mark ${tone ?? ''} ${i === active ? 'on' : ''}`} style={{ left: `${pct(x.t)}%` }} />
            ),
          )}
      </div>
      <div className="mstrip-labels">
        {labels.map(([t, l]) => (
          <span key={l} style={{ left: `${pct(t)}%` }}>
            {l}
          </span>
        ))}
        <span className="end">{ctx.tf.fmt(range.end).replace(/\.\d+$/, '')}</span>
      </div>
    </div>
  );
}
