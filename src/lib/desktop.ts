// The desktop app (see desktop/) gives the page a few native abilities through `window.pitviewDesktop`: choosing folders and
// locating Owlet need real dialogs, and nothing a website could call may ever pick the program to run.

export interface DesktopSettings {
  /** Driver Station log folder. */
  dsDir: string;
  /** Where the robot's .wpilog / .hoot files are copied to. */
  robotDir: string;
  owlet: { path: string | null; found: boolean };
  platform: string;
  version: string;
}

export interface DesktopBridge {
  settings(): Promise<DesktopSettings>;
  /** Asks for a folder with a native dialog. Resolves with the new settings (unchanged if cancelled). */
  chooseFolder(kind: 'ds' | 'robot'): Promise<DesktopSettings>;
  locateOwlet(): Promise<DesktopSettings>;
  openFolder(kind: 'ds' | 'robot'): Promise<void>;
  /** Tries again the hoots Owlet could not convert. */
  retryConversions(): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { pitviewDesktop?: DesktopBridge }).pitviewDesktop;
}
