// The desktop app (see desktop/) gives the page a few native abilities through `window.pitviewDesktop`: choosing folders and
// locating Owlet need real dialogs, and nothing a website could call may ever pick the program to run.

export interface DesktopSettings {
  /** Driver Station log folder. */
  dsDir: string;
  /** Where the robot's .wpilog / .hoot files are copied to. */
  robotDir: string;
  owlet: {
    path: string | null;
    found: boolean;
    /** An Owlet found in the Downloads folder that has not been used yet: the app asks before it does. */
    suggested?: string;
    /** What to do when the download is there but still zipped. */
    hint?: string;
  };
  platform: string;
  version: string;
}

export interface DesktopBridge {
  settings(): Promise<DesktopSettings>;
  /** Asks for a folder with a native dialog. Resolves with the new settings (unchanged if cancelled). */
  chooseFolder(kind: 'ds' | 'robot'): Promise<DesktopSettings>;
  locateOwlet(): Promise<DesktopSettings>;
  openFolder(kind: 'ds' | 'robot'): Promise<void>;
  /** Opens CTRE's page for downloading Owlet. */
  getOwlet(): Promise<void>;
  /**
   * Offers the Owlet found in Downloads. The app asks the user, naming the file, before using it; `once` does not ask again
   * about one the user already declined.
   */
  useDownloadedOwlet(ask?: 'once' | 'menu'): Promise<DesktopSettings>;
  /** Tries again the hoots Owlet could not convert. */
  retryConversions(): Promise<void>;
  /**
   * Copies robot logs the user dropped or picked into the robot-log folder, where Owlet converts the hoots and each log
   * finds its match. `skipped` are ones already there.
   */
  addRobotFiles(files: File[]): Promise<{ copied: string[]; skipped: string[]; failed: { name: string; error: string }[] }>;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { pitviewDesktop?: DesktopBridge }).pitviewDesktop;
}
