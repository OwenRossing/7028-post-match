import type { LogEntry } from '../lib/library';

const SHORT: Record<string, string> = { roboRIO: 'Rio', 'CTRE Phoenix': 'CTRE', AdvantageKit: 'AK', 'Robot log': 'Robot' };

/**
 * Which logs a match is made of, at a glance: the Driver Station's two files and each robot log by who wrote it.
 * With `showMissing`, what is not there yet shows as a dashed chip.
 */
export function FileChips({
  entry: e,
  compact = false,
  showMissing = false,
  onAddRobot,
}: {
  entry: LogEntry;
  compact?: boolean;
  showMissing?: boolean;
  onAddRobot?: () => void;
}) {
  const roles = new Map<string, number>();
  for (const x of e.extras ?? []) roles.set(x.role ?? 'Robot log', (roles.get(x.role ?? 'Robot log') ?? 0) + 1);
  const chip = (key: string, label: string, on: boolean, title: string) =>
    on || showMissing ? (
      <span key={key} className={`chip ${on ? 'on' : 'missing'}`} title={title}>
        {label}
      </span>
    ) : null;
  return (
    <span className="chips">
      {chip('ds', compact ? 'DS' : 'Driver Station', !!e.dslog, e.dslog ? e.dslog.name : 'No .dslog yet. Drop it anywhere and it joins this match if it belongs.')}
      {chip('msgs', compact ? 'Msgs' : 'Messages', !!e.dsevents, e.dsevents ? e.dsevents.name : 'No .dsevents yet. Drop it anywhere and it joins this match if it belongs.')}
      {[...roles].map(([role, n]) => (
        <span key={role} className="chip on" title={(e.extras ?? []).filter((x) => (x.role ?? 'Robot log') === role).map((x) => x.file.name).join('\n')}>
          {compact ? (SHORT[role] ?? role) : role}
          {n > 1 ? ` ×${n}` : ''}
        </span>
      ))}
      {showMissing && !roles.size &&
        (onAddRobot ? (
          <button className="chip missing add" onClick={onAddRobot} title="Add the roboRIO's .wpilog for this match">
            {compact ? 'Robot' : 'Robot log'} +
          </button>
        ) : (
          <span className="chip missing">{compact ? 'Robot' : 'Robot log'}</span>
        ))}
    </span>
  );
}
