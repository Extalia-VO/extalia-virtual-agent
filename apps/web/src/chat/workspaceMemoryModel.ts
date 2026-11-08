import {
  NATIVE_MEMORY_LIMITS, normalizeMemoryDelete, normalizeMemoryName, normalizeMemoryReadOptions, normalizeMemoryWrite,
  type AgentHostApi, type NativeMemoryCatalog, type NativeMemoryNote, type NativeMemoryPage,
} from '@extalia/platform';

export type MemoryApi = Pick<AgentHostApi, 'nativeMemoryList' | 'nativeMemoryRead' | 'nativeMemoryWrite' | 'nativeMemoryDelete'>;
export type MemoryIssue = 'conflict' | 'missing' | 'unsupported' | 'unavailable' | 'tooLarge' | 'invalidName' | 'invalidContent' | 'draftLimit';
export interface MemoryDraft { name: string; content: string; initial: string; revision: string | null }
export interface WorkspaceMemoryState {
  phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'unavailable';
  notes: NativeMemoryNote[];
  nextOffset?: number;
  omitted: number;
  incomplete: boolean;
  busy?: 'list' | 'read' | 'edit' | 'save' | 'delete';
  selected?: NativeMemoryPage;
  draft?: MemoryDraft;
  issue?: MemoryIssue;
  confirm?: 'delete' | 'discard';
  notice?: 'saved' | 'deleted' | 'restored';
  masked?: number;
}

const initial = (): WorkspaceMemoryState => ({ phase: 'idle', notes: [], omitted: 0, incomplete: false });
export const memoryDraftDirty = (draft: MemoryDraft) => draft.content !== draft.initial || draft.revision === null && draft.name !== '';
export const MEMORY_DRAFT_SLOTS = 8;

/** Bounded app-lifetime retention. A full store refuses new editors; it never evicts user changes. */
export class WorkspaceMemoryDraftStore {
  private drafts = new Map<string, MemoryDraft>();
  private listeners = new Set<() => void>();
  dirtyCount = (): number => [...this.drafts.values()].filter(memoryDraftDirty).length;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed(previous: number) { if (this.dirtyCount() !== previous) for (const listener of this.listeners) listener(); }
  get(key: string): MemoryDraft | undefined { const draft = this.drafts.get(key); return draft ? { ...draft } : undefined; }
  put(key: string, draft: MemoryDraft): boolean {
    if (key.length > 8192 || draft.name.length > 64 || draft.content.length > NATIVE_MEMORY_LIMITS.content || draft.initial.length > NATIVE_MEMORY_LIMITS.content
      || !this.drafts.has(key) && this.drafts.size >= MEMORY_DRAFT_SLOTS) return false;
    const previous = this.dirtyCount();
    this.drafts.set(key, { ...draft }); this.changed(previous); return true;
  }
  forget(key: string, expected: MemoryDraft) {
    const draft = this.drafts.get(key);
    if (draft && draft.name === expected.name && draft.content === expected.content && draft.initial === expected.initial && draft.revision === expected.revision) {
      const previous = this.dirtyCount(); this.drafts.delete(key); this.changed(previous);
    }
  }
}
const hostDrafts = new WeakMap<MemoryApi, WorkspaceMemoryDraftStore>();
export function memoryDraftStore(api: MemoryApi): WorkspaceMemoryDraftStore {
  let store = hostDrafts.get(api);
  if (!store) { store = new WorkspaceMemoryDraftStore(); hostDrafts.set(api, store); }
  return store;
}
function issueFrom(error: unknown): MemoryIssue {
  // Older peers may advertise forwarding methods without serving them. Never expose raw host errors.
  const message = error instanceof Error ? error.message : '';
  return /unsupported|not supported|does not support|unknown (?:agent host )?(?:method|operation)|not implemented|method not found/i.test(message) ? 'unsupported' : 'unavailable';
}
function validCatalog(page: NativeMemoryCatalog, workspaceId: string, offset: number) {
  if (page.workspaceId !== workspaceId || !Array.isArray(page.notes) || page.notes.length > 20
    || !Number.isSafeInteger(page.omitted) || page.omitted < 0 || typeof page.incomplete !== 'boolean'
    || page.nextOffset !== undefined && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > NATIVE_MEMORY_LIMITS.candidates)) throw new Error('Invalid catalog.');
  const names = new Set<string>();
  for (const note of page.notes) {
    normalizeMemoryName(note.name); normalizeMemoryReadOptions({ expectedRevision: note.revision });
    if (names.has(note.name) || typeof note.summary !== 'string' || typeof note.updatedAt !== 'string') throw new Error('Invalid metadata.');
    names.add(note.name);
  }
}
function validPage(page: NativeMemoryPage, workspaceId: string, name: string, revision: string, offset: number, limit: number, total?: number) {
  const length = typeof page.text === 'string' ? Array.from(page.text).length : -1;
  if (page.workspaceId !== workspaceId || page.name !== name || page.revision !== revision || page.offset !== offset
    || page.offsetUnit !== 'unicode-code-points' || !Number.isSafeInteger(page.totalCharacters) || page.totalCharacters < 0
    || page.totalCharacters > NATIVE_MEMORY_LIMITS.offset || total !== undefined && total !== page.totalCharacters
    || length < 0 || length > limit || offset + length > page.totalCharacters
    || (offset + length < page.totalCharacters ? length === 0 || page.nextOffset !== offset + length : page.nextOffset !== undefined)) throw new Error('Invalid note page.');
}

