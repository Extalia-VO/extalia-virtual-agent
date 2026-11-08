import type { NativeMemoryPage, NativeMemoryReadResult } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryContextPanel } from '../src/chat/MemoryContextPanel';
import { focusWorkspaceMemory, WorkspaceMemoryView } from '../src/chat/WorkspaceMemoryPanel';
import { MEMORY_DRAFT_SLOTS, memoryDraftStore, WorkspaceMemoryController, WorkspaceMemoryDraftStore, type MemoryApi } from '../src/chat/workspaceMemoryModel';
import { MESSAGES } from '../src/i18n';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(contents: Record<string, string> = { workflow: '# Workflow\nVerify current files.' }) {
  const notes = new Map(Object.entries(contents).map(([name, text]) => [name, { text, revision: A }]));
  const api: Required<MemoryApi> = {
    nativeMemoryList: vi.fn(async (workspaceId, options) => {
      const offset = options?.offset ?? 0, limit = options?.limit ?? 20;
      const all = [...notes].map(([name, note]) => ({ name, summary: note.text.split('\n')[0]!, revision: note.revision, updatedAt: '2026-10-08T00:00:00.000Z' }));
      const end = Math.min(all.length, offset + limit);
      return { workspaceId, notes: all.slice(offset, end), omitted: all.length - end, incomplete: false, ...(end < all.length ? { nextOffset: end } : {}) };
    }),
    nativeMemoryRead: vi.fn(async (workspaceId, name, options): Promise<NativeMemoryReadResult> => {
      const note = notes.get(name);
      if (!note) return { status: 'missing' };
      if (options?.expectedRevision !== note.revision) return { status: 'conflict' };
      const points = Array.from(note.text), offset = options?.offset ?? 0;
      const end = Math.min(points.length, offset + (options?.limit ?? 2000));
      return { status: 'found', note: { workspaceId, name, revision: note.revision, offset, text: points.slice(offset, end).join(''), totalCharacters: points.length,
        offsetUnit: 'unicode-code-points', truncated: offset > 0 || end < points.length, ...(end < points.length ? { nextOffset: end } : {}) } };
    }),
    nativeMemoryWrite: vi.fn(async (_workspaceId, input) => {
      if ((notes.get(input.name)?.revision ?? null) !== input.expectedRevision) return { status: 'conflict' as const };
      notes.set(input.name, { text: input.content, revision: B });
      return { status: 'saved' as const, revision: B, masked: 0 };
    }),
    nativeMemoryDelete: vi.fn(async (_workspaceId, input) => {
      if (notes.get(input.name)?.revision !== input.expectedRevision) return { status: 'conflict' as const };
      notes.delete(input.name); return { status: 'deleted' as const };
    }),
  };
  let visible = true;
  const controller = new WorkspaceMemoryController(api, 'workspace-a', () => visible);
  const ready = async () => { controller.open(); await vi.waitFor(() => expect(controller.snapshot().phase).toBe('ready')); };
  return { api, notes, controller, ready, hide: () => { visible = false; }, show: () => { visible = true; } };
}
const render = (controller: WorkspaceMemoryController, language: 'en' | 'id' = 'en') => renderToStaticMarkup(createElement(WorkspaceMemoryView, {
  controller, state: controller.snapshot(), t: MESSAGES[language],
}));

