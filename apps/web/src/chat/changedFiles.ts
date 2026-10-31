import type { ExtaliaEvent, FileChangeKind } from '@extalia/protocol';

export interface ChangedFile { path: string; change: FileChangeKind; edits: number; lastAt: string }

/** A tool target that names a file, not a sentence or a command. */
const looksLikePath = (value: string) => value.length <= 1024 && !/[\n\r<>|*?"]/.test(value) && /[\\/.]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);

function relativeTo(path: string, root: string | undefined): string {
  if (!root) return path;
  const base = root.replace(/[\\/]+$/, '');
  return path === base || !path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`) ? path : path.slice(base.length + 1);
}

/**
 * Files the session changed, newest first. Hosts that track writes report `file.written`; agents
 * read from their transcript only name the file on their edit calls, so those count too, and a
 * failed call counts for nothing. One edit call that also reports its write counts once.
 */
export function projectChangedFiles(events: readonly ExtaliaEvent[], root?: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const calls = new Map<string, string>();
  const unconfirmed = new Set<string>();
  const remember = (path: string, change: FileChangeKind | undefined, at: string, counted: boolean) => {
    const known = files.get(path);
    const next = !known ? change ?? 'update' : !change ? known.change : known.change === 'add' && change === 'update' ? 'add' : change;
    files.set(path, { path, change: next, edits: (known?.edits ?? 0) + (counted ? 1 : 0), lastAt: at });
  };
  for (const event of events) {
    const { body, at } = event;
    if (body.type === 'file.written') {
      const path = relativeTo(body.path, root);
      remember(path, body.change, at, !unconfirmed.delete(path));
    } else if (body.type === 'tool.started' && body.kind === 'edit' && body.target && looksLikePath(body.target)) {
      const path = relativeTo(body.target, root);
      remember(path, undefined, at, true);
      unconfirmed.add(path);
      calls.set(body.toolCallId ?? event.id, path);
    } else if (body.type === 'tool.completed' && !body.ok) {
      const path = body.toolCallId ? calls.get(body.toolCallId) : undefined;
      const known = path ? files.get(path) : undefined;
      if (!path || !known) continue;
      unconfirmed.delete(path);
      if (known.edits <= 1) files.delete(path);
      else files.set(path, { ...known, edits: known.edits - 1 });
    }
  }
  // Some sources name an edit by its bare file name: it is the one known path that ends with it.
  for (const bare of [...files.values()].filter(file => !/[\\/]/.test(file.path))) {
    const matches = [...files.values()].filter(file => file.path.endsWith(`/${bare.path}`) || file.path.endsWith(`\\${bare.path}`));
    if (matches.length !== 1) continue;
    const full = matches[0]!;
    files.set(full.path, { ...full, edits: Math.max(full.edits, bare.edits), lastAt: full.lastAt > bare.lastAt ? full.lastAt : bare.lastAt });
    files.delete(bare.path);
  }
  return [...files.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}
