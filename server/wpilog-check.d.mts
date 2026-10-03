export type WPILogCheck =
  | { ok: true; bytes: number; entries: number; records: number; dataRecords: number; seconds: number }
  | { ok: false; error: string; truncated?: boolean };
export function inspectWPILog(file: string): Promise<WPILogCheck>;
