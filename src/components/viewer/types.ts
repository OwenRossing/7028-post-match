import { useSyncExternalStore } from 'react';
import type { ChartId, Problem } from '../../lib/analysis';
import type { ChartGroup } from '../../lib/chartGroup';
import type { EventKind } from '../../lib/dsevents';
import type { LogEntry } from '../../lib/library';
import type { Settings } from '../../lib/settings';
import type { ChartTheme } from '../../lib/theme';
import type { TimeFormat } from '../../lib/timefmt';
import type { ParsedLog } from '../../lib/workerClient';

export type Tab = 'board' | 'graphs' | 'messages' | 'info';

export interface JumpOpts {
  /** Unfold the Graphs rows for one of the analysis charts. */
  chart?: ChartId;
  /** Unfold one Graphs row by id ('voltage', 'total', 'ch3', …). */
  signal?: string;
  /** Seconds to show around the time. */
  width?: number;
}

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
  /** Switches to the graphs tab, focuses a time and unfolds the rows that show it. */
  jumpTo: (t: number, opts?: JumpOpts) => void;
  showEvents: (filter: EventFilter) => void;
  setTab: (tab: Tab) => void;
  /** Asks for roboRIO / CTRE logs to add to this match. */
  addLogs: () => void;
  /** Takes an attached log off this match. */
  removeLog: (name: string) => void;
}

export function useGroupValue<T>(group: ChartGroup, channel: 'range' | 'hover' | 'pin', read: () => T): T {
  return useSyncExternalStore((cb) => group.on(channel, cb), read);
}
