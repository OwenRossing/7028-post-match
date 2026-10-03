import type { Server } from 'node:http';
import type { RobotFolder } from './robot.mjs';

export const VERSION: string;
export function defaultDsDir(): string;

export interface CompanionOptions {
  dir?: string;
  robotDir?: string | null;
  owlet?: string | null;
  owletCandidates?: string[];
  convertDir?: string;
  dist?: string;
  port?: number;
  lan?: boolean;
  cors?: boolean;
  desktop?: boolean;
}

export interface CompanionHandle {
  port: number;
  url: string;
  server: Server;
  robot: RobotFolder;
  configure(c: { dir?: string; robotDir?: string | null; owlet?: string | null }): void;
  close(): Promise<void>;
}

export function startCompanion(o?: CompanionOptions): Promise<CompanionHandle>;