describe('lazy workspace memory and scoped continuations', () => {
  it('makes no request before expansion and sends bounded list/read continuations', async () => {
    const f = fixture(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`note-${i}`, '🙂'.repeat(3000)])));
    expect(f.api.nativeMemoryList).not.toHaveBeenCalled();
    await f.ready();
    expect(f.api.nativeMemoryList).toHaveBeenLastCalledWith('workspace-a', { offset: 0, limit: 20 });
    expect(f.controller.snapshot().notes).toHaveLength(20);
    await f.controller.refresh(true);
    expect(f.api.nativeMemoryList).toHaveBeenLastCalledWith('workspace-a', { offset: 20, limit: 20 });
    expect(f.controller.snapshot().notes).toHaveLength(25);
    await f.controller.read('note-0');
    expect(f.api.nativeMemoryRead).toHaveBeenLastCalledWith('workspace-a', 'note-0', { offset: 0, limit: 2000, expectedRevision: A });
    await f.controller.read('note-0', true);
    expect(f.api.nativeMemoryRead).toHaveBeenLastCalledWith('workspace-a', 'note-0', { offset: 2000, limit: 2000, expectedRevision: A });
    expect(f.controller.snapshot().selected?.text).toBe('🙂'.repeat(1000));
  });

  it('ignores a late catalog after close and prevents requests from retained handlers', async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<Required<MemoryApi>['nativeMemoryList']>>>();
    f.api.nativeMemoryList = vi.fn(() => pending.promise);
    f.controller.open(); f.hide(); f.controller.pause();
    pending.resolve({ workspaceId: 'workspace-a', notes: [], omitted: 0, incomplete: false });
    await Promise.resolve();
    expect(f.controller.snapshot().phase).toBe('idle');
    await f.controller.refresh(); f.controller.create();
    expect(f.api.nativeMemoryList).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot().draft).toBeUndefined();
  });

  it('rejects stale owner reads and stops a complete-note load before its next request', async () => {
    const f = fixture({ workflow: 'a'.repeat(16_000) }); await f.ready(); await f.controller.read('workflow');
    const original = f.api.nativeMemoryRead;
    const firstPage = await original('workspace-a', 'workflow', { offset: 0, limit: 8000, expectedRevision: A });
    const pending = deferred<NativeMemoryReadResult>();
    f.api.nativeMemoryRead = vi.fn(() => pending.promise);
    const editing = f.controller.edit();
    f.hide(); pending.resolve(firstPage); await editing;
    expect(f.api.nativeMemoryRead).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot().draft).toBeUndefined();
    f.controller.pause(); f.show(); f.controller.open();
    expect(f.controller.snapshot().draft).toBeUndefined();
  });

  it('keeps a draft over close/reopen and blocks stale writes after a scope or host replacement', async () => {
    const f = fixture(); await f.ready(); f.controller.create(); f.controller.changeDraft({ name: 'new-note', content: 'Confirmed fact' });
    f.hide(); f.controller.pause(); await f.controller.save();
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    expect(f.controller.snapshot().draft?.content).toBe('Confirmed fact');
    const replacement = fixture(); await replacement.ready();
    await f.controller.save(); f.controller.requestDelete(); await f.controller.delete();
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    expect(f.api.nativeMemoryDelete).not.toHaveBeenCalled();
    f.show(); f.controller.open(); await f.controller.save();
    expect(f.api.nativeMemoryWrite).toHaveBeenCalledWith('workspace-a', { name: 'new-note', content: 'Confirmed fact', expectedRevision: null });
  });

  it('does not publish a late save or issue its refresh after closing', async () => {
    const f = fixture(); await f.ready(); f.controller.create(); f.controller.changeDraft({ name: 'new-note', content: 'Confirmed fact' });
    const pending = deferred<Awaited<ReturnType<Required<MemoryApi>['nativeMemoryWrite']>>>();
    f.api.nativeMemoryWrite = vi.fn(() => pending.promise);
    const saving = f.controller.save(); f.hide(); f.controller.pause();
    pending.resolve({ status: 'saved', revision: B, masked: 0 }); await saving;
    expect(f.api.nativeMemoryList).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot().draft?.content).toBe('Confirmed fact');
    expect(f.controller.snapshot().notice).toBeUndefined();
  });
});

