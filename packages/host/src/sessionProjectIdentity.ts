import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sessionBrowserProject, type SessionBrowserProjectIdentity, type SessionBrowserSnapshotInput } from '@extalia/platform';

const MAX_MARKER_BYTES = 4096;
const MAX_ANCESTORS = 32;
const CACHE_LIMIT = 2048;
const CACHE_MS = 5 * 60_000;
type Entry = { expires: number; identity?: SessionBrowserProjectIdentity };

async function marker(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MARKER_BYTES) return undefined;
    return await readFile(file, { encoding: 'utf8', signal: AbortSignal.timeout(500) });
  } catch { return undefined; }
}
const canonical = (folder: string) => realpath(folder).catch(() => folder);
const inside = (root: string, folder: string) => {
  if (process.platform === 'win32') { root = root.toLowerCase(); folder = folder.toLowerCase(); }
  return folder === root || folder.startsWith(root.endsWith('/') ? root : root + '/');
};

/** Read-only Git-marker discovery. No Git commands, config execution or workspace grants. */
export class SessionProjectIdentities {
  private readonly cache = new Map<string, Entry>();
  constructor(private readonly now = () => Date.now()) {}
  private remember(folder: string, identity?: SessionBrowserProjectIdentity): void {
    this.cache.delete(folder); this.cache.set(folder, { expires: this.now() + CACHE_MS, identity });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }
  private async git(folder: string): Promise<SessionBrowserProjectIdentity | undefined> {
    const prior = this.cache.get(folder);
    if (prior && prior.expires > this.now()) return prior.identity;
    const visited: string[] = [];
    let current = folder;
    let reachedRoot = false;
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
      const cached = this.cache.get(current);
      if (cached && cached.expires > this.now()) {
        for (const item of visited) this.remember(item, cached.identity);
        return cached.identity;
      }
      visited.push(current);
      const git = path.join(current, '.git');
      try {
        const info = await lstat(git);
        let gitDirectory: string | undefined;
        if (!info.isSymbolicLink() && info.isDirectory()) gitDirectory = git;
        else if (!info.isSymbolicLink() && info.isFile()) {
          const contents = await marker(git), match = contents?.match(/^gitdir:\s*([^\r\n]+)\s*$/i);
          if (match) gitDirectory = path.resolve(current, match[1]!.trim());
        }
        if (gitDirectory) {
          const target = await lstat(gitDirectory);
          if (!target.isDirectory() || target.isSymbolicLink()) break;
          const common = await marker(path.join(gitDirectory, 'commondir'));
          const commonDirectory = await canonical(common ? path.resolve(gitDirectory, common.trim()) : gitDirectory);
          const commonInfo = await lstat(commonDirectory);
          if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) break;
          const head = await marker(path.join(commonDirectory, 'HEAD'));
          const objects = await lstat(path.join(commonDirectory, 'objects'));
          if (!head || !/^(?:ref: [^\r\n]+|[a-f0-9]{40,64})\s*$/i.test(head) || !objects.isDirectory() || objects.isSymbolicLink()) break;
          const displayRoot = common ? path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : commonDirectory : current;
          const identity = { id: `repository:${JSON.stringify(commonDirectory)}`, name: path.basename(displayRoot) || displayRoot, path: displayRoot };
          for (const item of visited) this.remember(item, identity);
          return identity;
        }
      } catch { /* Missing/inaccessible metadata retains the lexical or explicit-workspace fallback. */ }
      const parent = path.dirname(current);
      if (parent === current) { reachedRoot = true; break; }
      current = parent;
    }
    // Once all ancestors were checked, sibling paths can reuse those negative results.
    // A sibling still checks its own marker before consulting a parent cache entry.
    for (const item of reachedRoot ? visited : [folder]) this.remember(item);
    return undefined;
  }
  async resolve(folders: readonly string[], workspaces: SessionBrowserSnapshotInput['workspaces'] = []): Promise<Map<string, SessionBrowserProjectIdentity>> {
    const unique = [...new Map(folders.map(folder => sessionBrowserProject(folder)).filter((value): value is NonNullable<typeof value> => Boolean(value)).map(value => [value.id, value])).values()];
    const roots = (await Promise.all(workspaces.map(async workspace => {
      const primary = sessionBrowserProject(workspace.projectLocation);
      if (!primary) return [];
      const identity = sessionBrowserProject(await canonical(primary.path)) ?? primary;
      return Promise.all([workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].map(async value => {
        const candidate = sessionBrowserProject(value);
        if (!candidate) return undefined;
        const root = sessionBrowserProject(await canonical(candidate.path));
        return root ? { root: root.path, identity } : undefined;
      }));
    }))).flat().filter((value): value is NonNullable<typeof value> => Boolean(value)).sort((a, b) => b.root.length - a.root.length);
    const result = new Map<string, SessionBrowserProjectIdentity>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const original = unique[next++]!;
        if (!path.isAbsolute(original.path)) continue;
        const folder = await canonical(original.path);
        const identity = await this.git(folder) ?? roots.find(root => inside(root.root, sessionBrowserProject(folder)?.path ?? original.path))?.identity;
        if (identity) result.set(original.id, identity);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, unique.length) }, worker));
    return result;
  }
}
