import { useState } from 'react';
import { DS_LOG_PATH } from '../lib/folder';
import { updateSettings, type Settings } from '../lib/settings';
import type { ThemePref } from '../lib/theme';
import type { Library } from '../lib/useLibrary';
import { Icon } from './Icon';
import { Scrim } from './Scrim';

interface Props {
  library: Library;
  settings: Settings;
  onOpenFiles: () => void;
  onLatestMatch: () => void;
  onHelp: () => void;
  onToggleSidebar: () => void;
  onHome: () => void;
  hasMatches: boolean;
  logCount: number;
  drawerOpen: boolean;
  /** Where the open log puts its title and tabs, so the viewer needs no second header row. */
  slotRef: (el: HTMLDivElement | null) => void;
  viewing: boolean;
}

/**
 * Three things on the bar: your logs, the latest match, open files. Everything
 * else (DS folder, companion, theme, help) lives in the ⋯ menu.
 */
export function TopBar({ library, settings, onOpenFiles, onLatestMatch, onHelp, onToggleSidebar, onHome, hasMatches, logCount, drawerOpen, slotRef, viewing }: Props) {
  const [menu, setMenu] = useState(false);
  const [url, setUrl] = useState(settings.companionUrl);
  const { folder, companion } = library;
  const watching = folder.status === 'connected' || companion.status === 'connected';

  return (
    <header className={`topbar ${viewing ? 'viewing' : ''}`}>
      <button className={`btn quiet ${drawerOpen ? 'active' : ''}`} onClick={onToggleSidebar} title="Your logs (S)" aria-expanded={drawerOpen}>
        <Icon name="list" size={17} />
        <span className="hide-xs">Logs</span>
        {logCount > 0 && <span className="count-quiet">{logCount}</span>}
      </button>
      <button className="brand" onClick={onHome} title="Home">
        <img src="./favicon.svg" alt="" />
        <span className="brand-name">PitView</span>
      </button>

      <div className="topbar-slot" ref={slotRef} />

      {folder.status === 'needs-permission' && (
        <button className="btn pill warn-pill" onClick={() => library.reconnectFolder()} title="The browser needs your OK to read the folder again">
          Reconnect DS folder
        </button>
      )}
      {hasMatches && (
        <button className="btn pill primary latest-btn" onClick={onLatestMatch} title="Open the most recent match (L)">
          <span className="hide-xs">Latest match</span>
          <span className="show-xs">Latest</span>
        </button>
      )}
      <button className={`btn pill ${hasMatches ? '' : 'primary'}`} onClick={onOpenFiles} title="Open .dslog / .dsevents files (O)">
        Open
      </button>

      <div className="menu-wrap">
        <button className="btn icon round" onClick={() => setMenu((m) => !m)} title="Driver Station folder, theme, help" aria-label="Menu">
          <Icon name="more" size={18} />
          {watching && <span className="live-dot corner" title="Watching the Driver Station" />}
        </button>
        {menu && (
          <>
            <Scrim onClose={() => setMenu(false)} />
            <div className="menu" style={{ width: 330 }}>
              <div className="menu-label">Driver Station</div>
              {folder.status === 'connected' ? (
                <>
                  <div className="menu-note">
                    <span className="live-dot" /> Watching <b>{folder.name}</b>. New matches open by themselves.
                  </div>
                  <button className="item" onClick={() => library.rescanFolder()}>
                    <Icon name="refresh" /> Check for new logs now
                  </button>
                  <button
                    className="item"
                    onClick={() => {
                      setMenu(false);
                      void library.disconnectFolder();
                    }}
                  >
                    <Icon name="x" /> Stop watching
                  </button>
                </>
              ) : folder.status !== 'unsupported' ? (
                <button
                  className="item"
                  onClick={() => {
                    setMenu(false);
                    void library.connectFolder();
                  }}
                >
                  <Icon name="folder" />
                  <span>
                    Watch the DS log folder
                    <small>{DS_LOG_PATH}</small>
                  </span>
                </button>
              ) : (
                <div className="menu-note">Watching a folder needs Chrome or Edge. You can still drop files anywhere on the page.</div>
              )}
              <label className="item">
                <input type="checkbox" checked={settings.autoFollow} onChange={(e) => updateSettings({ autoFollow: e.target.checked })} />
                <span>
                  Open new matches automatically
                  <small>Jump to each match as the DS records it</small>
                </span>
              </label>
              {companion.status === 'connected' ? (
                <>
                  <div className="menu-note">
                    Companion server at <b>{companion.url}</b>
                  </div>
                  <button
                    className="item"
                    onClick={() => {
                      setMenu(false);
                      library.disconnectCompanion();
                    }}
                  >
                    <Icon name="x" /> Disconnect companion
                  </button>
                </>
              ) : (
                <details className="menu-details">
                  <summary>Companion server (other devices)</summary>
                  <form
                    className="menu-note"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      updateSettings({ companionUrl: url });
                      if (await library.connectCompanion(url)) setMenu(false);
                    }}
                  >
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, height: 30 }} />
                      <button className="btn small" type="submit" disabled={companion.status === 'connecting'}>
                        {companion.status === 'connecting' ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                    {companion.status === 'error' && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{companion.error}</div>}
                  </form>
                </details>
              )}
              <hr />
              <div className="menu-label">Appearance</div>
              <div className="menu-note">
                <div className="seg" style={{ width: '100%' }}>
                  {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                    <button key={t} className={settings.theme === t ? 'on' : ''} style={{ flex: 1 }} onClick={() => updateSettings({ theme: t })}>
                      {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </div>
              <hr />
              <button
                className="item"
                onClick={() => {
                  setMenu(false);
                  onHelp();
                }}
              >
                <Icon name="help" /> Help & keyboard shortcuts
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
