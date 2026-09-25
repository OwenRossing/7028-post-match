// Watching the Driver Station log folder with the File System Access API (Chrome / Edge).
import { idb } from './idb';
import { isLogFile, type FileRef } from './library';

interface PermissionCapable {
  queryPermission(opts: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(opts: { mode: 'read' }): Promise<PermissionState>;
}

type DirHandle = FileSystemDirectoryHandle & PermissionCapable;

export const DS_LOG_PATH = 'C:\\Users\\Public\\Documents\\FRC\\Log Files';

export function folderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  const handle = await picker({ id: 'ds-logs', mode: 'read' });
  await rememberFolder(handle);
  return handle;
}

export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await idb.set('kv', 'folder', handle).catch(() => undefined);
}

export async function forgetFolder(): Promise<void> {
  await idb.del('kv', 'folder').catch(() => undefined);
}

/** The previously connected folder and whether we may still read it without a click. */
export async function savedFolder(): Promise<{ handle: FileSystemDirectoryHandle; granted: boolean } | null> {
  const handle = await idb.get<DirHandle>('kv', 'folder');
  if (!handle) return null;
  try {
    return { handle, granted: (await handle.queryPermission({ mode: 'read' })) === 'granted' };
  } catch {
    return { handle, granted: false };
  }
}

/** Must be called from a user gesture. */
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (handle as DirHandle).requestPermission({ mode: 'read' })) === 'granted';
}

/** Lists .dslog/.dsevents files, looking a few folders deep (some DS versions use sub folders). */
export async function scanFolder(dir: FileSystemDirectoryHandle, depth = 3): Promise<FileRef[]> {
  const out: FileRef[] = [];
  const walk = async (d: FileSystemDirectoryHandle, level: number) => {
    for await (const handle of d.values()) {
      if (handle.kind === 'directory') {
        if (level < depth) await walk(handle as FileSystemDirectoryHandle, level + 1);
      } else if (isLogFile(handle.name)) {
        const fh = handle as FileSystemFileHandle;
        const file = await fh.getFile();
        out.push({
          name: file.name,
          size: file.size,
          mtime: file.lastModified,
          read: async () => (await fh.getFile()).arrayBuffer(),
        });
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Collects files (and folders, recursively) from a drag and drop. */
export async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; folder?: FileSystemDirectoryHandle }> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  // These must be requested synchronously, before the drop event handler yields.
  const handlePromises = items.map((i) =>
    (i as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.(),
  );
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const plainFiles = [...dt.files];

  // Chromium can hand us a real directory handle, which we can then watch like a connected folder.
  const handles = await Promise.all(handlePromises.map((p) => (p ? p.catch(() => null) : null)));
  const dirHandle = handles.find((h) => h?.kind === 'directory') as FileSystemDirectoryHandle | undefined;
  if (dirHandle && items.length === 1) return { files: [], folder: dirHandle };

  const files: File[] = [];
  const readEntry = async (entry: FileSystemEntry, level: number): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      if (isLogFile(file.name)) files.push(file);
    } else if (entry.isDirectory && level < 4) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await readEntry(child, level + 1);
      } while (batch.length);
    }
  };
  if (entries.some((e) => e?.isDirectory)) {
    for (const e of entries) if (e) await readEntry(e, 0);
  } else {
    files.push(...plainFiles.filter((f) => isLogFile(f.name)));
  }
  return { files };
}
