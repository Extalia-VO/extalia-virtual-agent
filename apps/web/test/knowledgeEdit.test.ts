import type { AgentHostApi, KnowledgeHistory, KnowledgeMemoryImport, KnowledgeNoteFile, KnowledgeStatus, KnowledgeWriteResult } from '@extalia/platform';
import { KNOWLEDGE_EDIT_UNSUPPORTED } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { createMockKnowledge } from '../src/host/mockKnowledge';
import { MESSAGES } from '../src/i18n';
import {
  ConflictPanelView, DiffView, HistoryView, MemoryImportView, NewNoteView, NoteEditorView, draftDirty, editorKeyAction, rollbackTo, saveDraft,
  type ConflictState, type EditorDraft, type HistoryViewProps, type NoteEditorProps,
} from '../src/knowledge/KnowledgeEdit';
import { KnowledgeView, type KnowledgeViewProps } from '../src/knowledge/KnowledgePage';
import {
  editSupport, foldDiff, importOutcomeCounts, importWrites, isEditUnsupportedMessage, isManagedText, lineDiff, newNoteText, notePathFrom, splitFrontMatter,
} from '../src/knowledge/noteEditModel';

const t = MESSAGES.en;
const e = t.knowledge.edit;
const instant = () => Promise.resolve();
type Full = Required<AgentHostApi>;

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const own = typeof node.type === 'function' ? elements((node.type as (props: unknown) => ReactNode)(node.props)) : [];
  return [node, ...own, ...elements(node.props.children as ReactNode)];
}
const byText = (node: ReactNode, label: string) => elements(node).find(element => element.type === 'button' && renderToStaticMarkup(element).includes(label));
const click = (node: ReactNode, label: string) => (byText(node, label)!.props.onClick as () => void)();

const mock = (options: { conflict?: boolean } = {}) => createMockKnowledge('sample', instant, Date.UTC(2026, 9, 24), options) as unknown as Full;
const N1 = 'Knowledge/N+1 Query Optimization.md';

describe('Knowledge edit support', () => {
  it('offers editing only when the host has the methods and the core serves them', async () => {
    const host = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const status = await host.knowledgeStatus!();
    expect(editSupport(host, status)).toEqual({ notes: true, memoryImport: true });
    // A host whose status does not report editing (an older host, or a core without the operations): read-only.
    const { editing: _editing, ...older } = status;
    expect(editSupport(host, older)).toEqual({ notes: false, memoryImport: false });
    expect(editSupport(host, { ...status, editing: { notes: true, memoryImport: false } })).toEqual({ notes: true, memoryImport: false });
    // A host without the methods (Desktop/Bridge forward names, but a direct host may lack them).
    const { writeKnowledgeNote: _write, importMemoryNotes: _import, ...withoutWrite } = host;
    expect(editSupport(withoutWrite, status)).toEqual({ notes: false, memoryImport: false });
    expect(editSupport(host, { ...status, state: 'unavailable' })).toEqual({ notes: false, memoryImport: false });
    expect(isEditUnsupportedMessage(KNOWLEDGE_EDIT_UNSUPPORTED)).toBe(true);
    expect(isEditUnsupportedMessage('This host does not support this action.')).toBe(true);
    expect(isEditUnsupportedMessage('The vault could not be read.')).toBe(false);
  });

  it('hides every edit action on a read-only host and shows them with editing', async () => {
    const host = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const status = await host.knowledgeStatus!();
    const { editing: _editing, ...readOnly } = status;
    const props = (value: KnowledgeStatus, editing?: KnowledgeViewProps['editing']): KnowledgeViewProps => ({
      t, language: 'en', status: { value, loading: false }, query: '', onQuery: vi.fn(), results: null, selectedId: null, onOpen: vi.fn(), onClose: vi.fn(),
      note: { loading: false }, links: { loading: false }, backlinks: { loading: false }, graphOpen: false, onGraphOpen: vi.fn(), depth: 1, onDepth: vi.fn(),
      graph: { loading: false }, syncing: false, onSync: vi.fn(), ...(editing ? { editing } : {}),
    });
    const plain = renderToStaticMarkup(createElement(KnowledgeView, props(readOnly)));
    for (const label of [e.newNote, e.importMemory, e.edit, e.history]) expect(plain).not.toContain(`>${label}<`);
    const withEditor = renderToStaticMarkup(createElement(KnowledgeView, props(status, { toolbar: createElement('p', null, 'TOOLBAR'), editor: createElement('p', null, 'EDITOR') })));
    expect(withEditor).toContain('TOOLBAR');
    expect(withEditor).toContain('EDITOR');
    expect(withEditor).not.toContain(t.knowledge.select);
  });
});