describe('complete, guarded workspace memory edits', () => {
  it('loads contiguous pages at one revision before exposing the complete editor', async () => {
    const text = 'a'.repeat(8000) + '🙂'.repeat(4000);
    const f = fixture({ workflow: text }); await f.ready(); await f.controller.read('workflow');
    expect(f.controller.snapshot().selected?.text.length).toBe(2000);
    expect(f.controller.snapshot().draft).toBeUndefined();
    await f.controller.edit();
    expect(f.controller.snapshot().draft?.content).toBe(text);
    expect(f.api.nativeMemoryRead).toHaveBeenNthCalledWith(2, 'workspace-a', 'workflow', { offset: 0, limit: 8000, expectedRevision: A });
    expect(f.api.nativeMemoryRead).toHaveBeenNthCalledWith(3, 'workspace-a', 'workflow', { offset: 8000, limit: 8000, expectedRevision: A });
    f.controller.changeDraft({ content: text + '\nConfirmed update', name: 'cannot-rename' }); await f.controller.save();
    expect(f.api.nativeMemoryWrite).toHaveBeenCalledWith('workspace-a', { name: 'workflow', content: text + '\nConfirmed update', expectedRevision: A });
    expect(f.controller.snapshot().notice).toBe('saved');
  });

  it('refuses a note changed between edit pages, with no editable partial content', async () => {
    const f = fixture({ workflow: 'a'.repeat(12_000) }); await f.ready(); await f.controller.read('workflow');
    const original = f.api.nativeMemoryRead;
    f.api.nativeMemoryRead = vi.fn(async (...args: Parameters<Required<MemoryApi>['nativeMemoryRead']>) => {
      const result = await original(...args);
      if (args[2]?.offset === 0) f.notes.set('workflow', { text: 'Changed externally', revision: B });
      return result;
    });
    await f.controller.edit();
    expect(f.controller.snapshot().issue).toBe('conflict');
    expect(f.controller.snapshot().draft).toBeUndefined();
    await f.controller.save();
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
  });

  it('refuses skipped, mismatched and foreign pages instead of silently filling an editor', async () => {
    for (const corrupt of [
      (page: NativeMemoryPage) => ({ ...page, nextOffset: 9000 }),
      (page: NativeMemoryPage) => ({ ...page, revision: B }),
      (page: NativeMemoryPage) => ({ ...page, workspaceId: 'workspace-b' }),
    ]) {
      const f = fixture({ workflow: 'a'.repeat(12_000) }); await f.ready(); await f.controller.read('workflow');
      const original = f.api.nativeMemoryRead;
      f.api.nativeMemoryRead = vi.fn(async (...args: Parameters<Required<MemoryApi>['nativeMemoryRead']>) => {
        const result = await original(...args);
        return result.status === 'found' ? { status: 'found' as const, note: corrupt(result.note) } : result;
      });
      await f.controller.edit();
      expect(f.controller.snapshot().issue).toBe('unavailable');
      expect(f.controller.snapshot().draft).toBeUndefined();
      expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    }
  });

  it('keeps external oversized notes read-only, including Unicode notes over the JS content limit', async () => {
    for (const text of ['a'.repeat(20_001), '🙂'.repeat(12_000)]) {
      const f = fixture({ workflow: text }); await f.ready(); await f.controller.read('workflow'); await f.controller.edit();
      expect(f.controller.snapshot().issue).toBe('tooLarge');
      expect(f.controller.snapshot().draft).toBeUndefined();
      expect(render(f.controller)).toContain('This external note exceeds the editing limit.');
      expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    }
  });

  it('validates new-note requests and never replaces an existing note through create', async () => {
    const f = fixture(); await f.ready(); f.controller.create();
    f.controller.changeDraft({ name: '../workflow', content: 'New' }); await f.controller.save();
    expect(f.controller.snapshot().issue).toBe('invalidName');
    f.controller.changeDraft({ name: 'new-note', content: ' ' }); await f.controller.save();
    expect(f.controller.snapshot().issue).toBe('invalidContent');
    f.controller.changeDraft({ content: 'a'.repeat(20_001) }); await f.controller.save();
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    f.controller.changeDraft({ name: 'workflow', content: 'Do not overwrite' }); await f.controller.save();
    expect(f.api.nativeMemoryWrite).toHaveBeenCalledWith('workspace-a', { name: 'workflow', content: 'Do not overwrite', expectedRevision: null });
    expect(f.controller.snapshot().issue).toBe('conflict');
    expect(f.controller.snapshot().draft?.content).toBe('Do not overwrite');
    expect(f.notes.get('workflow')?.text).toContain('Verify current files');
  });

  it('keeps a conflicting edit and requires explicit discard before refreshing', async () => {
    const f = fixture(); await f.ready(); await f.controller.read('workflow'); await f.controller.edit();
    f.controller.changeDraft({ content: 'My confirmed update' }); f.notes.set('workflow', { text: 'External update', revision: B });
    await f.controller.save();
    expect(f.controller.snapshot().draft?.content).toBe('My confirmed update');
    expect(f.controller.snapshot().issue).toBe('conflict');
    await f.controller.refresh(); expect(f.api.nativeMemoryList).toHaveBeenCalledTimes(1);
    f.controller.cancelDraft(); expect(f.controller.snapshot().confirm).toBe('discard');
    f.controller.keep(); expect(f.controller.snapshot().draft).toBeDefined();
    f.controller.cancelDraft(); f.controller.discard(); await f.controller.refresh();
    expect(f.controller.snapshot().draft).toBeUndefined();
    expect(f.controller.snapshot().notes[0]?.revision).toBe(B);
  });

  it('requires a visible delete confirmation and checks the revision again at deletion', async () => {
    const f = fixture(); await f.ready(); await f.controller.read('workflow');
    await f.controller.delete(); expect(f.api.nativeMemoryDelete).not.toHaveBeenCalled();
    f.controller.requestDelete();
    expect(render(f.controller)).toContain('Delete “workflow” from this workspace’s Native memory?');
    f.notes.set('workflow', { text: 'Changed', revision: B }); await f.controller.delete();
    expect(f.api.nativeMemoryDelete).toHaveBeenCalledWith('workspace-a', { name: 'workflow', expectedRevision: A });
    expect(f.notes.has('workflow')).toBe(true);
    expect(f.controller.snapshot().issue).toBe('conflict');
    await f.controller.refresh(); await f.controller.read('workflow'); f.controller.requestDelete(); await f.controller.delete();
    expect(f.notes.has('workflow')).toBe(false);
    expect(f.controller.snapshot().notice).toBe('deleted');
  });
});

