import type { AgentHostApi, PromptQueueChange, PromptQueueItem, PromptQueueStatus } from '@extalia/platform';

export interface PromptQueueView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  status?: PromptQueueStatus;
  busy: boolean;
  disabled: boolean;
  draft: string;
  edit?: { original: PromptQueueItem; text: string };
  notice?: 'failed' | 'stale';
}
type Change = PromptQueueChange extends infer T ? T extends PromptQueueChange ? Omit<T, 'revision'> : never : never;
const sameItem = (left: PromptQueueItem | undefined, right: PromptQueueItem) => !!left && left.id === right.id
  && left.text === right.text && left.state === right.state && left.createdAt === right.createdAt;

/** Pending edits use the displayed revision and a fresh read; receipts never become editable prompts. */
export function createPromptQueueControl(api: AgentHostApi, sessionId: string) {
  const supported = !!(api.promptQueueStatus && api.changePromptQueue);
  let view: PromptQueueView = { phase: supported ? 'loading' : 'unsupported', busy: false, disabled: false, draft: '' };
  let active = false, epoch = 0, draftRevision = 0, editRevision = 0, mutating = false;
  let read: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: PromptQueueView) => { view = next; listeners.forEach(listener => listener()); };
  function validate(status: PromptQueueStatus): PromptQueueStatus {
    if (!status || status.sessionId !== sessionId || typeof status.revision !== 'string' || !status.revision && (status.supported || !Array.isArray(status.items) || status.items.length > 0)
      || typeof status.supported !== 'boolean' || typeof status.paused !== 'boolean'
      || !Number.isSafeInteger(status.maxTextLength) || status.maxTextLength < 1 || !Array.isArray(status.items)
      || status.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string'
        || !['pending', 'sending', 'sent', 'unknown'].includes(item.state) || typeof item.createdAt !== 'string')
      || new Set(status.items.map(item => item.id)).size !== status.items.length) throw new Error('Invalid queue status');
    return status;
  }
  const receive = (status: PromptQueueStatus) => update({ ...view, phase: 'ready', status: validate(status) });
  const writable = (requireSupported = true) => active && supported && view.phase === 'ready' && !!view.status?.revision
    && (!requireSupported || !!view.status.supported) && !view.disabled && !mutating;
  const validText = (text: string) => !!text.trim() && !text.includes('\0') && text.length <= (view.status?.maxTextLength ?? 0);
  const pendingItem = (item: PromptQueueItem) => item.state === 'pending' && sameItem(view.status?.items.find(current => current.id === item.id), item);
  function refresh(): Promise<void> {
    if (!active || !supported || mutating) return Promise.resolve();
    if (read) return read;
    const ticket = epoch;
    const pending = (async () => {
      try { const status = await api.promptQueueStatus!(sessionId); if (active && ticket === epoch) receive(status); }
      catch { if (active && ticket === epoch) update({ ...view, phase: 'error', status: undefined, notice: 'failed' }); }
    })();
    read = pending;
    void pending.finally(() => { if (read === pending) read = undefined; });
    return pending;
  }
  async function change(input: Change, guard: (status: PromptQueueStatus) => boolean = () => true, accepted?: () => void, requireSupported = true) {
    if (!writable(requireSupported)) return;
    const revision = view.status!.revision, ticket = ++epoch;
    const current = () => active && ticket === epoch && !view.disabled;
    mutating = true; update({ ...view, busy: true, notice: undefined });
    try {
      await read;
      if (!current()) return;
      const status = validate(await api.promptQueueStatus!(sessionId));
      if (!current()) return;
      receive(status);
      if (requireSupported && !status.supported || status.revision !== revision || !guard(status)) { update({ ...view, notice: 'stale' }); return; }
      const result = await api.changePromptQueue!(sessionId, { ...input, revision } as PromptQueueChange);
      if (!current()) return;
      receive(result); accepted?.();
    } catch { if (current()) update({ ...view, phase: 'error', status: undefined, notice: 'failed' }); }
    finally { mutating = false; if (active) update({ ...view, busy: false }); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; ++epoch; void refresh();
      timer = setInterval(() => { void refresh(); }, 1000);
      return () => { active = false; ++epoch; clearInterval(timer); timer = undefined; };
    },
    setDisabled(disabled: boolean) { if (disabled !== view.disabled) { ++epoch; update({ ...view, disabled }); } },
    setDraft(draft: string) { ++draftRevision; update({ ...view, draft }); },
    canAdd: () => writable() && validText(view.draft),
    add() {
      if (!validText(view.draft)) return Promise.resolve();
      const text = view.draft, draftTicket = draftRevision;
      return change({ action: 'add', text }, status => text.length <= status.maxTextLength, () => {
        if (draftTicket === draftRevision) update({ ...view, draft: '' });
      });
    },
    beginEdit(item: PromptQueueItem) {
      if (!writable() || !pendingItem(item)) return;
      ++editRevision; update({ ...view, edit: { original: { ...item }, text: item.text } });
    },
    setEditDraft(text: string) { if (view.edit) { ++editRevision; update({ ...view, edit: { ...view.edit, text } }); } },
    cancelEdit() { if (!mutating) { ++editRevision; update({ ...view, edit: undefined }); } },
    canSave: () => writable() && !!view.edit && pendingItem(view.edit.original) && validText(view.edit.text),
    save() {
      const edit = view.edit, editTicket = editRevision;
      if (!edit || !pendingItem(edit.original) || !validText(edit.text)) return Promise.resolve();
      return change({ action: 'edit', itemId: edit.original.id, text: edit.text }, status =>
        sameItem(status.items.find(item => item.id === edit.original.id), edit.original) && edit.text.length <= status.maxTextLength, () => {
        if (editTicket === editRevision) update({ ...view, edit: undefined });
      });
    },
    delete(item: PromptQueueItem) {
      if (!pendingItem(item)) return Promise.resolve();
      return change({ action: 'delete', itemId: item.id }, status => sameItem(status.items.find(current => current.id === item.id), item), undefined, false);
    },
    move(item: PromptQueueItem, offset: -1 | 1) {
      if (!pendingItem(item)) return Promise.resolve();
      const ids = view.status!.items.filter(current => current.state === 'pending').map(current => current.id);
      const from = ids.indexOf(item.id), to = from + offset;
      if (from < 0 || to < 0 || to >= ids.length) return Promise.resolve();
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      return change({ action: 'reorder', itemIds: ids }, status => {
        const pending = status.items.filter(current => current.state === 'pending');
        return pending.length === ids.length && pending.every(current => ids.includes(current.id)) && sameItem(pending.find(current => current.id === item.id), item);
      });
    },
    setPaused(paused: boolean) {
      if (!paused && view.status?.items.some(item => item.state === 'unknown' || item.state === 'sending')) return Promise.resolve();
      return change({ action: 'pause', paused }, status => paused || !status.items.some(item => item.state === 'unknown' || item.state === 'sending'));
    },
    acknowledge(item: PromptQueueItem) {
      if (!['sent', 'unknown'].includes(item.state) || !sameItem(view.status?.items.find(current => current.id === item.id), item)) return Promise.resolve();
      return change({ action: 'acknowledge', itemId: item.id }, status => sameItem(status.items.find(current => current.id === item.id), item), undefined, false);
    },
    refresh,
  };
}
export type PromptQueueControl = ReturnType<typeof createPromptQueueControl>;
