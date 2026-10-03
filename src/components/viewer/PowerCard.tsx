import { useState } from 'react';
import { diagnosticsText } from '../../lib/diagnostics';
import { canStaleCount, pdStatus, sortRows, type PowerReport, type PowerSort, type PowerSource } from '../../lib/power';
import { CopyDiagnostics } from './CopyDiagnostics';
import type { ViewCtx } from './types';

const SORTS: [PowerSort, string, string][] = [
  ['low', 'At the low point', "What each drew when the battery was lowest: the ones that pulled it down"],
  ['peak', 'Peak', 'The most each drew at any moment while enabled'],
  ['used', 'Total used', 'Charge each drew while enabled, in amp-hours'],
];
const SHOWN = 8;
const a0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '–');

/**
 * Graphs: who used the battery. Ranks every power channel and motor current by what it drew when the battery was at its
 * lowest, at its peak and in total, and says so plainly when there is nothing to rank (and why).
 */
export function PowerCard({ ctx, sources, report }: { ctx: ViewCtx; sources: PowerSource[]; report: PowerReport }) {
  const { parsed, tf } = ctx;
  const log = parsed.log!;
  const [by, setBy] = useState<PowerSort>('low');
  const [all, setAll] = useState(false);
  const pd = pdStatus(log);
  const stale = canStaleCount(parsed.events?.events);
  const lowT = report.low ? report.low.index * log.period : null;

  if (!sources.length)
    return (
      <div className="card power-card">
        <div className="card-body">
          <h2 className="pw-title">Who drew the power: nothing to rank yet</h2>
          <p className="pw-line">
            <b>Driver Station log:</b> {pd.text}
          </p>
          <p className="pw-line">
            <b>Robot logs:</b>{' '}
            {parsed.extras.length
              ? 'attached, but none had motor currents PitView recognises on the match timeline. Copy diagnostics lists every signal name, so the detection can be fixed.'
              : 'none attached.'}
          </p>
          <p className="pw-line">To see which motor is pulling the power you need one of:</p>
          <ul className="pw-list">
            {pd.kind === 'frozen' ? (
              <li>
                <b>Get the board talking.</b> The roboRIO knows a board is at CAN ID {log.pdCanId ?? '?'} but never got a reading from it. Check that the ID in the robot's code matches the board's
                (<code>new PowerDistribution({log.pdCanId ?? 1}, ModuleType.kRev)</code>, or <code>(0, ModuleType.kCTRE)</code> for a CTRE PDP; the REV Hardware Client shows and sets a PDH's ID), that the CAN
                wires to it are seated and the bus is terminated, and that the board appears in the REV Hardware Client.
                {stale > 0 && (
                  <>
                    {' '}
                    This log also has <b>{stale}</b> “CAN … stale / not received” messages: some device on the CAN bus is not answering (they do not say which).{' '}
                    <button className="link" onClick={() => ctx.showEvents({ text: 'stale' })}>
                      Show them
                    </button>
                  </>
                )}
              </li>
            ) : (
              <li>
                <b>The power distribution board's channels.</b> With a REV PDH the Driver Station usually only records them when the robot's code creates a <code>PowerDistribution</code> object
                (<code>new PowerDistribution(1, ModuleType.kRev)</code>, or <code>(0, ModuleType.kCTRE)</code> for a CTRE PDP) and the board is on the CAN bus.
              </li>
            )}
            <li>
              <b>Motor currents in a robot log:</b> Phoenix 6 SignalLogger (the <code>.hoot</code>, converted by Owlet; its <code>SupplyCurrent</code> is what each motor draws from the battery), or your robot code
              logging each controller's output current. Attach it to this match.
            </li>
          </ul>
          <CopyDiagnostics build={() => diagnosticsText(ctx.entry, parsed)} label="Copy diagnostics" note="What this log contains, so what is missing can be worked out. Numbers only, no messages." />
        </div>
      </div>
    );

  const rows = sortRows(report.rows, by).filter((r) => r.peak >= 1);
  const shown = all ? rows : rows.slice(0, SHOWN);
  const top = rows.length ? Math.max(1, ...rows.map((r) => (by === 'low' ? r.atLow : by === 'peak' ? r.peak : r.ah)).filter(Number.isFinite)) : 1;

  return (
    <div className="card power-card">
      <div className="card-body">
        <div className="pw-head">
          <h2 className="pw-title">Who drew the power</h2>
          <div className="seg" aria-label="Rank by">
            {SORTS.map(([k, label, tip]) => (
              <button key={k} className={by === k ? 'on' : ''} onClick={() => setBy(k)} title={tip}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {report.low ? (
          <p className="pw-line">
            Battery lowest at <b>{tf.fmt(lowT!)}</b>: <b>{report.low.volts.toFixed(2)} V</b>
            {report.total != null && (
              <>
                , with up to <b>{report.total.toFixed(0)} A</b> drawn within 0.1 s of it{report.totalIsSum ? ' (the sum of what is listed)' : ''}
              </>
            )}
            .{' '}
            <button className="link" onClick={() => ctx.jumpTo(lowT!, { width: 12 })}>
              Go there
            </button>
          </p>
        ) : (
          <p className="pw-line">No battery voltage was recorded while the robot was connected.</p>
        )}
        {pd.kind !== 'ok' && <p className="pw-line pw-note">Driver Station log: {pd.text} These are the robot logs' motor currents.</p>}
        <table className="pw-table">
          <thead>
            <tr>
              <th>Motor or channel</th>
              <th title="What it drew within 0.1 s of the battery's low point">At the low point</th>
              <th>Peak</th>
              <th title="Average while enabled">Average</th>
              <th title="Charge drawn while enabled">Used</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const key = by === 'low' ? r.atLow : by === 'peak' ? r.peak : r.ah;
              return (
                <tr key={r.source.id} onClick={() => ctx.jumpTo(by === 'low' && lowT != null ? lowT : r.peakAt * log.period, { signal: r.source.id, width: 12 })} title="Show its chart">
                  <td className="pw-name">
                    <span className="pw-bar" style={{ width: `${Math.max(2, (100 * (Number.isFinite(key) ? key : 0)) / top)}%` }} />
                    <span className="pw-label">
                      {r.source.name}
                      {r.source.note && (
                        <small className="pw-warn" title={r.source.note}>
                          {' '}
                          stator
                        </small>
                      )}
                    </span>
                  </td>
                  <td className={by === 'low' ? 'pw-key' : ''}>{a0(r.atLow)} A</td>
                  <td className={by === 'peak' ? 'pw-key' : ''}>{a0(r.peak)} A</td>
                  <td>{r.mean.toFixed(1)} A</td>
                  <td className={by === 'used' ? 'pw-key' : ''}>{r.ah.toFixed(2)} Ah</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="pw-empty">
                  Nothing drew a full amp while the robot was enabled.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length > SHOWN && (
          <button className="link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
