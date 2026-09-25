import { useEffect } from 'react';
import { DS_LOG_PATH } from '../lib/folder';
import { Icon } from './Icon';

const SHORTCUTS: [string, string][] = [
  ['L', 'Open the latest match'],
  ['1 – 5', 'Summary · Graphs · Messages · Power · Details'],
  ['Esc', 'Back to Summary'],
  ['← → ↑ ↓', 'Summary: move around the robot map'],
  ['Enter', 'Summary: show that part on the graphs'],
  ['Space', 'Summary: mark a part as checked'],
  ['N', 'Summary: next part with a problem'],
  ['M', 'Summary: messages for that part'],
  ['A  T  M  F', 'Graphs: zoom to auto / teleop / match / all'],
  ['+  −   ← →', 'Graphs: zoom and pan'],
  ['J  K', 'Next / previous error or warning'],
  ['/', 'Messages: search'],
  ['[  ]', 'Previous / next log'],
  ['O', 'Open log files'],
  ['S', 'Your logs'],
  ['D', 'Light / dark'],
  ['?', 'This help'],
];

const GLOSSARY: [string, string][] = [
  ['Battery voltage', 'Measured by the roboRIO. A fresh battery rests around 12.8–13.2 V. Heavy driving pulls it down; below ~6.8 V the roboRIO browns out.'],
  ['Brownout', 'The roboRIO turns off motor outputs to protect itself when voltage gets too low. The robot suddenly goes limp for a moment.'],
  ['Trip time', 'How long a packet takes to go DS → robot → DS. A few milliseconds is normal; spikes mean network trouble.'],
  ['Packet loss', 'Share of DS packets that never got an answer. Sustained loss causes laggy or jerky driving.'],
  ['No robot comms', 'The DS heard nothing from the robot (gray bands). Radio power, ethernet cables or a roboRIO reboot are the usual suspects.'],
  ['Code not responding', 'The robot was connected, but the robot program did not report its mode (orange strip). Slow loops, blocking calls or a code crash cause this.'],
  ['CAN utilization', 'How busy the roboRIO CAN bus is. Above ~90% devices start missing messages.'],
  ['Loop overrun', 'Robot code took longer than its 20 ms period. WPILib prints which step was slow; PitView highlights the worst.'],
  ['Rail faults', 'The roboRIO shut off one of its own 12V / 5V / 3.3V outputs because something connected to it shorted or drew too much.'],
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Help">
        <div className="modal-head">
          <h2>PitView help</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <h3>Getting logs in</h3>
          <p style={{ margin: 0 }}>
            The Driver Station saves a <code>.dslog</code> (telemetry every 20 ms) and a <code>.dsevents</code> (messages) for
            each session in <code>{DS_LOG_PATH}</code>. Drop both files for the full picture. On the DS laptop in Chrome or Edge,
            use <b>Connect DS</b> to watch that folder: PitView picks up new matches automatically, and you can install it
            (address bar → Install) to work offline in the pits and open <code>.dslog</code> files by double-clicking them.
          </p>
          <p style={{ marginBottom: 0 }}>
            <b>Companion server (optional):</b> run <code>npm run companion</code> on the DS laptop to serve PitView and the
            live log folder to other devices on the same network (add <code>--lan</code>). Other laptops can then open{' '}
            <code>http://&lt;ds-laptop-ip&gt;:5801</code>.
          </p>

          <h3>Keyboard shortcuts</h3>
          <div className="shortcuts">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k}>
                <span className="muted">{d}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>

          <h3>On the graphs</h3>
          <p style={{ margin: 0 }} className="muted">
            Drag across a chart to zoom. <kbd>Ctrl</kbd> + scroll zooms around the cursor, <kbd>Shift</kbd> + drag or
            sideways scroll pans, double-click resets. Click to pin a time on every chart. Drag the window on the timeline
            strip to move around.
          </p>

          <h3>What the signals mean</h3>
          <div className="glossary">
            {GLOSSARY.map(([t, d]) => (
              <div key={t}>
                <b>{t}</b>
                <span>{d}</span>
              </div>
            ))}
          </div>

          <h3>Privacy</h3>
          <p style={{ margin: 0 }} className="muted">
            Logs are parsed on this device. Files you open are kept in this browser's storage so they are there offline; clear
            them from the bottom of the library.
          </p>
        </div>
      </div>
    </div>
  );
}
