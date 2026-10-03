export function isFile(p: string): boolean;
export function resolveOwlet(configured: string | null | undefined, candidates?: string[], env?: Record<string, string | undefined>): string | null;
export function isWPILogFile(file: string): Promise<boolean>;
export function timeoutFor(bytes: number): number;
export interface Converted {
  /** Signals in the converted log. */
  signals: number;
  records: number;
  /** How much time the log covers. */
  seconds: number;
  bytes: number;
  /** Anything Owlet printed. */
  said?: string;
}
export function convertHoot(o: { owlet: string; input: string; output: string; timeoutMs?: number; signal?: AbortSignal }): Promise<({ ok: true } & Converted) | { ok: false; error: string }>;
