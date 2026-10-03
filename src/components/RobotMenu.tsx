import { useEffect, useState } from 'react';
import type { RobotListing } from '../lib/companion';
import { type DesktopBridge, type DesktopSettings } from '../lib/desktop';
import { Icon } from './Icon';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One plain sentence about the robot-log folder: what is in it and what Owlet is doing. */
export function robotSummaryText(r: RobotListing): string {
  const hoots = r.items.filter((i) => i.kind === 'hoot');
  const count = (s: string) => hoots.filter((i) => i.state === s).length;
  const parts = [plural(r.items.filter((i) => i.kind === 'wpilog').length, '.wpilog'), plural(hoots.length, '.hoot')];
  if (count('converting') + count('queued')) parts.push(`${count('converting') + count('queued')} converting`);
  if (count('failed')) parts.push(`${count('failed')} failed`);
  if (count('needs-owlet')) parts.push(`${count('needs-owlet')} waiting for Owlet`);
  return parts.join(' · ');
}

/** What the companion reports about the robot-log folder and Owlet, with the user's hidden logs. */
export function RobotStatus({ robot, hidden, onShowHidden }: { robot: RobotListing | null; hidden: number; onShowHidden: () => void }) {
  if (!robot) return null;
  return (
    <>
      <div className="menu-note">
        <b>Robot logs</b>: {robot.dir ? <span className="menu-path">{robot.dir}</span> : 'no folder set (start the companion with --robot-dir)'}
        {robot.dir && (
          <>
            <br />
            {robotSummaryText(robot)}
          </>
        )}
        <br />
        <b>Owlet</b>: {robot.owlet.found ? <span className="menu-path">{robot.owlet.path}</span> : 'not found, so hoots wait'}
      </div>
      {hidden > 0 && (
        <button className="item" onClick={onShowHidden}>
          <Icon name="refresh" /> Show {plural(hidden, 'hidden robot log')}
        </button>
      )}
    </>
  );
}

/** Folder and Owlet controls in the desktop app, where the page can ask for real dialogs. */
export function DesktopMenu({ bridge, robot, hidden, onShowHidden }: { bridge: DesktopBridge; robot: RobotListing | null; hidden: number; onShowHidden: () => void }) {
  const [s, setS] = useState<DesktopSettings | null>(null);
  useEffect(() => {
    void bridge.settings().then(setS);
  }, [bridge, robot?.owlet.path, robot?.dir]);
  const failed = robot?.items.some((i) => i.state === 'failed');
  return (
    <>
      <div className="menu-label">Folders</div>
      <div className="menu-note">
        <b>Driver Station logs</b>
        <br />
        <span className="menu-path">{s?.dsDir ?? '…'}</span>
      </div>
      <button className="item" onClick={() => void bridge.chooseFolder('ds').then(setS)}>
        <Icon name="folder" /> Change Driver Station folder…
      </button>
      <div className="menu-note">
        <b>Robot logs</b> (copy the roboRIO's .wpilog and .hoot files here)
        <br />
        <span className="menu-path">{s?.robotDir ?? '…'}</span>
        {robot && (
          <>
            <br />
            {robotSummaryText(robot)}
          </>
        )}
      </div>
      <button className="item" onClick={() => void bridge.chooseFolder('robot').then(setS)}>
        <Icon name="folder" /> Change robot logs folder…
      </button>
      <button className="item" onClick={() => void bridge.openFolder('robot')}>
        <Icon name="external" /> Open the robot logs folder
      </button>
      <div className="menu-note">
        <b>Owlet</b> (turns .hoot into .wpilog): {s ? (s.owlet.found ? <span className="menu-path">{s.owlet.path}</span> : 'not found, so hoots wait') : '…'}
        {s && !s.owlet.found && s.owlet.suggested && (
          <>
            <br />
            Found in Downloads: <span className="menu-path">{s.owlet.suggested}</span>
          </>
        )}
        {s && !s.owlet.found && !s.owlet.suggested && s.owlet.hint && (
          <>
            <br />
            {s.owlet.hint}
          </>
        )}
      </div>
      {s && !s.owlet.found && s.owlet.suggested && (
        <button className="item" onClick={() => void bridge.useDownloadedOwlet('menu').then(setS)}>
          <Icon name="cpu" /> Use the Owlet from Downloads…
        </button>
      )}
      {s && !s.owlet.found && (
        <button className="item" onClick={() => void bridge.getOwlet()}>
          <Icon name="external" /> Get Owlet from CTRE…
        </button>
      )}
      <button className="item" onClick={() => void bridge.locateOwlet().then(setS)}>
        <Icon name="cpu" /> {s?.owlet.found ? 'Change Owlet…' : 'Locate Owlet…'}
      </button>
      {failed && (
        <button className="item" onClick={() => void bridge.retryConversions()}>
          <Icon name="refresh" /> Try the failed conversions again
        </button>
      )}
      {hidden > 0 && (
        <button className="item" onClick={onShowHidden}>
          <Icon name="refresh" /> Show {plural(hidden, 'hidden robot log')}
        </button>
      )}
    </>
  );
}
