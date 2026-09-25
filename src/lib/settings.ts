import { useSyncExternalStore } from 'react';
import type { ChartId } from './analysis';
import type { ThemePref } from './theme';

export type TimeMode = 'match' | 'log' | 'clock';

export interface Settings {
  theme: ThemePref;
  timeMode: TimeMode;
  showMarkers: boolean;
  hiddenCharts: ChartId[];
  /** Custom channel names, keyed by "<team>:<pd type>". */
  channelLabels: Record<string, string[]>;
  persistUploads: boolean;
  autoFollow: boolean;
  companionUrl: string;
  sidebarOpen: boolean;
  eventsPanelOpen: boolean;
  seenIntro: boolean;
}

const DEFAULTS: Settings = {
  theme: 'system',
  timeMode: 'match',
  showMarkers: true,
  hiddenCharts: [],
  channelLabels: {},
  persistUploads: true,
  autoFollow: true,
  companionUrl: 'http://localhost:5801',
  sidebarOpen: true,
  eventsPanelOpen: false,
  seenIntro: false,
};

const KEY = 'pitview.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

let state = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return state;
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function channelLabelKey(team: number | undefined, pdType: string): string {
  return `${team ?? 'any'}:${pdType}`;
}

export function channelName(labels: string[] | undefined, ch: number): string {
  const custom = labels?.[ch]?.trim();
  return custom ? custom : `Ch ${ch}`;
}
