import { NATIVE_MEMORY_LIMITS, type AgentHostApi } from '@extalia/platform';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { CopyButton } from '../ui/CopyButton';
import { memoryDraftDirty, memoryDraftStore, WorkspaceMemoryController, type WorkspaceMemoryState } from './workspaceMemoryModel';

type PanelProps = {
  t: Messages; agents: AgentHostApi; workspaceId: string; ownerKey: string; draftKey: string; active: boolean; isOpen(): boolean;
};
export function WorkspaceMemoryPanel(props: PanelProps) {
  const [binding, setBinding] = useState({ agents: props.agents, workspaceId: props.workspaceId, ownerKey: props.ownerKey, draftKey: props.draftKey, key: 0 });
  if (binding.agents !== props.agents || binding.workspaceId !== props.workspaceId || binding.ownerKey !== props.ownerKey || binding.draftKey !== props.draftKey) {
    setBinding({ agents: props.agents, workspaceId: props.workspaceId, ownerKey: props.ownerKey, draftKey: props.draftKey, key: binding.key + 1 });
  }
  return <BoundWorkspaceMemoryPanel key={binding.key} {...props} />;
}
function BoundWorkspaceMemoryPanel({ t, agents, workspaceId, draftKey, active, isOpen }: PanelProps) {
  const [controller] = useState(() => new WorkspaceMemoryController(agents, workspaceId, isOpen, { store: memoryDraftStore(agents), key: draftKey }));
  // Retire closed/replaced owners during commit, before another event can invoke a stale control.
  useLayoutEffect(() => {
    if (active) controller.open(); else controller.pause();
    return () => controller.pause();
  }, [active, controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const root = useRef<HTMLElement>(null);
  const focused = useRef<string | undefined>(undefined);
  const focusKey = state.draft ? `editor:${state.draft.revision === null ? 'new' : `${state.draft.name}:${state.draft.revision}`}`
    : state.selected ? `reader:${state.selected.name}:${state.selected.revision}:${state.selected.offset}` : undefined;
  useLayoutEffect(() => {
    if (!focusKey) { focused.current = undefined; return; }
    if (!active || state.busy || focused.current === focusKey || !root.current) return;
    if (focusWorkspaceMemory(root.current, focusKey.startsWith('editor:') ? 'editor' : 'reader')) focused.current = focusKey;
  }, [active, state.busy, focusKey]);
  const draftOwner = useId();
  useUnsavedDraft(draftOwner, Boolean(state.draft && memoryDraftDirty(state.draft)));
  return <WorkspaceMemoryView t={t} state={state} controller={controller} rootRef={root} />;
}

/** Keep the conversation stationary; reveal the chosen detail only in this disclosure's scroller. */
export function focusWorkspaceMemory(root: HTMLElement, mode: 'reader' | 'editor'): boolean {
  if (!root.isConnected) return false;
  const target = mode === 'reader' ? root.querySelector<HTMLElement>('[data-memory-focus="reader"]')
    : root.querySelector<HTMLElement>('.workspace-memory-editor input:not([disabled])') ?? root.querySelector<HTMLElement>('.workspace-memory-editor textarea');
  const region = root.closest<HTMLElement>('.memory-context-body');
  if (!target || !region) return false;
  target.focus({ preventScroll: true });
  region.scrollTop = Math.max(0, region.scrollTop + target.getBoundingClientRect().top - region.getBoundingClientRect().top - 8);
  return true;
}

/** Plain text only: memory is user content, never executable markup or activated instructions. */
export function WorkspaceMemoryView({ t, state, controller, rootRef }: { t: Messages; state: WorkspaceMemoryState; controller: WorkspaceMemoryController; rootRef?: Ref<HTMLElement> }) {
  const m = t.workspaceMemory;
  const busy = Boolean(state.busy);
  const draft = state.draft;
  const selected = state.selected;
  const stale = state.issue === 'conflict' || state.issue === 'missing';
  const unsupported = state.phase === 'unsupported' || state.issue === 'unsupported';
  const mutable = state.phase === 'ready' && !unsupported;
  const supportedWrite = typeof controller.api.nativeMemoryWrite === 'function' && !unsupported;
  const canSave = draft && /^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.name) && draft.content.trim().length > 0
    && draft.content.length <= NATIVE_MEMORY_LIMITS.content && memoryDraftDirty(draft);
  return <section ref={rootRef} className="workspace-memory" aria-label={m.title}>
    <h3>{m.title}</h3>
    <p className="muted">{m.lead}</p>
    <div className="memory-context-actions">
      <button type="button" className="button small" disabled={busy || Boolean(draft)} onClick={() => void controller.refresh()}>{m.refresh}</button>
      {supportedWrite && <button type="button" className="button small" disabled={busy || Boolean(draft) || !mutable} onClick={controller.create}>{m.create}</button>}
    </div>
    {(state.phase === 'loading' || state.busy) && <p role="status">{state.busy ? m.busy[state.busy] : m.busy.list}</p>}
    {(state.phase === 'unsupported' || state.phase === 'unavailable') && <p role="alert">{m.issues[state.phase]}</p>}
    {(unsupported || state.phase === 'unavailable') && <button type="button" className="button small" disabled={busy} onClick={() => void controller.recheck()}>{t.common.retry}</button>}
    {state.issue && state.issue !== state.phase && <p role="alert">{m.issues[state.issue]}</p>}
    {state.notice && <p role="status">{m.notices[state.notice]}{state.notice === 'saved' && Boolean(state.masked) && ` ${m.masked(state.masked!)}`}</p>}
    {state.phase === 'ready' && <>
      {state.notes.length > 0 && <ul className="workspace-memory-list" aria-label={m.notes}>
        {state.notes.map(note => <li key={note.name}>
          <button type="button" className="button workspace-memory-note-button" disabled={busy || Boolean(draft)} aria-pressed={selected?.name === note.name} onClick={() => void controller.read(note.name)}>
            <strong>{note.name}</strong><span>{note.summary}</span>
          </button>
        </li>)}
      </ul>}
      {state.notes.length === 0 && !state.incomplete && state.omitted === 0 && state.nextOffset === undefined && <p>{m.empty}</p>}
      {(state.incomplete || state.omitted > 0 || state.nextOffset !== undefined) && <p className="muted">{m.partial}</p>}
      {state.nextOffset !== undefined && <button type="button" className="button small" disabled={busy || Boolean(draft)} onClick={() => void controller.refresh(true)}>{m.loadMore}</button>}
    </>}
    {selected && !draft && <section className="workspace-memory-note" aria-label={m.note(selected.name)}>
      <h4 tabIndex={-1} data-memory-focus="reader">{selected.name}</h4>
      <p className="muted">{selected.totalCharacters === 0 ? m.emptyBody : m.page(selected.offset + 1, selected.offset + Array.from(selected.text).length, selected.totalCharacters)}</p>
      <pre className="workspace-memory-text" tabIndex={0}>{selected.text}</pre>
      <div className="memory-context-actions">
        {selected.nextOffset !== undefined && <button type="button" className="button small" disabled={busy || stale || unsupported} onClick={() => void controller.read(selected.name, true)}>{m.nextPage}</button>}
        {supportedWrite && <button type="button" className="button small" disabled={busy || stale || state.issue === 'tooLarge' || selected.totalCharacters > NATIVE_MEMORY_LIMITS.content} onClick={() => void controller.edit()}>{m.edit}</button>}
        {typeof controller.api.nativeMemoryDelete === 'function' && !unsupported && <button type="button" className="button small" disabled={busy || stale || !mutable} onClick={controller.requestDelete}>{m.delete}</button>}
      </div>
      {selected.totalCharacters > NATIVE_MEMORY_LIMITS.content && <p className="muted">{m.issues.tooLarge}</p>}
      {state.confirm === 'delete' && <div className="workspace-memory-confirm" role="group" aria-label={m.deleteTitle}>
        <p>{m.deleteConfirm(selected.name)}</p>
        <div className="memory-context-actions">
          <button type="button" className="button small" disabled={busy || !mutable} onClick={() => void controller.delete()}>{m.confirmDelete}</button>
          <button type="button" className="button small" disabled={busy} onClick={controller.keep}>{t.common.cancel}</button>
        </div>
      </div>}
    </section>}
    {draft && <form className="workspace-memory-editor" aria-label={draft.revision === null ? m.create : m.edit} onSubmit={event => { event.preventDefault(); void controller.save(); }}>
      <label className="field"><span>{m.name}</span><input type="text" value={draft.name} disabled={busy || draft.revision !== null} maxLength={64}
        spellCheck={false} autoComplete="off" onChange={event => controller.changeDraft({ name: event.target.value })} /></label>
      {draft.revision === null && <p className="muted">{m.nameHint}</p>}
      <label className="field"><span>{m.content}</span><textarea rows={8} value={draft.content} disabled={busy} maxLength={NATIVE_MEMORY_LIMITS.content}
        onChange={event => controller.changeDraft({ content: event.target.value })} /></label>
      <p className="muted">{m.characterCount(draft.content.length, NATIVE_MEMORY_LIMITS.content)}</p>
      <div className="memory-context-actions">
        <button type="submit" className="button small" disabled={busy || !canSave || !mutable || Boolean(state.confirm)}>{m.save}</button>
        <button type="button" className="button small" disabled={busy} onClick={controller.cancelDraft}>{t.common.cancel}</button>
        <CopyButton text={draft.content} label={m.copyDraft} />
      </div>
      {state.confirm === 'discard' && <div className="workspace-memory-confirm" role="group" aria-label={m.discardTitle}>
        <p>{m.discardTitle}</p><div className="memory-context-actions">
          <button type="button" className="button small" disabled={busy} onClick={controller.discard}>{m.discard}</button>
          <button type="button" className="button small" disabled={busy} onClick={controller.keep}>{m.keepEditing}</button>
        </div>
      </div>}
    </form>}
  </section>;
}
