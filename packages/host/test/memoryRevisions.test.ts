import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn, validateArguments, type ModelProvider } from '@extalia/runtime';
import { createMemoryTools, MemoryConflictError, MemoryStore } from '../src/memory.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const unknownRevision = '0'.repeat(64);

async function fixture() {
  const root = await temp();
  const directory = path.join(root, 'memory');
  const store = new MemoryStore(directory);
  return { root, directory, store, other: new MemoryStore(path.join(directory, '.')), tools: createMemoryTools(store) };
}

describe('workspace memory revisions', () => {
  it('publishes nullable revision guards as JSON Schema and validates them before tool execution', async () => {
    const { tools } = await fixture();
    const write = tools.find(tool => tool.name === 'memory_write')!;
    const read = tools.find(tool => tool.name === 'memory_read')!;
    expect(JSON.parse(JSON.stringify(write.parameters)).properties.expected_revision).toMatchObject({ type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' });
    for (const expected_revision of [null, unknownRevision]) {
      const input = { name: 'note', content: 'Text', expected_revision };
      expect(validateArguments(write.parameters, input)).toEqual([]);
    }
    expect(validateArguments(write.parameters, { name: 'note', content: 'Text' })).toEqual(['Missing "expected_revision".']);
    for (const expected_revision of [7, {}, '', 'bad', 'a'.repeat(65)]) {
      expect(validateArguments(write.parameters, { name: 'note', content: 'Text', expected_revision })).not.toEqual([]);
    }
    expect(validateArguments(read.parameters, { name: 'note', expected_revision: null })).not.toEqual([]);
    expect(validateArguments(read.parameters, { name: 'note', expected_revision: unknownRevision })).toEqual([]);
  });

  it('rejects an unguarded model write before execution and preserves a human revision', async () => {
    const { store, tools } = await fixture();
    const human = await store.write('decision', 'Human-reviewed decision');
    let calls = 0;
    const provider: ModelProvider = {
      api: 'openai-chat', listModels: async () => [],
      complete: async request => {
        calls++;
        expect(request.tools.find(tool => tool.name === 'memory_write')!.parameters.required).toContain('expected_revision');
        return calls === 1
          ? { text: '', stop: 'tool_use', toolCalls: [{ id: 'unguarded', name: 'memory_write', input: { name: 'decision', content: 'Blind replacement' } }] }
          : { text: 'I need to read the current note before updating it.', stop: 'end', toolCalls: [] };
      },
    };
    const result = await runTurn({ provider, tools, system: 'Memory fixture.', history: [], prompt: 'Update the decision.', permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), emit: () => undefined, requestApproval: async () => 'reject', signal: new AbortController().signal });
    expect(result.outcome).toBe('completed');
    expect(result.history.find(message => message.role === 'tool')).toMatchObject({ results: [{ isError: true, content: expect.stringContaining('Missing "expected_revision"') }] });
    expect(await store.readNote('decision')).toMatchObject({ content: 'Human-reviewed decision', revision: human.revision });
  });

  it('bounds search identity, summary and excerpt together without trimming catalog summaries or leaking secrets', async () => {
    const { directory, store } = await fixture();
    await mkdir(directory);
    const name = 'n'.repeat(64);
    const secret = 'sk-' + 'q'.repeat(30);
    await writeFile(path.join(directory, `${name}.md`), `# ${secret} ${'日'.repeat(180)}\nneedle ${'🪨'.repeat(100)}`);
    const catalog = (await store.catalog()).notes[0]!;
    expect(Array.from(catalog.summary)).toHaveLength(120);
    const hit = (await store.search({ query: 'needle' })).hits[0]!;
    expect(hit.name).toBe(name);
    expect(hit.revision).toBe(catalog.revision);
    expect(Array.from(hit.name + hit.revision + hit.updatedAt + hit.summary + hit.excerpt).length).toBeLessThanOrEqual(240);
    expect(Array.from(hit.excerpt).length).toBeGreaterThanOrEqual(40);
    expect(Array.from(hit.summary).length).toBeLessThan(120);
    expect(hit.excerpt).toContain('needle');
    expect(hit.summary).toContain('[redacted]');
    expect(JSON.stringify([catalog, hit])).not.toContain(secret);
    expect((await store.catalog()).notes[0]!.summary).toBe(catalog.summary);
  });

  it('allows exactly one guarded writer across separate stores, then releases the queue after a conflict', async () => {
    const { store, other } = await fixture();
    const original = await store.write('decision', 'Original');
    const outcomes = await Promise.allSettled([
      store.write('decision', 'First edit', { expectedRevision: original.revision }),
      other.write('decision', 'Second edit', { expectedRevision: original.revision }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected')!;
    expect(rejected.status === 'rejected' && rejected.reason).toBeInstanceOf(MemoryConflictError);
    expect(rejected.status === 'rejected' && rejected.reason).toMatchObject({ code: 'MEMORY_CONFLICT', name: 'MemoryConflictError' });
    const current = (await other.readNote('decision'))!;
    expect(['First edit', 'Second edit']).toContain(current.content);
    expect(current.revision).not.toBe(original.revision);
    const saved = await store.write('decision', 'Final edit', { expectedRevision: current.revision });
    expect(await other.readNote('decision')).toMatchObject({ content: 'Final edit', revision: saved.revision });
  });

  it('serializes create-only saves and competing delete/replace guards', async () => {
    const { store, other } = await fixture();
    const creations = await Promise.allSettled([
      store.write('new-note', 'First', { expectedRevision: null }),
      other.write('new-note', 'Second', { expectedRevision: null }),
    ]);
    expect(creations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await store.readNote('new-note'))!;
    const mutations = await Promise.allSettled([
      store.delete('new-note', { expectedRevision: current.revision }),
      other.write('new-note', 'Replacement', { expectedRevision: current.revision }),
    ]);
    expect(mutations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(mutations.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'MEMORY_CONFLICT' } });
  });

  it('detects same-sized replacements and deletion/recreation even when visible contents match', async () => {
    const { directory, store } = await fixture();
    const credential = 'sk-' + 'q'.repeat(30);
    await mkdir(directory);
    await writeFile(path.join(directory, 'external.md'), `Token ${credential}`);
    const first = (await store.readNote('external'))!;
    expect(first.content).toContain('[redacted]');
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    const changedCredential = 'sk-' + 'r'.repeat(30);
    await writeFile(path.join(directory, 'replacement.md'), `Token ${changedCredential}`);
    await rename(path.join(directory, 'replacement.md'), path.join(directory, 'external.md'));
    const replaced = (await store.readNote('external'))!;
    expect(replaced.content).toBe(first.content);
    expect(replaced.revision).not.toBe(first.revision);
    await expect(store.write('external', 'Must not overwrite', { expectedRevision: first.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    expect(await readFile(path.join(directory, 'external.md'), 'utf8')).toContain(changedCredential);
    await store.delete('external', { expectedRevision: replaced.revision });
    await expect(store.delete('external', { expectedRevision: replaced.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    const recreated = await store.write('external', replaced.content, { expectedRevision: null });
    expect(recreated.revision).not.toBe(replaced.revision);
    await expect(store.delete('external', { expectedRevision: replaced.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    expect((await store.readNote('external'))!.revision).toBe(recreated.revision);
    await store.delete('external', { expectedRevision: recreated.revision });
    const identical = await store.write('external', replaced.content, { expectedRevision: null });
    expect(identical.revision).not.toBe(recreated.revision);
    await expect(store.write('external', 'Stale replacement', { expectedRevision: recreated.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    await store.delete('missing');
  });

  it('binds bounded Unicode pages to revisions after full redaction and rejects stale continuation pages', async () => {
    const { directory, store, tools } = await fixture();
    await mkdir(directory);
    const secret = 'sk-' + 'q'.repeat(30);
    await writeFile(path.join(directory, 'unicode.md'), `日本🪨 ${secret} café`);
    const note = (await store.readNote('unicode'))!;
    const first = (await store.readPage('unicode', { limit: 5 }))!;
    expect(first).toMatchObject({ revision: note.revision, text: '日本🪨 [', offsetUnit: 'unicode-code-points', nextOffset: 5, totalCharacters: Array.from(note.content).length });
    const rest = (await store.readPage('unicode', { offset: first.nextOffset, limit: 8000, expectedRevision: first.revision }))!;
    expect(first.text + rest.text).toBe(note.content);
    expect(JSON.stringify([first, rest])).not.toContain(secret);
    await store.write('unicode', 'New 日本🪨 content', { expectedRevision: first.revision });
    await expect(store.readPage('unicode', { offset: first.nextOffset, expectedRevision: first.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    const stale = await runTool(tools, 'memory_read', { name: 'unicode', offset: first.nextOffset, expected_revision: first.revision });
    expect(stale.ok).toBe(false);
    expect(stale.output).toContain('Read the current note');
    expect(stale.output).not.toContain('New 日本');
    await expect(store.readPage('missing', { expectedRevision: first.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    expect(await store.readPage('missing')).toBeUndefined();
  });

  it('keeps legacy tool text and full reads while guards produce recoverable errors without overwriting', async () => {
    const { root, store, tools } = await fixture();
    const saved = await runTool(tools, 'memory_write', { name: 'workflow', content: 'Original', expected_revision: null });
    expect(saved).toMatchObject({ ok: true, output: 'Saved memory note "workflow".' });
    const pageResult = await runTool(tools, 'memory_read', { name: 'workflow', limit: 100 });
    const page = JSON.parse(pageResult.output) as { revision: string };
    expect(page.revision).toBe((await store.readNote('workflow'))!.revision);
    await store.write('workflow', 'A newer edit');
    for (const revision of [page.revision, null]) {
      const conflict = await runTool(tools, 'memory_write', { name: 'workflow', content: 'Stale edit', expected_revision: revision });
      expect(conflict.ok).toBe(false);
      expect(conflict.output).toContain('no changes were saved');
      expect(conflict.output).not.toContain(root);
    }
    expect((await runTool(tools, 'memory_read', { name: 'workflow' })).output).toBe('A newer edit');
    const current = (await store.readNote('workflow'))!;
    expect((await runTool(tools, 'memory_write', { name: 'workflow', content: 'Guarded save', expected_revision: current.revision })).ok).toBe(true);
    expect(await store.read('workflow')).toBe('Guarded save');
    expect((await runTool(tools, 'memory_write', { name: 'workflow', content: 'Legacy save' })).ok).toBe(true);
    expect(await store.read('workflow')).toBe('Legacy save');
  });

  it('validates revision guards and pagination without altering notes or crossing workspaces', async () => {
    const { root, store, tools } = await fixture();
    const saved = await store.write('note', 'Workspace A');
    const foreign = new MemoryStore(path.join(root, 'other'));
    const other = await foreign.write('note', 'Workspace B');
    await expect(store.write('note', 'Cross workspace edit', { expectedRevision: other.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    await expect(store.delete('note', { expectedRevision: other.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    for (const expected_revision of ['', 'invalid', '../escape', 7, false, {}, 'a'.repeat(65)]) {
      expect((await runTool(tools, 'memory_write', { name: 'note', content: 'Invalid', expected_revision })).ok).toBe(false);
      expect((await runTool(tools, 'memory_read', { name: 'note', limit: 3, expected_revision })).ok).toBe(false);
    }
    expect((await runTool(tools, 'memory_read', { name: 'note', limit: 3, expected_revision: null })).ok).toBe(false);
    await expect(store.readPage('note', { offset: -1, expectedRevision: saved.revision })).rejects.toThrow(/pagination/);
    await expect(store.write('missing', 'Missing edit', { expectedRevision: unknownRevision })).rejects.toBeInstanceOf(MemoryConflictError);
    expect(await store.read('missing')).toBeUndefined();
    expect(await store.read('note')).toBe('Workspace A');
    expect(await foreign.read('note')).toBe('Workspace B');
    expect((await store.catalog()).notes[0]!.revision).toBe(saved.revision);
    expect((await store.search({ query: 'workspace' })).hits[0]!.revision).toBe(saved.revision);
  });
});
