import type { Converted, convertHoot } from './owlet.mjs';

export type RobotState = 'ready' | 'queued' | 'converting' | 'failed' | 'needs-owlet';

export interface RobotItem {
  id: string;
  name: string;
  path: string;
  kind: 'wpilog' | 'hoot';
  size: number;
  mtime: number;
  state: RobotState;
  error?: string;
  /** For a converted hoot: what the whole converted log was checked to hold. */
  converted?: Converted;
}

export interface RobotSnapshot {
  dir: string | null;
  owlet: { path: string | null; configured: string | null; found: boolean };
  items: RobotItem[];
}

export const robotFileRe: RegExp;

export class RobotFolder {
  constructor(o: {
    dir?: string | null;
    convertDir: string;
    owlet?: string | null;
    owletCandidates?: string[];
    onChange?: () => void;
    convert?: typeof convertHoot;
  });
  configure(o: { dir?: string | null; owlet?: string | null }): void;
  retry(): void;
  start(intervalMs?: number): void;
  stop(): void;
  shutdown(): void;
  scan(): Promise<void>;
  snapshot(): RobotSnapshot;
  fileFor(id: string, which?: 'default' | 'source'): string | null;
}
