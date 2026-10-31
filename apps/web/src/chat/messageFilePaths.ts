/** Only registered project roots can be used for a host file preview. */
export interface WorkspaceSummary { id: string; projectLocation?: string }
export interface MessageFileReference { name: string; path?: string; link?: boolean }
export interface MessageFileScope {
  workspaces: readonly WorkspaceSummary[];
  workspaceId?: string;
  projectPath?: string;
}
export interface ResolvedMessageFile { workspaceId: string; path: string }

interface ParsedPath { volume: string; parts: string[]; windows: boolean; absolute: boolean }
const hasControl = (value: string) => [...value].some(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code >= 127 && code <= 159;
});

/** Filesystem paths stay literal. Link targets lose a raw line suffix, then decode once. */
function cleanPath(value: string, link: boolean): string | undefined {
  let path = value;
  if (hasControl(path) || /^[a-z]:[^\\/]/i.test(path) || /^(?:file|https?|data|javascript|vbscript|blob|ftp|mailto):/i.test(path)) return undefined;
  if (link) {
    path = path.replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/i, '');
    try { path = decodeURIComponent(path); } catch { return undefined; }
  }
  if (!path || hasControl(path) || /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined;
  return path;
}

function parsePath(value: string, link = false): ParsedPath | undefined {
  const clean = cleanPath(value, link);
  if (!clean) return undefined;
  const path = clean.replace(/\\/g, '/');
  let volume = '', rest = path, windows = false, absolute = false;
  if (/^[a-z]:\//i.test(path)) {
    volume = path.slice(0, 2).toLowerCase(); rest = path.slice(3); windows = true; absolute = true;
  } else if (path.startsWith('//')) {
    const match = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path);
    if (!match || match.slice(1).some(part => !part || part === '.' || part === '..' || /[?:]/.test(part))) return undefined;
    volume = `//${match[1]}/${match[2]}`.toLowerCase(); rest = path.slice(match[0].length); windows = true; absolute = true;
  } else if (clean.startsWith('\\')) return undefined;
  else if (path.startsWith('/')) { volume = '/'; rest = path.slice(1); absolute = true; }
  const parts = rest.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..' || part.includes(':'))) return undefined;
  // Windows ignores trailing dots/spaces and supports device names; do not reinterpret them.
  if (windows && parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return undefined;
  return { volume, parts, windows, absolute };
}

function within(path: ParsedPath, root: ParsedPath): boolean {
  const key = (part: string) => root.windows ? part.toLowerCase() : part;
  return path.absolute && root.absolute && path.windows === root.windows && path.volume === root.volume
    && path.parts.length >= root.parts.length && root.parts.every((part, index) => key(part) === key(path.parts[index]!));
}

/** Pure lexical mapping. The host still enforces symlink, credential and read limits. */
export function resolveMessageFile(reference: MessageFileReference, scope: MessageFileScope): ResolvedMessageFile | undefined {
  if (!reference.path) return undefined;
  let path = parsePath(reference.path, reference.link);
  if (!path) return undefined;
  const roots = scope.workspaces.flatMap(workspace => {
    const root = parsePath(workspace.projectLocation ?? '');
    return root?.absolute ? [{ workspace, root }] : [];
  });
  const explicit = scope.workspaceId ? roots.find(entry => entry.workspace.id === scope.workspaceId) : undefined;
  if (scope.workspaceId && !explicit) return undefined;
  const project = scope.projectPath ? parsePath(scope.projectPath) : undefined;
  if (!path.absolute) {
    const base = explicit ?? (project ? roots.filter(entry => within(project, entry.root)).sort((a, b) => b.root.parts.length - a.root.parts.length)[0] : undefined);
    if (!base) return undefined;
    const cwd = project && within(project, base.root) ? project : base.root;
    path = { ...cwd, parts: [...cwd.parts, ...path.parts] };
  }
  const match = explicit ? (within(path, explicit.root) ? explicit : undefined)
    : roots.filter(entry => within(path, entry.root)).sort((a, b) => b.root.parts.length - a.root.parts.length)[0];
  if (!match || path.parts.length === match.root.parts.length) return undefined;
  if (path.windows && path.parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return undefined;
  return { workspaceId: match.workspace.id, path: path.parts.slice(match.root.parts.length).join('/') };
}