describe('honest memory states and plain-text rendering', () => {
  it('blocks proxy mutations after unsupported discovery while keeping the complete draft available to copy', async () => {
    const f = fixture(); await f.ready(); f.controller.create(); f.controller.changeDraft({ name: 'new-note', content: 'Keep this user draft' });
    f.api.nativeMemoryList = vi.fn(async () => { throw new Error('Unknown agent host method.'); });
    await f.controller.recheck();
    expect(f.controller.snapshot().phase).toBe('unsupported');
    const html = render(f.controller);
    expect(html).not.toContain('New note</button>');
    expect(html).not.toContain('Delete note</button>');
    expect(html).toContain('type="submit" class="button small" disabled=""');
    expect(html).toContain('Keep this user draft');
    expect(html).toContain('Copy memory draft');
    await f.controller.save(); f.controller.requestDelete(); await f.controller.delete();
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    expect(f.api.nativeMemoryDelete).not.toHaveBeenCalled();
    f.controller.cancelDraft(); f.controller.discard(); f.controller.create();
    expect(f.controller.snapshot().draft).toBeUndefined();
  });

  it('never reports an incomplete or failed catalog as an empty workspace', async () => {
    const f = fixture();
    f.api.nativeMemoryList = vi.fn(async workspaceId => ({ workspaceId, notes: [], omitted: 0, incomplete: true }));
    await f.ready();
    expect(render(f.controller)).toContain(MESSAGES.en.workspaceMemory.partial);
    expect(render(f.controller)).not.toContain(MESSAGES.en.workspaceMemory.empty);
    f.api.nativeMemoryList = vi.fn(async () => { throw new Error('Private host path details'); });
    await f.controller.refresh();
    const html = render(f.controller);
    expect(html).toContain(MESSAGES.en.workspaceMemory.issues.unavailable);
    expect(html).not.toContain('Private host path details');
    expect(html).not.toContain(MESSAGES.en.workspaceMemory.empty);
  });

  it('handles unsupported peers, missing notes and foreign catalogs explicitly', async () => {
    const unsupported = new WorkspaceMemoryController({}, 'workspace-a', () => true); unsupported.open();
    expect(render(unsupported)).toContain(MESSAGES.en.workspaceMemory.issues.unsupported);
    const f = fixture(); await f.ready(); f.notes.delete('workflow'); await f.controller.read('workflow');
    expect(render(f.controller)).toContain(MESSAGES.en.workspaceMemory.issues.missing);
    f.api.nativeMemoryList = vi.fn(async () => ({ workspaceId: 'foreign', notes: [], omitted: 0, incomplete: false }));
    await f.controller.refresh(); expect(f.controller.snapshot().phase).toBe('unavailable');
  });

  it('recognizes existing Bridge and Desktop unsupported-operation replies without exposing them', async () => {
    for (const message of ['This host does not support this action.', 'Unknown method.', 'Unknown agent host method.']) {
      const f = fixture();
      f.api.nativeMemoryList = vi.fn(async () => { throw new Error(message); });
      f.controller.open(); await vi.waitFor(() => expect(f.controller.snapshot().phase).toBe('unsupported'));
      expect(render(f.controller)).toContain(MESSAGES.en.workspaceMemory.issues.unsupported);
      expect(render(f.controller)).not.toContain(MESSAGES.en.workspaceMemory.empty);
    }
  });

  it('renders invalid and busy editor actions disabled while retaining a conflicting user draft', async () => {
    const f = fixture(); await f.ready(); f.controller.create();
    expect(render(f.controller)).toContain('type="submit" class="button small" disabled=""');
    f.controller.changeDraft({ name: 'workflow', content: '<h1>My unchanged wording</h1>' }); await f.controller.save();
    const html = render(f.controller);
    expect(html).toContain(MESSAGES.en.workspaceMemory.issues.conflict);
    expect(html).toContain('&lt;h1&gt;My unchanged wording&lt;/h1&gt;');
    expect(html).toContain('maxLength="20000"');
    expect(html).toContain('Refresh notes</button>');
    expect(html).not.toContain('<h1>My unchanged wording</h1>');
    f.controller.cancelDraft();
    expect(render(f.controller)).toContain('Discard your unsaved note changes?');
    expect(render(f.controller)).toContain('type="submit" class="button small" disabled=""');
  });

  it('escapes note content and names, renders Indonesian controls, and keeps user text unchanged', async () => {
    const body = '<script>alert("example")</script>\nUser wording stays unchanged.';
    const f = fixture({ workflow: body }); await f.ready(); await f.controller.read('workflow');
    const html = render(f.controller, 'id');
    expect(html).toContain('Catatan workspace');
    expect(html).toContain('Edit catatan lengkap');
    expect(html).toContain('User wording stays unchanged.');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('meski ingatan agent nonaktif');
  });

  it('does not mount the browser or read any data in a collapsed parent disclosure', () => {
    const f = fixture();
    const html = renderToStaticMarkup(createElement(MemoryContextPanel, {
      t: MESSAGES.en, language: 'en', id: 'details', workspaceName: 'Example', workspaceId: 'workspace-a', ownerKey: 'owner',
      agents: f.api as never, onOpenSettings() {}, onOpenSkills() {},
    }));
    expect(html).not.toContain('Workspace notes');
    expect(f.api.nativeMemoryList).not.toHaveBeenCalled();
    expect(f.api.nativeMemoryRead).not.toHaveBeenCalled();
  });
});

