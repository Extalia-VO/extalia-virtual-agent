import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTurn, type ModelMessage, type ModelProvider } from '@extalia/runtime';
import { NativeContextArchive, NATIVE_CONTEXT_ARCHIVE_SUPPORTED, type NativeContextArchiveOptions } from '../src/nativeContextArchive.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const scope = { profileId: 'profile-fixture', workspaceId: 'workspace-fixture', sessionId: 'session-fixture', boundary: 'original-boundary' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const messages: ModelMessage[] = [
  { role: 'user', text: 'Keep duplicate order unchanged.' },
  { role: 'assistant', text: 'Inspect the existing behavior.', toolCalls: [{ id: 'source', name: 'read_file', input: { path: 'parser.log' } }] },
  { role: 'tool', results: [{ toolCallId: 'source', name: 'read_file', isError: false,
    content: `Parser start.\n${'padding '.repeat(3000)}\nDecision: retain first duplicate; batch limit 73.\n${'padding '.repeat(3000)}\nPending: test empty input.` }] },
];
async function fixture(extra: Partial<NativeContextArchiveOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-context-archive-')); directories.push(root);
  const options: NativeContextArchiveOptions = { directory: path.join(root, 'archives'), scope, assertCurrent: () => undefined, ...extra };
  return { root, options, archive: new NativeContextArchive(options), signal: new AbortController().signal };
}
async function files(directory: string) {
  const scopes = await readdir(directory);
  return (await Promise.all(scopes.map(async scope => (await readdir(path.join(directory, scope))).map(file => path.join(directory, scope, file))))).flat();
}

it.skipIf(NATIVE_CONTEXT_ARCHIVE_SUPPORTED)('refuses unsupported durable publication before creating an archive', async () => {
  const f = await fixture();
  await expect(f.archive.archive({ messages, signal: f.signal })).rejects.toThrow('Durable context archives are unavailable');
  expect(await readdir(f.root)).toEqual([]);
});