describe('Note editing helpers', () => {
  it('reads front matter and the managed marker', () => {
    expect(splitFrontMatter('---\nid: a\nmanaged_by: extalia\n---\n# A\n')).toEqual({ frontMatter: 'id: a\nmanaged_by: extalia', body: '# A\n' });
    expect(splitFrontMatter('# No front matter')).toEqual({ body: '# No front matter' });
    expect(isManagedText('---\nmanaged_by: extalia\n---\nx')).toBe(true);
    expect(isManagedText('---\nmanaged_by: "extalia"\n---\nx')).toBe(true);
    expect(isManagedText('---\nconflict_managed_by: extalia\n---\nx')).toBe(false);
    expect(isManagedText('managed_by: extalia\n')).toBe(false);
    expect(notePathFrom(' /Knowledge/Topic ')).toBe('Knowledge/Topic.md');
    expect(notePathFrom('Inbox.md')).toBe('Inbox.md');
    expect(() => notePathFrom('../x')).toThrow(/note path/i);
    expect(() => notePathFrom('')).toThrow(/note path/i);
    expect(newNoteText('  Eager   loading ', 'Knowledge/x.md')).toBe('# Eager loading\n\n');
    expect(newNoteText('', 'Knowledge/Query Plans.md')).toBe('# Query Plans\n\n');
  });

  it('diffs lines side by side and folds unchanged stretches', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const diff = lineDiff(before, after);
    expect(diff).toMatchObject({ added: 2, removed: 1, approximate: false });
    expect(diff.rows.filter(row => row.kind !== 'same')).toEqual([
      { kind: 'changed', left: { line: 3, text: 'c' }, right: { line: 3, text: 'C' } },
      { kind: 'added', right: { line: 9, text: 'i' } },
    ]);
    expect(foldDiff(diff.rows, 1).map(row => row.kind)).toEqual(['gap', 'same', 'changed', 'same', 'gap', 'same', 'added']);
    expect(lineDiff('x\ny', 'x\ny')).toMatchObject({ added: 0, removed: 0 });
    expect(lineDiff('a\nb', 'c\nd', 1)).toMatchObject({ approximate: true, added: 2, removed: 2 });
    expect(renderToStaticMarkup(createElement(DiffView, { t, before, after }))).toContain(e.diffSummary(2, 1));
    expect(renderToStaticMarkup(createElement(DiffView, { t, before, after: before }))).toContain(e.noDifferences);
  });

  it('maps keys: Ctrl/Cmd+S saves, Esc cancels', () => {
    expect(editorKeyAction({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe('save');
    expect(editorKeyAction({ key: 'S', ctrlKey: false, metaKey: true, altKey: false })).toBe('save');
    expect(editorKeyAction({ key: 's', ctrlKey: true, metaKey: false, altKey: true })).toBeNull();
    expect(editorKeyAction({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false })).toBe('cancel');
    expect(editorKeyAction({ key: 'a', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });
});

describe('Mock note editing', () => {
  it('reads the whole file with its hash and saves with the expected hash', async () => {
    const host = mock();
    const read = (await host.readKnowledgeNote(N1))!;
    expect(read).toMatchObject({ path: N1, managed: false, truncated: false });
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.body).toMatch(/^---\nid: know\.laravel\.n-plus-one\n/);
    const write = vi.spyOn(host, 'writeKnowledgeNote');
    const draft: EditorDraft = { mode: 'edit', path: N1, base: read, initial: read.body, text: `${read.body}\nMore.\n` };
    expect(draftDirty(draft)).toBe(true);
    const status = await host.knowledgeStatus();
    const saved = await saveDraft(host, draft);
    expect(write).toHaveBeenCalledWith({ path: N1, content: draft.text, expectedSha256: read.sha256 });
    expect(saved).toMatchObject({ outcome: 'written', previousSha256: read.sha256 });
    // The daemon re-indexes after a write: a new generation, and the body shows the change.
    expect((await host.knowledgeStatus()).generation).toBe(status.generation + 1);
    expect((await host.knowledgeNode({ path: N1 }))!.body).toContain('More.');
    expect(await saveDraft(host, { ...draft, base: (await host.readKnowledgeNote(N1))! })).toMatchObject({ outcome: 'unchanged' });
    // A stale hash never overwrites: the proposal becomes a conflict copy with a different identity.
    const stale = await saveDraft(host, { ...draft, text: 'mine' });
    expect(stale).toMatchObject({ outcome: 'conflict', conflictReason: 'hash_mismatch' });
    expect(stale.conflictPath).toMatch(/^Knowledge\/N\+1 Query Optimization \(conflict \d{8}T\d{6}Z [0-9a-f]{8}\)\.md$/);
    expect((await host.readKnowledgeNote(N1))!.body).toContain('More.');
    const copy = (await host.readKnowledgeNote(stale.conflictPath!))!;
    expect(copy.body).toContain('conflict_of: "Knowledge/N+1 Query Optimization.md"');
    expect(copy.body).not.toMatch(/^id:/m);
    expect((await host.knowledgeNode({ path: stale.conflictPath! }))!.node.nodeId).toBe(`path:${stale.conflictPath}`);
    // A new note: expected `null`; a second create with `null` conflicts.
    const created = await saveDraft(host, { mode: 'new', path: 'Inbox/Idea.md', base: null, initial: '', text: newNoteText('Idea', 'Inbox/Idea.md') });
    expect(created).toMatchObject({ outcome: 'written', path: 'Inbox/Idea.md' });
    expect(created.previousSha256).toBeUndefined();
    expect((await host.knowledgeNode({ path: 'Inbox/Idea.md' }))!.node.title).toBe('Idea');
    expect(await saveDraft(host, { mode: 'new', path: 'Inbox/Idea.md', base: null, initial: '', text: 'again' })).toMatchObject({ outcome: 'conflict' });
    await expect(host.writeKnowledgeNote({ path: 'Inbox/Idea.md', content: 'x' } as never)).rejects.toThrow(/name the version/);
  });

  it('simulates an outside edit on the next save with ?knowledge=conflict', async () => {
    const host = mock({ conflict: true });
    const read = (await host.readKnowledgeNote(N1))!;
    const first = await host.writeKnowledgeNote({ path: N1, content: 'mine', expectedSha256: read.sha256 });
    expect(first).toMatchObject({ outcome: 'conflict', conflictReason: 'hash_mismatch' });
    expect((await host.readKnowledgeNote(N1))!.body).toContain('Edited in another app');
    const history = await host.knowledgeHistory(N1);
    expect(history.entries.slice(0, 2).map(entry => entry.kind)).toEqual(['conflict', 'external']);
    // Only the next save: after a reload the save goes through.
    const fresh = (await host.readKnowledgeNote(N1))!;
    expect(await host.writeKnowledgeNote({ path: N1, content: 'mine', expectedSha256: fresh.sha256 })).toMatchObject({ outcome: 'written' });
    const options = await import('../src/host/mockHost').then(module => module.mockOptionsFromSearch('?mock=ready&knowledge=conflict'));
    expect(options.knowledge).toBe('conflict');
  });

  it('keeps history and rolls back through compare-and-swap', async () => {
    const host = mock();
    const history = await host.knowledgeHistory(N1);
    expect(history.entries.map(entry => [entry.kind, entry.author])).toEqual([['external', 'external'], ['write', 'user']]);
    const current = (await host.readKnowledgeNote(N1))!;
    expect(history.entries[0]!.sha256).toBe(current.sha256);
    const older = history.entries[1]!;
    const rollback = vi.spyOn(host, 'rollbackKnowledgeNote');
    await expect(rollbackTo(host, N1, older, 'f'.repeat(64))).resolves.toMatchObject({ outcome: 'conflict' });
    const restored = await rollbackTo(host, N1, older, (await host.readKnowledgeNote(N1))!.sha256);
    expect(rollback).toHaveBeenLastCalledWith({ path: N1, toSha256: older.sha256, expectedSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(restored).toMatchObject({ outcome: 'written', sha256: older.sha256 });
    expect((await host.readKnowledgeNote(N1))!.body).not.toContain('## Checklist');
    expect((await host.knowledgeHistory(N1)).entries[0]).toMatchObject({ kind: 'rollback', sha256: older.sha256 });
    await expect(host.rollbackKnowledgeNote({ path: N1, toSha256: 'c'.repeat(64), expectedSha256: older.sha256 })).rejects.toThrow(/unknown_version/);
    expect((await host.knowledgeHistory('Inbox.md')).entries).toEqual([]);
  });

  it('previews a memory import without writing, then imports managed notes once', async () => {
    const host = mock();
    const before = (await host.knowledgeStatus()).counts!.notes;
    const preview = await host.importMemoryNotes({ workspaceId: 'workspace-1', dryRun: true });
    expect(preview.notes.map(note => [note.name, note.outcome, note.masked])).toEqual([
      ['api-integrations', 'created', 2], ['deploy-checklist', 'created', 0], ['team-conventions', 'created', 0], ['Meeting Notes.md', 'skipped', 0],
    ]);
    expect(preview.counts).toMatchObject({ total: 4, created: 3, skipped: 1, masked: 2 });
    expect(importWrites(preview)).toBe(3);
    expect((await host.knowledgeStatus()).counts!.notes).toBe(before);
    expect(await host.readKnowledgeNote('Projects/workspace-1/Memory/deploy-checklist.md')).toBeNull();
    const done = await host.importMemoryNotes({ workspaceId: 'workspace-1', dryRun: false });
    expect(done.counts.created).toBe(3);
    expect((await host.knowledgeStatus()).counts!.notes).toBe(before + 3);
    const note = (await host.readKnowledgeNote('Projects/workspace-1/Memory/api-integrations.md'))!;
    expect(note).toMatchObject({ managed: true });
    expect(note.body).toContain('source: legacy-memory');
    expect(note.body).toContain('[redacted]');
    expect((await host.knowledgeHistory(note.path)).entries[0]).toMatchObject({ kind: 'write', author: 'extalia:memory-import' });
    const again = await host.importMemoryNotes({ workspaceId: 'workspace-1', dryRun: true });
    expect(importOutcomeCounts(again)).toEqual([['unchanged', 3], ['skipped', 1]]);
    expect(importWrites(again)).toBe(0);
  });
});

function editorProps(patch: Partial<NoteEditorProps> = {}): NoteEditorProps {
  const base: KnowledgeNoteFile = { path: 'Experiences/Example.md', sha256: 'a'.repeat(64), managed: true, body: '---\nmanaged_by: extalia\n---\n# Example\n', truncated: false };
  return {
    t, draft: { mode: 'edit', path: base.path, base, initial: base.body, text: `${base.body}More [[Caching]].\n` }, preview: false, onPreview: vi.fn(), onText: vi.fn(),
    saving: false, confirmDiscard: false, onSave: vi.fn(), onCancel: vi.fn(), onDiscard: vi.fn(), onKeepEditing: vi.fn(), onOpenCopy: vi.fn(), onCompare: vi.fn(), onReload: vi.fn(),
    ...patch,
  };
}

describe('Note editor views', () => {
  it('shows the managed chip, the unsaved badge, preview and save/cancel; Ctrl+S saves and Esc asks first', () => {
    const props = editorProps();
    const markup = renderToStaticMarkup(createElement(NoteEditorView, props));
    expect(markup).toContain(e.managed);
    expect(markup).toContain(e.unsaved);
    expect(markup).toContain('<textarea');
    expect(markup).toContain(e.keys);
    const view = NoteEditorView(props);
    click(view, e.save);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    const keyDown = (view.props as { onKeyDown: (event: unknown) => void }).onKeyDown;
    keyDown({ key: 's', ctrlKey: true, metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(props.onSave).toHaveBeenCalledTimes(2);
    keyDown({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    const confirm = editorProps({ confirmDiscard: true });
    const asking = renderToStaticMarkup(createElement(NoteEditorView, confirm));
    expect(asking).toContain(e.discardTitle);
    expect(asking).not.toContain(`>${e.save}<`);
    (NoteEditorView(confirm).props as { onKeyDown: (event: unknown) => void }).onKeyDown({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(confirm.onKeepEditing).toHaveBeenCalled();
    const preview = renderToStaticMarkup(createElement(NoteEditorView, editorProps({ preview: true })));
    expect(preview).not.toContain('<textarea');
    expect(preview).toContain('data-link="preview"');
    expect(preview).toContain(e.frontMatter);
    const plain = renderToStaticMarkup(createElement(NoteEditorView, editorProps({ draft: { mode: 'new', path: 'A.md', base: null, initial: '# A\n', text: '# A\n' } })));
    expect(plain).not.toContain(e.managed);
    expect(plain).not.toContain(e.unsaved);
    expect(plain).toContain(e.newTitle);
  });

  it('explains a conflict and offers the copy, a side-by-side comparison and a reload', () => {
    const result: KnowledgeWriteResult = { outcome: 'conflict', path: 'A.md', sha256: 'b'.repeat(64), conflictPath: 'A (conflict 20261024T101500Z 1234abcd).md', conflictReason: 'hash_mismatch' };
    const conflict: ConflictState = { result, mine: '# A\nmine\n', compare: true, current: { value: { path: 'A.md', sha256: 'b'.repeat(64), managed: false, body: '# A\noutside\n', truncated: false }, loading: false } };
    const props = { t, conflict, onOpenCopy: vi.fn(), onCompare: vi.fn(), onReload: vi.fn() };
    const markup = renderToStaticMarkup(createElement(ConflictPanelView, props));
    expect(markup).toContain(e.conflictTitle);
    expect(markup).toContain(e.conflictReasons.hash_mismatch);
    expect(markup).toContain(result.conflictPath);
    expect(markup).toContain('outside');
    expect(markup).toContain('mine');
    expect(markup).toContain('data-kind="changed"');
    const view = ConflictPanelView(props);
    click(view, e.openCopy); click(view, e.reload); click(view, e.hideCompare);
    expect(props.onOpenCopy).toHaveBeenCalled();
    expect(props.onReload).toHaveBeenCalled();
    expect(props.onCompare).toHaveBeenCalledWith(false);
    for (const reason of ['changed_during_write', 'not_managed'] as const) {
      expect(renderToStaticMarkup(createElement(ConflictPanelView, { ...props, conflict: { ...conflict, compare: false, result: { ...result, conflictReason: reason } } }))).toContain(e.conflictReasons[reason]);
    }
    expect(renderToStaticMarkup(createElement(NoteEditorView, editorProps({ conflict })))).toContain(e.conflictTitle);
  });

  it('creates a new note from a path and title', () => {
    const props = { t, path: 'Knowledge/Topic', title: 'Topic', onPath: vi.fn(), onTitle: vi.fn(), onCreate: vi.fn(), onCancel: vi.fn() };
    const view = NewNoteView(props);
    (view.props as { onSubmit: (event: unknown) => void }).onSubmit({ preventDefault: vi.fn() });
    expect(props.onCreate).toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(NewNoteView, { ...props, error: 'Choose a note path that ends in .md' }))).toContain('role="alert"');
  });
});

describe('History and rollback views', () => {
  const history: KnowledgeHistory = {
    path: 'A.md', entries: [
      { sha256: 'c'.repeat(64), at: '2026-10-24T10:00:00Z', kind: 'conflict', author: 'user', previousSha256: 'b'.repeat(64), conflictPath: 'A (conflict 20261024T100000Z cccccccc).md' },
      { sha256: 'b'.repeat(64), at: '2026-10-23T10:00:00Z', kind: 'external', author: 'external', previousSha256: 'a'.repeat(64) },
      { sha256: 'a'.repeat(64), at: '2026-10-20T10:00:00Z', kind: 'write', author: 'extalia:memory-import' },
    ],
  };
  const props = (patch: Partial<HistoryViewProps> = {}): HistoryViewProps => ({
    t, language: 'en', history: { value: history, loading: false }, currentSha: 'b'.repeat(64), onSelect: vi.fn(), onRollback: vi.fn(), onConfirm: vi.fn(), onCancelConfirm: vi.fn(), busy: false, ...patch,
  });

  it('lists versions with kind, author and the current one', () => {
    const markup = renderToStaticMarkup(createElement(HistoryView, props()));
    expect(markup).toContain(e.kinds.conflict);
    expect(markup).toContain(e.authors.external);
    expect(markup).toContain(e.authors.extalia('memory-import'));
    expect(markup).toContain('aaaaaaaa');
    expect(markup.match(new RegExp(`>${e.currentVersion}<`, 'g'))).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(HistoryView, props({ history: { value: { path: 'A.md', entries: [] }, loading: false } })))).toContain(e.historyEmpty);
  });

  it('asks before rolling back and names both hashes', () => {
    const selected = props({ selected: 'a'.repeat(64) });
    const markup = renderToStaticMarkup(createElement(HistoryView, selected));
    expect(markup).toContain(e.rollback);
    click(HistoryView(selected), e.rollback);
    expect(selected.onRollback).toHaveBeenCalledWith(history.entries[2]);
    const confirming = props({ selected: 'a'.repeat(64), confirming: history.entries[2] });
    const asking = renderToStaticMarkup(createElement(HistoryView, confirming));
    expect(asking).toContain(e.rollbackTitle);
    expect(asking).toContain(`data-hash="from">${'b'.repeat(64)}<`);
    expect(asking).toContain(`data-hash="to">${'a'.repeat(64)}<`);
    click(HistoryView(confirming), e.confirmRollback);
    expect(confirming.onConfirm).toHaveBeenCalled();
    // The current version itself offers no rollback.
    expect(renderToStaticMarkup(createElement(HistoryView, props({ selected: 'b'.repeat(64) })))).not.toContain(`>${e.rollback}<`);
  });
});

describe('Memory import view', () => {
  const preview: KnowledgeMemoryImport = {
    notes: [
      { name: 'api-integrations', vaultPath: 'Projects/w1/Memory/api-integrations.md', outcome: 'created', masked: 2 },
      { name: 'Meeting Notes.md', outcome: 'skipped', masked: 0, reason: 'invalid_name' },
    ],
    counts: { total: 2, created: 1, updated: 0, unchanged: 0, conflict: 0, pendingConflict: 0, missingInVault: 0, skipped: 1, masked: 2 },
  };
  const props = (patch: Partial<Parameters<typeof MemoryImportView>[0]> = {}) => ({
    t, workspaces: { value: [{ id: 'w1', name: 'Shop' }], loading: false }, workspaceId: 'w1', onWorkspace: vi.fn(), preview: null, done: null, busy: null,
    onPreview: vi.fn(), onImport: vi.fn(), onClose: vi.fn(), ...patch,
  });

  it('previews first, then confirms the import', () => {
    const start = props();
    expect(renderToStaticMarkup(createElement(MemoryImportView, start))).not.toContain(e.importConfirm(1));
    click(MemoryImportView(start), e.previewImport);
    expect(start.onPreview).toHaveBeenCalled();
    expect(start.onImport).not.toHaveBeenCalled();
    const previewed = props({ preview });
    const markup = renderToStaticMarkup(createElement(MemoryImportView, previewed));
    expect(markup).toContain(e.outcomes.created);
    expect(markup).toContain(e.outcomes.skipped);
    expect(markup).toContain(e.masked(2));
    expect(markup).toContain('Projects/w1/Memory/api-integrations.md');
    click(MemoryImportView(previewed), e.importConfirm(1));
    expect(previewed.onImport).toHaveBeenCalled();
    const done = renderToStaticMarkup(createElement(MemoryImportView, props({ done: preview })));
    expect(done).toContain(e.importDone);
    expect(done).not.toContain(e.importConfirm(1));
    const nothing = renderToStaticMarkup(createElement(MemoryImportView, props({ preview: { ...preview, notes: [{ name: 'x', vaultPath: 'Projects/w1/Memory/x.md', outcome: 'unchanged', masked: 0 }] } })));
    expect(nothing).toContain(e.importNothing);
    expect(renderToStaticMarkup(createElement(MemoryImportView, props({ workspaces: { value: [], loading: false } })))).toContain(e.noWorkspaces);
    expect(MESSAGES.id.knowledge.edit.importConfirm(2)).toBe('Impor 2 catatan');
  });
});