describe('bounded navigation draft retention', () => {
  const activate = async (controller: WorkspaceMemoryController) => { controller.open(); await vi.waitFor(() => expect(controller.snapshot().phase).toBe('ready')); };

  it('restores an unsaved draft after page, session and connection navigation without writing it', async () => {
    const f = fixture();
    const store = memoryDraftStore(f.api);
    const key = JSON.stringify(['profile-a', '/example/profile-a', 'workspace-a']);
    const first = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key });
    await activate(first); first.create(); first.changeDraft({ name: 'new-note', content: 'User draft kept across navigation' }); first.pause();
    const returned = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key });
    expect(returned.snapshot().draft?.content).toBe('User draft kept across navigation');
    expect(returned.snapshot().notice).toBe('restored');
    await activate(returned);
    expect(returned.snapshot().draft?.content).toBe('User draft kept across navigation');
    expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    await first.save(); expect(f.api.nativeMemoryWrite).not.toHaveBeenCalled();
    returned.pause();
    const changedSession = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key });
    await activate(changedSession);
    expect(changedSession.snapshot().draft?.name).toBe('new-note');
    await changedSession.save();
    expect(f.api.nativeMemoryWrite).toHaveBeenCalledWith('workspace-a', { name: 'new-note', content: 'User draft kept across navigation', expectedRevision: null });
    expect(store.get(key)).toBeUndefined();
  });

  it('isolates the same workspace id across profiles, data directories and API host objects', async () => {
    const f = fixture();
    const store = memoryDraftStore(f.api);
    const key = JSON.stringify(['profile-a', '/example/profile-a', 'workspace-a']);
    const first = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key });
    await activate(first); first.create(); first.changeDraft({ name: 'new-note', content: 'Only profile A' }); first.pause();
    for (const otherKey of [JSON.stringify(['profile-b', '/example/profile-a', 'workspace-a']), JSON.stringify(['profile-a', '/example/profile-b', 'workspace-a'])]) {
      const other = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key: otherKey });
      await activate(other); expect(other.snapshot().draft).toBeUndefined(); other.pause();
    }
    const otherHost = fixture();
    const other = new WorkspaceMemoryController(otherHost.api, 'workspace-a', () => true, { store: memoryDraftStore(otherHost.api), key });
    await activate(other); expect(other.snapshot().draft).toBeUndefined();
    const returned = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key });
    expect(returned.snapshot().draft?.content).toBe('Only profile A');
  });

  it('refuses another editor at capacity without evicting any unsaved draft', async () => {
    const f = fixture(), store = new WorkspaceMemoryDraftStore();
    const controllers: WorkspaceMemoryController[] = [];
    for (let index = 0; index < MEMORY_DRAFT_SLOTS; index++) {
      const controller = new WorkspaceMemoryController(f.api, `workspace-${index}`, () => true, { store, key: `profile-a:workspace-${index}` });
      await activate(controller); controller.create(); controller.changeDraft({ name: 'new-note', content: `Draft ${index}` }); controller.pause(); controllers.push(controller);
    }
    const overflow = new WorkspaceMemoryController(f.api, 'workspace-extra', () => true, { store, key: 'profile-a:workspace-extra' });
    await activate(overflow); overflow.create();
    expect(overflow.snapshot().issue).toBe('draftLimit');
    expect(overflow.snapshot().draft).toBeUndefined();
    for (let index = 0; index < MEMORY_DRAFT_SLOTS; index++) expect(store.get(`profile-a:workspace-${index}`)?.content).toBe(`Draft ${index}`);
    const first = controllers[0]!; first.open(); first.cancelDraft(); first.discard();
    overflow.create(); expect(overflow.snapshot().draft).toBeDefined();
  });

  it('publishes dirty counts independently of mounted panels, with clean reservations excluded and unsubscribe cleanup', () => {
    const store = new WorkspaceMemoryDraftStore();
    const changed = vi.fn(); const unsubscribe = store.subscribe(changed);
    const empty = { name: '', content: '', initial: '', revision: null };
    expect(store.put('profile-a:workspace-a', empty)).toBe(true);
    expect(store.dirtyCount()).toBe(0); expect(changed).not.toHaveBeenCalled();
    const first = { ...empty, name: 'new-note', content: 'Retained while Knowledge is open' };
    store.put('profile-a:workspace-a', first);
    expect(store.dirtyCount()).toBe(1); expect(changed).toHaveBeenCalledTimes(1);
    const second = { ...empty, name: 'another-note', content: 'Another workspace draft' };
    store.put('profile-b:workspace-b', second);
    expect(store.dirtyCount()).toBe(2); expect(changed).toHaveBeenCalledTimes(2);
    store.forget('profile-a:workspace-a', empty);
    expect(store.dirtyCount()).toBe(2);
    store.forget('profile-a:workspace-a', first);
    expect(store.dirtyCount()).toBe(1); expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe(); store.forget('profile-b:workspace-b', second);
    expect(store.dirtyCount()).toBe(0); expect(changed).toHaveBeenCalledTimes(3);
  });

  it('clears retained dirty counts after a confirmed save or discard', async () => {
    const f = fixture(), store = memoryDraftStore(f.api);
    const controller = new WorkspaceMemoryController(f.api, 'workspace-a', () => true, { store, key: 'profile-a:workspace-a' });
    await activate(controller); controller.create(); controller.changeDraft({ name: 'new-note', content: 'Confirmed fact' });
    expect(store.dirtyCount()).toBe(1);
    await controller.save(); expect(store.dirtyCount()).toBe(0);
    controller.create(); controller.changeDraft({ name: 'another-note', content: 'Discard this draft' });
    controller.cancelDraft(); expect(store.dirtyCount()).toBe(1);
    controller.discard(); expect(store.dirtyCount()).toBe(0);
  });
});

