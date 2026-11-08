import type { FileEntry } from '@extalia/platform';

export const isFileFolder = (entry: FileEntry): boolean => entry.kind === 'dir' || entry.target === 'dir';

/** Protected folders and links without an in-workspace target remain metadata-only. */
export const canNavigateFolder = (entry: FileEntry): boolean => isFileFolder(entry) && !entry.credential && (entry.kind !== 'symlink' || entry.target === 'dir');

/** Resolve details from the latest listing, including refreshed flags and sizes. */
export function selectedFileEntry(entries: readonly FileEntry[], selectedPath: string | null): FileEntry | undefined {
  return selectedPath === null ? undefined : entries.find(entry => entry.path === selectedPath);
}
