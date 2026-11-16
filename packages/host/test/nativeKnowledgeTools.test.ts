import { describe, expect, it, vi } from 'vitest';
import { createNativeKnowledgeTools, type NativeKnowledgePort } from '../src/nativeKnowledgeTools.js';

const binding = { profileId: 'profile-one', root: '/tmp/example-vault', revision: 'one' };
const context = () => ({ signal: new AbortController().signal, toolCallId: 'read-one', emit: () => undefined });
function port(): NativeKnowledgePort {
  return { workspaceId: 'workspace-one', resolve: async () => ({ ...binding }),
    search: vi.fn(async () => ({ generation: 1, hits: [{ nodeId: 'n', path: 'Note.md', title: 'Note' }] })),
    read: vi.fn(async () => ({ generation: 1, node: { nodeId: 'note', path: 'Note.md', title: 'Note', kind: 'note', aliases: [], tags: [],
      idFromFrontMatter: false, origin: 'vault' as const, trustStatus: 'untrusted' as const, sourceSha256: 'a'.repeat(64), observedAt: '2026-01-01T00:00:00.000Z', declaredSourceTaskIds: [] },
    body: 'A'.repeat(16000), bodyTruncated: false, bodyStatus: 'current' as const })),
  };
}
describe('run-bound Native Knowledge reads', () => {
  it('reports a validated vault-relative read target without leaking vault roots or search queries', async () => {
    const tools = await createNativeKnowledgeTools(port());
    expect(tools[1]!.describe?.({ path: 'Notes/Review.md' })).toEqual({ label: 'Reading workspace knowledge', target: 'Notes/Review.md' });
    expect(tools[0]!.describe?.({ query: 'Private query' })).not.toHaveProperty('target');
    for (const path of ['../Note.md', '/private/Note.md', '.obsidian/Config.md']) expect(() => tools[1]!.describe?.({ path })).toThrow();
  });
  it('pages notes with source receipts and passes only the pinned destination to the host', async () => {
    const p = port(), tools = await createNativeKnowledgeTools(p);
    expect(tools.map(tool => tool.access)).toEqual(['read', 'read']);
    await tools[0]!.run({ query: ' Note ' }, context());
    expect(p.search).toHaveBeenCalledWith('Note', { profileId: binding.profileId, root: binding.root });
    const first = JSON.parse((await tools[1]!.run({ path: 'Note.md', limit: 8000 }, context())).output);
    expect(first).toMatchObject({ workspaceId: 'workspace-one', profileId: 'profile-one', nextOffset: 8000, nativeTruncated: false });
    expect(first).not.toHaveProperty('vaultRoot');
    expect(first.body).toHaveLength(8000); expect(first.sourceTrust).toContain('untrusted');
    const second = JSON.parse((await tools[1]!.run({ path: 'Note.md', offset: first.nextOffset }, context())).output);
    expect(second.body).toHaveLength(8000); expect(second.truncated).toBe(false);
    await expect(tools[1]!.run({ path: '../Note.md' }, context())).rejects.toThrow();
    await expect(tools[1]!.run({ path: 'Note.md', limit: 20000 }, context())).rejects.toThrow('valid Knowledge');
  });
  it('refuses a changed binding before dispatch and suppresses a reply changed during dispatch', async () => {
    const p = port(); let current = { ...binding }; p.resolve = async () => ({ ...current });
    const tools = await createNativeKnowledgeTools(p);
    current = { ...binding, root: '/tmp/example-other-vault' };
    await expect(tools[0]!.run({ query: 'note' }, context())).rejects.toThrow('vault changed');
    expect(p.search).not.toHaveBeenCalled();
    current = { ...binding };
    p.read = async () => { current = { ...binding, revision: 'two' }; return null; };
    await expect(tools[1]!.run({ path: 'Note.md' }, context())).rejects.toThrow('vault changed');
  });
  it('never falls back or acquires a later binding when the run starts without a usable vault', async () => {
    const p = port(); p.resolve = async () => { throw new Error('Selected vault unavailable'); };
    const tools = await createNativeKnowledgeTools(p);
    p.resolve = async () => ({ ...binding });
    await expect(tools[0]!.run({ query: 'note' }, context())).rejects.toThrow('Selected vault unavailable');
    expect(p.search).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(tools[1]!.run({ path: 'Note.md' }, { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(p.read).not.toHaveBeenCalled();
  });
  it('never exposes hidden paths or stale-index bodies and paginates complete Unicode characters', async () => {
    const p = port(), original = await p.read('Note.md', binding);
    p.read = vi.fn(async () => ({ ...original!, body: 'a😀b', bodyStatus: 'current' as const }));
    const tools = await createNativeKnowledgeTools(p), read = tools[1]!;
    for (const path of ['.obsidian/Config.md', 'Folder/.private.md', '/Note.md', '../Note.md'])
      await expect(read.run({ path }, context())).rejects.toThrow();
    expect(p.read).not.toHaveBeenCalled();
    const first = JSON.parse((await read.run({ path: 'Note.md', limit: 2 }, context())).output);
    expect(first).toMatchObject({ body: 'a😀', nextOffset: 2, units: 'unicode-code-points' });
    expect(JSON.parse((await read.run({ path: 'Note.md', offset: 2 }, context())).output).body).toBe('b');
    p.read = async () => ({ ...original!, body: 'NEW PRIVATE CONTENT', bodyStatus: 'changed' });
    const changed = await read.run({ path: 'Note.md' }, context());
    expect(changed.ok).toBe(false); expect(changed.output).not.toContain('NEW PRIVATE CONTENT');
    p.read = async () => null;
    expect(JSON.parse((await read.run({ path: 'OtherProfile.md' }, context())).output).status).toBe('missing');
  });
});

describe('Native Knowledge correction-aware recall', () => {
  it('keeps the original body and revision while returning separately attributed update claims', async () => {
    const p = port(), original = await p.read('Note.md', binding);
    p.read = vi.fn(async () => ({ ...original!, body: 'The earlier observation.', relatedUpdates: [{
      nodeId: 'path:Amendment.md', path: 'Amendment.md', title: 'Later observation', relation: 'contradicts' as const,
      line: 4, sourceSha256: 'b'.repeat(64), excerpt: 'Contradicts: [[Note]] — pending evidence', trustStatus: 'untrusted' as const,
    }], relatedUpdatesTruncated: true }));
    const read = (await createNativeKnowledgeTools(p))[1]!;
    const result = JSON.parse((await read.run({ path: 'Note.md' }, context())).output);
    expect(result).toMatchObject({ body: 'The earlier observation.', sha256: 'a'.repeat(64), relatedUpdatesTruncated: true,
      relatedUpdates: [{ path: 'Amendment.md', relation: 'contradicts', sourceSha256: 'b'.repeat(64), trustStatus: 'untrusted' }] });
    expect(result.relatedUpdatesGuidance).toContain('do not establish truth');
    expect(result.body).not.toContain('pending evidence');
    p.read = async () => ({ ...original!, bodyStatus: 'changed', relatedUpdates: [{ nodeId: 'path:Private.md', path: 'Private.md', title: 'Stale',
      relation: 'updates', line: 1, sourceSha256: 'c'.repeat(64), excerpt: 'stale detail', trustStatus: 'untrusted' }] });
    const stale = await read.run({ path: 'Note.md' }, context());
    expect(stale.ok).toBe(false);
    expect(stale.output).not.toContain('stale detail');
  });
});