/** One UI owner. Every continuation checks both its request generation and the current visible scope. */
export class WorkspaceMemoryController {
  private state = initial();
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  constructor(readonly api: MemoryApi, readonly workspaceId: string, private readonly isCurrent: () => boolean,
    private readonly retention?: { store: WorkspaceMemoryDraftStore; key: string }) {
    const draft = retention?.store.get(retention.key);
    if (draft && memoryDraftDirty(draft)) this.state = { ...this.state, draft, notice: 'restored' };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private current = () => this.active && this.isCurrent();
  private allowed = () => this.current() && !this.state.busy;
  private canMutate = () => this.allowed() && this.state.phase === 'ready' && this.state.issue !== 'unsupported';
  private keepDraft(draft: MemoryDraft): boolean {
    if (this.retention && !this.retention.store.put(this.retention.key, draft)) { this.update({ issue: 'draftLimit' }); return false; }
    this.update({ draft }); return true;
  }
  private forgetDraft() { if (this.retention && this.state.draft) this.retention.store.forget(this.retention.key, this.state.draft); }
  private failed(error: unknown) {
    const issue = issueFrom(error);
    this.update({ busy: undefined, issue, ...(issue === 'unsupported' ? { phase: 'unsupported' as const } : {}) });
  }
  private update(patch: Partial<WorkspaceMemoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private entered = () => ++this.generation;
  private owns = (generation: number) => this.current() && generation === this.generation;
  open = () => { this.active = true; if (this.state.phase === 'idle') void this.load(false, true); };
  pause = () => {
    this.active = false; this.generation++;
    if (this.state.draft && !memoryDraftDirty(this.state.draft)) this.forgetDraft();
    this.update({ busy: undefined, ...(this.state.phase === 'loading' ? { phase: 'idle' as const } : {}),
      ...(this.state.busy === 'save' || this.state.busy === 'delete' ? { issue: 'unavailable' as const } : {}) });
  };
  refresh = (more = false) => this.load(more, false);
  recheck = () => this.load(false, true);
  private load = async (more: boolean, allowDraft: boolean) => {
    if (!this.allowed() || this.state.draft && !allowDraft || more && this.state.nextOffset === undefined) return;
    const offset = more ? this.state.nextOffset! : 0;
    if (!this.api.nativeMemoryList) { this.update({ phase: 'unsupported' }); return; }
    const generation = this.entered();
    this.update({ busy: 'list', phase: more ? this.state.phase : 'loading', issue: undefined, ...(!more ? { selected: undefined, confirm: undefined } : {}) });
    try {
      const page = await this.api.nativeMemoryList(this.workspaceId, { offset, limit: 20 });
      if (!this.owns(generation)) return;
      validCatalog(page, this.workspaceId, offset);
      const notes = more ? [...this.state.notes] : [];
      for (const note of page.notes) if (!notes.some(existing => existing.name === note.name)) notes.push(note);
      this.update({ phase: 'ready', notes, nextOffset: page.nextOffset, omitted: page.omitted, incomplete: page.incomplete || more && this.state.incomplete, busy: undefined });
    } catch (error) {
      if (this.owns(generation)) { const issue = issueFrom(error); this.update({ busy: undefined, phase: issue === 'unsupported' ? 'unsupported' : more ? this.state.phase : 'unavailable', issue }); }
    }
  };
  read = async (name: string, more = false) => {
    if (!this.allowed() || this.state.draft) return;
    const note = this.state.notes.find(item => item.name === name);
    if (!note || more && (this.state.selected?.name !== name || this.state.selected.nextOffset === undefined)) return;
    const revision = more ? this.state.selected!.revision : note.revision;
    const offset = more ? this.state.selected!.nextOffset! : 0;
    if (!this.api.nativeMemoryRead) { this.update({ issue: 'unsupported' }); return; }
    const generation = this.entered();
    this.update({ busy: 'read', issue: undefined, confirm: undefined, notice: undefined, ...(!more ? { selected: undefined } : {}) });
    try {
      const result = await this.api.nativeMemoryRead(this.workspaceId, name, { offset, limit: 2000, expectedRevision: revision });
      if (!this.owns(generation)) return;
      if (result.status === 'missing' || result.status === 'conflict') { this.update({ busy: undefined, issue: result.status }); return; }
      if (result.status !== 'found') throw new Error('Invalid read status.');
      validPage(result.note, this.workspaceId, name, revision, offset, 2000, more ? this.state.selected?.totalCharacters : undefined);
      this.update({ selected: result.note, busy: undefined });
    } catch (error) { if (this.owns(generation)) this.failed(error); }
  };
  create = () => {
    if (this.canMutate() && !this.state.draft && this.api.nativeMemoryWrite
      && this.keepDraft({ name: '', content: '', initial: '', revision: null })) this.update({ issue: undefined, confirm: undefined, notice: undefined });
  };
  edit = async () => {
    const selected = this.state.selected;
    if (!this.canMutate() || this.state.draft || !selected || !this.api.nativeMemoryWrite || this.state.issue === 'conflict' || this.state.issue === 'missing' || this.state.issue === 'tooLarge') return;
    if (selected.totalCharacters > NATIVE_MEMORY_LIMITS.content) { this.update({ issue: 'tooLarge' }); return; }
    if (!this.api.nativeMemoryRead) { this.update({ issue: 'unsupported' }); return; }
    const generation = this.entered();
    this.update({ busy: 'edit', issue: undefined, confirm: undefined, notice: undefined });
    try {
      let offset = 0, content = '';
      do {
        if (!this.owns(generation)) return;
        const result = await this.api.nativeMemoryRead(this.workspaceId, selected.name, { offset, limit: 8000, expectedRevision: selected.revision });
        if (!this.owns(generation)) return;
        if (result.status === 'missing' || result.status === 'conflict') { this.update({ busy: undefined, issue: result.status }); return; }
        if (result.status !== 'found') throw new Error('Invalid read status.');
        validPage(result.note, this.workspaceId, selected.name, selected.revision, offset, 8000, selected.totalCharacters);
        content += result.note.text;
        if (content.length > NATIVE_MEMORY_LIMITS.content) { this.update({ busy: undefined, issue: 'tooLarge' }); return; }
        offset = result.note.nextOffset ?? selected.totalCharacters;
      } while (offset < selected.totalCharacters);
      this.update({ busy: undefined });
      this.keepDraft({ name: selected.name, content, initial: content, revision: selected.revision });
    } catch (error) { if (this.owns(generation)) this.failed(error); }
  };
  changeDraft = (change: { name?: string; content?: string }) => {
    if (!this.allowed() || !this.state.draft) return;
    const { name, content } = change;
    if (content !== undefined && content.length > NATIVE_MEMORY_LIMITS.content) { this.update({ issue: 'invalidContent' }); return; }
    if (name !== undefined && name.length > 64) { this.update({ issue: 'invalidName' }); return; }
    if (this.keepDraft({ ...this.state.draft, ...(content === undefined ? {} : { content }), ...(name === undefined || this.state.draft.revision !== null ? {} : { name }) })) this.update({ confirm: undefined, issue: this.state.issue === 'unsupported' ? 'unsupported' : undefined });
  };
  cancelDraft = () => {
    if (!this.allowed() || !this.state.draft) return;
    if (memoryDraftDirty(this.state.draft)) this.update({ confirm: 'discard' });
    else { this.forgetDraft(); this.update({ draft: undefined, confirm: undefined, issue: undefined }); }
  };
  keep = () => { if (this.allowed()) this.update({ confirm: undefined }); };
  discard = () => { if (this.allowed() && this.state.confirm === 'discard') { this.forgetDraft(); this.update({ draft: undefined, selected: undefined, confirm: undefined, issue: undefined }); } };
  save = async () => {
    const draft = this.state.draft;
    if (!this.canMutate() || !draft || !this.api.nativeMemoryWrite || this.state.confirm || this.state.issue === 'invalidContent' || this.state.issue === 'invalidName') return;
    let request;
    try { normalizeMemoryName(draft.name); } catch { this.update({ issue: 'invalidName' }); return; }
    try { request = normalizeMemoryWrite({ name: draft.name, content: draft.content, expectedRevision: draft.revision }); }
    catch { this.update({ issue: 'invalidContent' }); return; }
    const generation = this.entered();
    this.update({ busy: 'save', issue: undefined, notice: undefined });
    try {
      const result = await this.api.nativeMemoryWrite(this.workspaceId, request);
      if (!this.owns(generation)) return;
      if (result.status === 'conflict') { this.update({ busy: undefined, issue: 'conflict' }); return; }
      if (result.status !== 'saved') throw new Error('Invalid save result.');
      normalizeMemoryReadOptions({ expectedRevision: result.revision });
      if (!Number.isSafeInteger(result.masked) || result.masked < 0) throw new Error('Invalid save result.');
      this.forgetDraft();
      this.update({ busy: undefined, draft: undefined, selected: undefined, notice: 'saved', masked: result.masked });
      await this.refresh();
    } catch (error) { if (this.owns(generation)) this.failed(error); }
  };
  requestDelete = () => {
    if (this.canMutate() && this.state.selected && !this.state.draft && this.api.nativeMemoryDelete && this.state.issue !== 'conflict' && this.state.issue !== 'missing') this.update({ confirm: 'delete', issue: undefined, notice: undefined });
  };
  delete = async () => {
    const selected = this.state.selected;
    if (!this.canMutate() || !selected || this.state.draft || this.state.confirm !== 'delete' || !this.api.nativeMemoryDelete || this.state.issue === 'conflict' || this.state.issue === 'missing') return;
    const request = normalizeMemoryDelete({ name: selected.name, expectedRevision: selected.revision });
    const generation = this.entered();
    this.update({ busy: 'delete', issue: undefined });
    try {
      const result = await this.api.nativeMemoryDelete(this.workspaceId, request);
      if (!this.owns(generation)) return;
      if (result.status === 'conflict') { this.update({ busy: undefined, confirm: undefined, issue: 'conflict' }); return; }
      if (result.status !== 'deleted') throw new Error('Invalid delete result.');
      this.update({ busy: undefined, selected: undefined, confirm: undefined, notice: 'deleted' });
      await this.refresh();
    } catch (error) { if (this.owns(generation)) this.failed(error); }
  };
}