describe('malformed remote memory statuses', () => {
  it('turns invalid read and full-edit statuses into a visible unavailable state', async () => {
    const f = fixture(); await f.ready();
    const read = f.api.nativeMemoryRead;
    f.api.nativeMemoryRead = vi.fn(async () => ({ status: 'unknown-peer-status' } as never));
    await f.controller.read('workflow'); expect(f.controller.snapshot().issue).toBe('unavailable');
    expect(render(f.controller)).toContain(MESSAGES.en.workspaceMemory.issues.unavailable);
    f.api.nativeMemoryRead = read; await f.controller.read('workflow');
    f.api.nativeMemoryRead = vi.fn(async () => ({ status: 'unknown-peer-status' } as never));
    await f.controller.edit(); expect(f.controller.snapshot().issue).toBe('unavailable');
    expect(f.controller.snapshot().draft).toBeUndefined();
  });

  it('preserves the draft and avoids success claims for malformed write replies', async () => {
    for (const result of [{ status: 'unknown-peer-status' }, { status: 'saved', revision: 'invalid', masked: 0 }]) {
      const f = fixture(); await f.ready(); f.controller.create(); f.controller.changeDraft({ name: 'new-note', content: 'Keep my draft' });
      f.api.nativeMemoryWrite = vi.fn(async () => result as never);
      await f.controller.save();
      expect(f.controller.snapshot().issue).toBe('unavailable');
      expect(f.controller.snapshot().draft?.content).toBe('Keep my draft');
      expect(f.controller.snapshot().notice).toBeUndefined();
      expect(f.api.nativeMemoryList).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the selected note and avoids a deletion claim for a malformed delete reply', async () => {
    const f = fixture(); await f.ready(); await f.controller.read('workflow'); f.controller.requestDelete();
    f.api.nativeMemoryDelete = vi.fn(async () => ({ status: 'unknown-peer-status' } as never));
    await f.controller.delete();
    expect(f.controller.snapshot().issue).toBe('unavailable');
    expect(f.controller.snapshot().selected?.name).toBe('workflow');
    expect(f.controller.snapshot().notice).toBeUndefined();
    expect(f.api.nativeMemoryList).toHaveBeenCalledTimes(1);
  });
});

describe('memory detail focus and scoped scrolling', () => {
  it('focuses the selected note and reveals it only inside its own memory panel', () => {
    const scrollPage = vi.fn(); vi.stubGlobal('window', { scrollTo: scrollPage });
    try {
      const target = { focus: vi.fn(), getBoundingClientRect: () => ({ top: 450 }), scrollIntoView: vi.fn() };
      const region = { scrollTop: 40, getBoundingClientRect: () => ({ top: 100 }) };
      const unrelatedRegion = { scrollTop: 77 };
      const root = { isConnected: true, querySelector: (selector: string) => selector === '[data-memory-focus="reader"]' ? target : null, closest: () => region };
      expect(focusWorkspaceMemory(root as unknown as HTMLElement, 'reader')).toBe(true);
      expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(region.scrollTop).toBe(382);
      expect(unrelatedRegion.scrollTop).toBe(77);
      expect(scrollPage).not.toHaveBeenCalled();
      expect(target.scrollIntoView).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('starts a new draft at its name field and an existing edit at its text area', () => {
    const name = { focus: vi.fn(), getBoundingClientRect: () => ({ top: 200 }) };
    const text = { focus: vi.fn(), getBoundingClientRect: () => ({ top: 240 }) };
    const region = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) };
    let newDraft = true;
    const root = { isConnected: true, closest: () => region, querySelector: (selector: string) => selector.includes('input') ? newDraft ? name : null : text };
    expect(focusWorkspaceMemory(root as unknown as HTMLElement, 'editor')).toBe(true);
    expect(name.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(text.focus).not.toHaveBeenCalled();
    newDraft = false;
    expect(focusWorkspaceMemory(root as unknown as HTMLElement, 'editor')).toBe(true);
    expect(text.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('never focuses a detached view', () => {
    const querySelector = vi.fn();
    expect(focusWorkspaceMemory({ isConnected: false, querySelector } as unknown as HTMLElement, 'reader')).toBe(false);
    expect(querySelector).not.toHaveBeenCalled();
  });
});
