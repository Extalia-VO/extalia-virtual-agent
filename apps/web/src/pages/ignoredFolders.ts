/** v0.0.37: folders whose sessions the Office ignores (helper/background sessions such as claude-mem summaries). */
export const DEFAULT_IGNORED_FOLDERS: readonly string[] = ['~/.claude-mem'];

/** The host's ignore list, or `undefined` when the host does not support ignored folders (feature detection). */
export function readIgnoreFolders(status: unknown): string[] | undefined {
  const value = status && typeof status === 'object' ? (status as { ignoreFolders?: unknown }).ignoreFolders : undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(normalizeIgnoredFolder);
}

/** Trims a typed folder and drops trailing separators ("~/.claude-mem/" → "~/.claude-mem"); roots stay as they are. */
export function normalizeIgnoredFolder(value: string): string {
  const trimmed = value.trim();
  const stripped = trimmed.replace(/[\\/]+$/, '');
  return stripped === '' || stripped === '~' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
}

/** Adds a folder unless it is empty or already listed (compared after normalising, case-sensitively). */
export function addIgnoredFolder(list: readonly string[], value: string): { list: string[]; added: boolean; duplicate: boolean } {
  const folder = normalizeIgnoredFolder(value);
  if (!folder) return { list: [...list], added: false, duplicate: false };
  if (list.some(item => normalizeIgnoredFolder(item) === folder)) return { list: [...list], added: false, duplicate: true };
  return { list: [...list, folder], added: true, duplicate: false };
}

export function removeIgnoredFolder(list: readonly string[], value: string): string[] {
  const folder = normalizeIgnoredFolder(value);
  return list.filter(item => normalizeIgnoredFolder(item) !== folder);
}

/** The host's built-in default list (`defaultIgnoreFolders`), falling back to `~/.claude-mem`. */
export function readDefaultIgnoreFolders(status: unknown): string[] {
  const value = status && typeof status === 'object' ? (status as { defaultIgnoreFolders?: unknown }).defaultIgnoreFolders : undefined;
  const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(normalizeIgnoredFolder) : [];
  return list.length ? list : [...DEFAULT_IGNORED_FOLDERS];
}

export const isDefaultIgnoredFolder = (folder: string, defaults: readonly string[] = DEFAULT_IGNORED_FOLDERS) => defaults.includes(normalizeIgnoredFolder(folder));

/** True when some default folder is missing from the list (the "Restore default" action is offered). */
export const missesDefaults = (list: readonly string[], defaults: readonly string[] = DEFAULT_IGNORED_FOLDERS) =>
  defaults.some(folder => !list.some(item => normalizeIgnoredFolder(item) === normalizeIgnoredFolder(folder)));
