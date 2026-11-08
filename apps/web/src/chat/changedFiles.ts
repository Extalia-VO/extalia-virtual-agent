import type { ExtaliaEvent, FileChangeKind } from '@extalia/protocol';

export interface ChangedFile { path: string; change: FileChangeKind; edits: number; lastAt: string }

function relativeTo(path: string, root: string | undefined): string {
  if (!root) return path;
  const base = root.replace(/[\\/]+$/, '');
  return path === base || !path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`) ? path : path.slice(base.length + 1);
}

/** Files the session explicitly reports as written, newest first. Tool targets do not prove a disk change. */
export function projectChangedFiles(events: readonly ExtaliaEvent[], root?: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const seenEvents = new Set<string>();
  const seenWrites = new Set<string>();
  const turns = new Map<string, number>();

  for (const event of events) {
    if (seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    const { body } = event;
    const agent = event.agentId ?? 'primary';
    if (body.type === 'prompt.submitted') {
      // A resumed external runtime may reuse its call IDs for the next prompt.
      turns.set(agent, (turns.get(agent) ?? 0) + 1);
    }
    if (body.type !== 'file.written') continue;

    const path = relativeTo(body.path, root);
    const callIdentity = body.toolCallId
      ? `${agent}\u0000${turns.get(agent) ?? 0}\u0000${body.toolCallId}\u0000${path.replace(/\\/g, '/')}`
      : `event:${event.id}`;
    const known = files.get(path);
    if (seenWrites.has(callIdentity)) {
      if (known) {
        const change = known.change === 'add' && body.change === 'update' ? 'add' : body.change;
        files.set(path, { ...known, change, lastAt: event.at });
      }
      continue;
    }
    seenWrites.add(callIdentity);

    // Keep an addition marked as new if later activity only updates that new file.
    const change: FileChangeKind = known?.change === 'add' && body.change === 'update' ? 'add' : body.change;
    files.set(path, { path, change, edits: (known?.edits ?? 0) + 1, lastAt: event.at });
  }

  return [...files.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}