describe.skipIf(!NATIVE_CONTEXT_ARCHIVE_SUPPORTED)('durable Native context archive', () => {
  it('withholds acknowledgement if directory durability fails, including on a deduplicated retry', async () => {
    const f = await fixture();
    const first = await f.archive.archive({ messages, signal: f.signal });
    const originalFiles = await files(f.options.directory);
    const handle = await open(f.options.directory, 'r');
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> };
    const barrier = vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error('Directory durability unavailable'));
    try {
      await expect(f.archive.archive({ messages, signal: f.signal })).rejects.toThrow('Directory durability unavailable');
    } finally { barrier.mockRestore(); await handle.close(); }
    expect(await files(f.options.directory)).toEqual(originalFiles);
    expect(await f.archive.archive({ messages, signal: f.signal })).toEqual(first);
    expect(await f.archive.read({ reference: first.reference, messageIndex: 2, resultIndex: 0, limit: 12 }, f.signal)).toMatchObject({ text: 'Parser start' });
  });

  it('deduplicates immutable chunks and snapshots, and reads the original middle evidence after restart', async () => {
    let persisted = 0;
    const f = await fixture({ persist: async work => { persisted++; return work(); } });
    const first = await f.archive.archive({ messages, signal: f.signal });
    const initial = await files(f.options.directory);
    expect(initial).toHaveLength(2);
    expect(await f.archive.archive({ messages, signal: f.signal })).toEqual(first);
    expect(await files(f.options.directory)).toEqual(initial);
    const extended = [...messages, { role: 'assistant' as const, text: 'Pending test remains unresolved.', toolCalls: [] }];
    await f.archive.archive({ messages: extended, signal: f.signal });
    expect(await files(f.options.directory)).toHaveLength(3);
    expect(persisted).toBe(3);
    const restart = new NativeContextArchive(f.options);
    const result = messages[2]!;
    if (result.role !== 'tool') throw new Error('fixture');
    const offset = result.results[0]!.content.indexOf('Decision:');
    expect(await restart.read({ reference: first.reference, messageIndex: 2, resultIndex: 0, offset, limit: 80 }, f.signal))
      .toMatchObject({ text: expect.stringContaining('batch limit 73'), offset, nextOffset: offset + 80, isError: false });
  });

  it('keeps the archive scoped to profile, workspace, session and access boundary', async () => {
    const f = await fixture();
    const receipt = await f.archive.archive({ messages, signal: f.signal });
    for (const key of Object.keys(scope) as (keyof typeof scope)[]) {
      const other = new NativeContextArchive({ ...f.options, scope: { ...scope, [key]: `different-${key}` } });
      await expect(other.read({ reference: receipt.reference, messageIndex: 2, resultIndex: 0 }, f.signal)).rejects.toThrow();
    }
    await expect(f.archive.read({ reference: '../outside', messageIndex: 2, resultIndex: 0 }, f.signal)).rejects.toThrow();
  });

  it('revalidates consent and cancellation around persistence, and refuses revoked reads', async () => {
    let allowed = true, writes = 0;
    const controller = new AbortController();
    const f = await fixture({ assertCurrent: () => { if (!allowed) throw new Error('Revoked'); }, persist: async work => { writes++; return work(); } });
    const receipt = await f.archive.archive({ messages, signal: f.signal });
    allowed = false;
    await expect(f.archive.read({ reference: receipt.reference, messageIndex: 2, resultIndex: 0 }, f.signal)).rejects.toThrow('Revoked');
    await expect(f.archive.archive({ messages, signal: f.signal })).rejects.toThrow('Revoked');
    expect(writes).toBe(1);
    allowed = true; controller.abort();
    await expect(f.archive.archive({ messages, signal: controller.signal })).rejects.toThrow();
    expect(writes).toBe(1);
  });

  it('refuses tampered chunks and manifests without replacing them', async () => {
    const f = await fixture();
    const receipt = await f.archive.archive({ messages, signal: f.signal });
    const all = await files(f.options.directory);
    const chunk = all.find(file => path.basename(file).startsWith('message-'))!;
    await writeFile(chunk, JSON.stringify({ role: 'tool', results: [{ content: 'forged' }] }));
    await expect(f.archive.read({ reference: receipt.reference, messageIndex: 2, resultIndex: 0 }, f.signal)).rejects.toThrow();
    await expect(f.archive.archive({ messages, signal: f.signal })).rejects.toThrow();
    expect(await readFile(chunk, 'utf8')).toContain('forged');
  });

  it.skipIf(process.platform === 'win32')('refuses symlink roots without reading outside the archive', async () => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await writeFile(outside, 'outside evidence');
    await symlink(outside, f.options.directory);
    await expect(f.archive.archive({ messages, signal: f.signal })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('outside evidence');
  });

  it('masks credentials before storage and paging, and omits all non-tool history', async () => {
    const f = await fixture();
    const secret = `sk-${'a'.repeat(40)}`;
    const source: ModelMessage[] = [{ role: 'user', text: 'PRIVATE_USER_INSTRUCTIONS', images: [{ mimeType: 'image/png', data: 'PRIVATE_ATTACHMENT_BYTES' }] },
      { role: 'tool', results: [{ toolCallId: 'result', name: 'read_file', content: `prefix ${secret} suffix`, isError: true }] },
      { role: 'assistant', text: 'PRIVATE_ASSISTANT_TEXT', toolCalls: [{ id: 'next', name: 'tool', input: { value: 'PRIVATE_TOOL_ARGUMENT' } }],
        native: { api: 'anthropic-messages', content: [{ type: 'thinking', thinking: 'PRIVATE_NATIVE_BLOCK', signature: 'PRIVATE_NATIVE_SIGNATURE' }] } }];
    const receipt = await f.archive.archive({ messages: source, signal: f.signal });
    const page = await f.archive.read({ reference: receipt.reference, messageIndex: 1, resultIndex: 0 }, f.signal);
    expect(page.redacted).toBe(true); expect(page.text).not.toContain(secret);
    expect(page.isError).toBe(true);
    expect(page).toMatchObject({ storageVersion: 2, evidence: 'sanitized-tool-report', trust: 'tool-report-not-verified-fact', sourceCharacters: `prefix ${secret} suffix`.length });
    expect(await f.archive.read({ reference: receipt.reference, messageIndex: 1, resultIndex: 0, offset: 8, limit: 4 }, f.signal)).toMatchObject({ text: 'reda' });
    for (const file of await files(f.options.directory)) {
      const stored = await readFile(file, 'utf8');
      expect(stored).not.toContain(secret);
      expect(stored).not.toMatch(/PRIVATE_(?:USER|ASSISTANT|TOOL|NATIVE|ATTACHMENT)/u);
    }
  });

  it('stores only selected result slots while retaining immutable message and result coordinates', async () => {
    const f = await fixture();
    const source: ModelMessage[] = [...messages, { role: 'tool', results: [
      { toolCallId: 'unselected', name: 'skill_read', content: 'EXACT_SKILL_NOT_ARCHIVED', isError: false },
      { toolCallId: 'selected', name: 'logs', content: 'Selected evidence.', isError: false },
    ] }];
    const receipt = await f.archive.archive({ messages: source, selections: [{ messageIndex: 3, resultIndex: 1 }], signal: f.signal });
    expect(await f.archive.read({ reference: receipt.reference, messageIndex: 3, resultIndex: 1 }, f.signal)).toMatchObject({ text: 'Selected evidence.' });
    await expect(f.archive.read({ reference: receipt.reference, messageIndex: 3, resultIndex: 0 }, f.signal)).rejects.toThrow();
    await expect(f.archive.read({ reference: receipt.reference, messageIndex: 2, resultIndex: 0 }, f.signal)).rejects.toThrow();
    for (const file of await files(f.options.directory)) expect(await readFile(file, 'utf8')).not.toMatch(/EXACT_SKILL_NOT_ARCHIVED|Parser start/u);
    await expect(f.archive.archive({ messages: source, selections: [{ messageIndex: 0, resultIndex: 0 }], signal: f.signal })).rejects.toThrow();
  });

  it('reads legacy v1 archives with truthful source labeling and read-time masking', async () => {
    const f = await fixture();
    const scopeId = digest(JSON.stringify([scope.profileId, scope.workspaceId, scope.sessionId, scope.boundary]));
    const directory = path.join(f.options.directory, scopeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const secret = `sk-${'b'.repeat(40)}`;
    const oldChunk = JSON.stringify({ role: 'tool', results: [{ toolCallId: 'legacy', name: 'logs', content: `Legacy ${secret} evidence.`, isError: false }] });
    const chunk = digest(oldChunk);
    const manifest = JSON.stringify({ version: 1, scope: scopeId, messages: [chunk] });
    const reference = digest(manifest);
    await writeFile(path.join(directory, `message-${chunk}.json`), oldChunk, { mode: 0o600 });
    await writeFile(path.join(directory, `archive-${reference}.json`), manifest, { mode: 0o600 });
    expect(await f.archive.read({ reference, messageIndex: 0, resultIndex: 0 }, f.signal)).toMatchObject({
      text: 'Legacy [redacted] evidence.', redacted: true, storageVersion: 1, evidence: 'legacy-original-tool-report',
    });
    // Migration must not silently rewrite or invalidate immutable old references.
    expect(await readFile(path.join(directory, `message-${chunk}.json`), 'utf8')).toBe(oldChunk);
  });

  it('fails explicitly at unsafe capacity without deleting earlier evidence', async () => {
    const f = await fixture();
    const receipt = await f.archive.archive({ messages, signal: f.signal });
    const [scopeFolder] = await readdir(f.options.directory);
    const excess = path.join(f.options.directory, scopeFolder!, 'oversized-fixture.json');
    const handle = await open(excess, 'wx');
    try { await handle.truncate(257 * 1024 * 1024); } finally { await handle.close(); }
    await expect(f.archive.archive({ messages: [...messages, { role: 'user', text: 'new work' }], signal: f.signal })).rejects.toThrow();
    expect(await f.archive.read({ reference: receipt.reference, messageIndex: 2, resultIndex: 0, limit: 12 }, f.signal)).toMatchObject({ text: 'Parser start' });
  });

  it('runs a bounded Native request, then retrieves omitted original evidence through the real archive tool', async () => {
    const f = await fixture();
    const readTool = f.archive.readTool();
    let requests = 0, seen: readonly ModelMessage[] = [];
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
      requests++; seen = request.messages;
      if (requests === 1) {
        const archived = request.messages.find(message => message.role === 'tool');
        if (archived?.role !== 'tool') throw new Error('Missing source');
        const marker = archived.results[0]!.content.match(/context_archive_read\((\{[^\n]+\})\)/);
        if (!marker) throw new Error('Missing retrieval reference');
        const input = JSON.parse(marker[1]!);
        const original = messages[2]!;
        if (original.role !== 'tool') throw new Error('fixture');
        return { text: 'Read the original decision before proceeding.', toolCalls: [{ id: 'recover', name: readTool.name,
          input: { ...input, offset: original.results[0]!.content.indexOf('Decision:'), limit: 90 } }], stop: 'tool_use' };
      }
      const last = request.messages.at(-1);
      expect(last).toMatchObject({ role: 'tool', results: [{ toolCallId: 'recover', isError: false }] });
      if (last?.role === 'tool') expect(last.results[0]!.content).toContain('batch limit 73');
      return { text: 'Retain first duplicate and batch limit 73. Empty input remains pending.', toolCalls: [], stop: 'end' };
    } };
    const result = await runTurn({ provider, system: 'Preserve the API.', history: messages, prompt: 'Continue with the recorded parser constraints.',
      tools: [readTool], compaction: f.archive.compactionOptions(), maxInputTokens: 4000, permissions: { fileWrite: 'ask', commands: 'ask' },
      sessionGrants: new Set(), emit: () => undefined, requestApproval: async () => 'reject', signal: f.signal });
    expect(result.outcome).toBe('completed'); expect(requests).toBe(2);
    expect(result.history.slice(0, messages.length)).toEqual(messages);
    expect(JSON.stringify(seen)).not.toContain('padding '.repeat(3000));
    expect(result.compaction?.count).toBe(1);
  });
});
