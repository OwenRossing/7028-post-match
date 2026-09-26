import { useSyncExternalStore } from 'react';
import type { ChartId, Problem } from '../../lib/analysis';
import type { ChartGroup } from '../../lib/chartGroup';
import type { EventKind } from '../../lib/dsevents';
import type { LogEntry } from '../../lib/library';
import type { Settings } from '../../lib/settings';
import type { ChartTheme } from '../../lib/theme';
import type { TimeFormat } from '../../lib/timefmt';
import type { ParsedLog } from '../../lib/workerClient';

export type Tab = 'overview' | 'graphs' | 'power' | 'details';

export interface EventFilter {
  tag?: string;
  kind?: EventKind;
  text?: string;
}

export interface ViewCtx {
  entry: LogEntry;
  parsed: ParsedLog;
  group: ChartGroup;
  theme: ChartTheme;
  settings: Settings;
  tf: TimeFormat;
  labels: string[] | undefined;
  labelKey: string;
  /** Findings for the enabled part of the log (includes info-level notes). */
  problems: Problem[];
  /** Switches to the graphs tab and focuses a time. */
  jumpTo: (t: number, opts?: { chart?: ChartId; width?: number }) => void;
  showEvents: (filter: EventFilter) => void;
  setTab: (tab: Tab) => void;
}

export function useGroupValue<T>(group: ChartGroup, channel: 'range' | 'hover' | 'pin', read: () => T): T {
  return useSyncExternalStore((cb) => group.on(channel, cb), read);
}
