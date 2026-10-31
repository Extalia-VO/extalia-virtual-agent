import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirectoryListing } from '@extalia/platform';

const MAX_DIRECTORY_ENTRIES = 200;

function insertSortedBounded(names: string[], name: string): void {
  let low = 0;
  let high = names.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((names[middle] as string) < name) low = middle + 1;
    else high = middle;
  }
  if (low >= MAX_DIRECTORY_ENTRIES && names.length >= MAX_DIRECTORY_ENTRIES) return;
  names.splice(low, 0, name);
  if (names.length > MAX_DIRECTORY_ENTRIES) names.pop();
}

async function filesystemRoots(platform: NodeJS.Platform): Promise<Array<{ name: string; path: string }>> {
  if (platform !== 'win32') return [{ name: path.parse(path.sep).root, path: path.parse(path.sep).root }];
  const roots: Array<{ name: string; path: string }> = [];
  for (let letter = 65; letter <= 90; letter++) {
    const root = `${String.fromCharCode(letter)}:${path.sep}`;
    try {
      if ((await stat(root)).isDirectory()) roots.push({ name: root.slice(0, 2), path: root });
    } catch { /* unavailable drive */ }
  }
  return roots;
}

/**
 * Browse host directories for an explicit user workspace selection. It returns
 * directory names only, never files, follows no directory symlinks, and keeps
 * at most the first 200 names in lexical order in memory and in the response.
 */
export async function browseDirectories(
  requested: unknown,
  options: { homeDirectory: string; platform?: NodeJS.Platform },
): Promise<DirectoryListing> {
  const platform = options.platform ?? process.platform;
  const homeInput = options.homeDirectory;
  if (typeof homeInput !== 'string' || !path.isAbsolute(homeInput)) throw new Error('The host home directory must be an absolute path.');
  const homePath = await realpath(homeInput);
  if (!(await stat(homePath)).isDirectory()) throw new Error('The host home path is not a directory.');

  let target: string;
  if (requested === undefined || requested === null || requested === '') target = homePath;
  else {
    if (typeof requested !== 'string') throw new Error('Choose an absolute directory path.');
    const raw = requested.trim();
    if (!raw) throw new Error('Choose an absolute directory path.');
    if (raw === '~') target = homePath;
    else if (raw.startsWith('~/') || raw.startsWith('~\\')) target = path.join(homePath, raw.slice(2));
    else if (raw.startsWith('~')) throw new Error('Only the current user’s home path may use ~.');
    else target = raw;
    if (!path.isAbsolute(target)) throw new Error('Choose an absolute directory path.');
  }

  let currentPath: string;
  try { currentPath = await realpath(target); }
  catch { throw new Error('That directory does not exist or cannot be read.'); }
  if (!(await stat(currentPath)).isDirectory()) throw new Error('That path is not a directory.');

  const names: string[] = [];
  let directoryCount = 0;
  let directory;
  try { directory = await opendir(currentPath); }
  catch { throw new Error('That directory does not exist or cannot be read.'); }
  try {
    for await (const entry of directory) {
      // Deliberately do not follow symlinks, including links that point to directories.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      directoryCount++;
      insertSortedBounded(names, entry.name);
    }
  } catch {
    throw new Error('That directory does not exist or cannot be read.');
  }

  const parsed = path.parse(currentPath);
  const parent = currentPath === parsed.root ? undefined : path.dirname(currentPath);
  return {
    path: currentPath,
    homePath,
    ...(parent ? { parentPath: parent } : {}),
    entries: names.map(name => ({ name, path: path.join(currentPath, name) })),
    roots: await filesystemRoots(platform),
    truncated: directoryCount > MAX_DIRECTORY_ENTRIES,
  };
}
