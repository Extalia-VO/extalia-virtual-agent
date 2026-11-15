import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContinuityEntry, ContinuityReadPage, ContinuitySnapshotSummary } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { useTempDirs } from './helpers.js';

// Real host, parsers, bounded observation, disk ledger and scoped MCP reads.
// Native transcripts and compaction records are synthetic; this does not certify
// provider retention, actual CLI compression or a live four-agent acceptance run.
const temp = useTempDirs(), active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
const CODEX = '11111111-1111-4111-8111-111111111111';
const GEMINI = '22222222-2222-4222-8222-222222222222';
const CLAUDE = '33333333-3333-4333-8333-333333333333';
const DECISION = 'MIDDLE-DECISION: retain the first valid normalized row; limit is 73.';
const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const codexMessage = (role: 'user' | 'assistant', text: string, index: number) => ({ type: 'response_item', timestamp: at(index),
  payload: { type: 'message', role, ...(role === 'assistant' ? { channel: 'final' } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const codeFrom = (packet: string) => {
  const code = packet.match(/\bsk-extalia-context-[a-f0-9]{64}\b/)?.[0];
  expect(code).toBeTruthy(); return code!;
};
interface McpResult { isError?: boolean; content: { text: string }[] }
const unpack = <T>(reply: McpResult): T => { expect(reply.isError).not.toBe(true); return JSON.parse(reply.content[0]!.text) as T; };

it('recovers a captured middle decision after window loss and synthetic compaction through Codex → Gemini → Claude → Codex', async () => {
  const root = await temp('extalia-continuity-long-session-');
  const home = path.join(root, 'home'), project = path.join(root, 'project'), data = path.join(root, 'data');
  const files = {
    codex: path.join(home, '.codex', 'sessions', 'rollout.jsonl'),
    gemini: path.join(home, '.gemini', 'tmp', 'fixture-project', 'chats', 'session-fixture.json'),
    claude: path.join(home, '.claude', 'projects', 'fixture-project', `${CLAUDE}.jsonl`),
  };
  await Promise.all([mkdir(project), ...Object.values(files).map(file => mkdir(path.dirname(file), { recursive: true }))]);
  await writeFile(path.join(files.gemini, '..', '..', '.project_root'), project + '\n');
  const codexMeta = { type: 'session_meta', payload: { id: CODEX, cwd: project, timestamp: at(0) } };
  const claudeMessage = (role: 'user' | 'assistant', text: string, index: number) => ({ type: role, sessionId: CLAUDE,
    uuid: `claude-${index}`, parentUuid: index ? `claude-${index - 1}` : null, cwd: project, timestamp: at(index),
    message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { model: 'claude-fixture', stop_reason: 'end_turn', usage: { input_tokens: 500 } } : {}) } });
  const geminiMessage = (type: 'user' | 'gemini', content: string, index: number) => ({ id: `gemini-${index}`, type, content, timestamp: at(index) });
  const geminiRecord = (messages: unknown[]) => JSON.stringify({ sessionId: GEMINI, projectHash: 'fixture-project', startTime: at(0), messages });
  await Promise.all([
    writeFile(files.codex, lines([codexMeta, codexMessage('user', 'ORIGINAL-OBJECTIVE: complete the inventory normalizer', 1), codexMessage('assistant', 'Original source inspection completed.', 2)])),
    writeFile(files.gemini, geminiRecord([geminiMessage('user', 'Existing Gemini conversation', 1), geminiMessage('gemini', 'Ready for reviewed work.', 2)])),
    writeFile(files.claude, lines([claudeMessage('user', 'Existing Claude conversation', 0), claudeMessage('assistant', 'Ready for reviewed work.', 1)])),
  ]);
  const provider = vi.fn(async () => { throw new Error('Synthetic host regression must never call a provider.'); });
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, fetch: provider };
  let runtime = await createAgentHost(options); active.add(runtime);
  const connection = (await runtime.host.saveConnection({ name: 'Continuity fixture', preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://fixture.example/v1', model: 'fixture-model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Long-session fixture', projectLocation: project, mode: 'observe',
    connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.projectLocation === project)!;
  const scan = await runtime.host.scanImports(['codex', 'gemini-cli', 'claude-code']);
  const state = await runtime.host.observeImports(scan.scanId, scan.sessions.map(item => item.id));
  const observed = (id: string) => state.sessions.find(item => item.observation?.nativeSessionId === id)!;
  const codex = observed(CODEX), gemini = observed(GEMINI), claude = observed(CLAUDE);
  expect([codex, gemini, claude].map(item => item.workspaceId)).toEqual([workspace.id, workspace.id, workspace.id]);
  const restart = async () => {
    await runtime.close(); active.delete(runtime);
    runtime = await createAgentHost(options); active.add(runtime); await runtime.hooks!.listen(0);
  };
  const refresh = async (sessionId: string) => { await runtime.host.setObservation(sessionId, true); };
  const mcp = async (app: 'codex' | 'gemini' | 'claude', nativeId: string, code: string, operation: 'status' | 'read', args: Record<string, unknown> = {}) => {
    const result = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `extalia_continuity_${operation}`,
      arguments: { access_code: code, ...args } } }, { extaliaHome: data, app, sessionId: nativeId, continuityOnly: true });
    return result!.result as McpResult;
  };
  const archived = async (sessionId: string, snapshotId: string) => {
    const entries: ContinuityEntry[] = []; let offset = 0;
    for (;;) {
      const page = await runtime.host.readContinuity!(sessionId, { snapshotId, offset, limit: 50 });
      entries.push(...page.entries); if (page.nextOffset === undefined) return entries; offset = page.nextOffset;
    }
  };
  await runtime.hooks!.listen(0);
  const original = await runtime.host.sessionContinuity!(codex.id);
  const canonicalId = original.canonicalId;
  await appendFile(files.codex, lines([
    { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', call_id: 'archive-only', name: 'mcp__extalia__extalia_continuity_read', arguments: '{}' } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'function_call_output', call_id: 'archive-only', output: 'RECURSIVE-ARCHIVE-BODY: already retained source material.' } },
  ]));
  await refresh(codex.id);
  expect((await runtime.host.sessionContinuity!(codex.id)).snapshots).toEqual(original.snapshots);
  await appendFile(files.codex, lines([
    ...Array.from({ length: 35 }, (_, index) => codexMessage('assistant', `Earlier detail ${index}: ${'a'.repeat(20_000)}`, index + 5)),
    codexMessage('user', DECISION, 40), codexMessage('assistant', 'Recorded the middle decision in its original source.', 41),
  ]));
  expect((await stat(files.codex)).size).toBeGreaterThan(512 * 1024);
  await refresh(codex.id);
  const checkpoint = (await runtime.host.sessionContinuity!(codex.id)).snapshots.at(-1)!;
  const checkpointEntries = await archived(codex.id, checkpoint.id);
  const decisionIndex = checkpointEntries.findIndex(entry => entry.text === DECISION);
  expect(decisionIndex).toBeGreaterThanOrEqual(0);
  await appendFile(files.codex, lines(Array.from({ length: 140 }, (_, index) => codexMessage('assistant', `Later detail ${index}: ${'b'.repeat(32_000)}`, index + 42))));
  expect((await stat(files.codex)).size).toBeGreaterThan(4 * 1024 * 1024);
  await refresh(codex.id);
  expect(JSON.stringify((await runtime.host.observationSession(codex.id)).messages)).not.toContain(DECISION);
  const latest = (await runtime.host.sessionContinuity!(codex.id)).snapshots.at(-1)!;
  expect((await archived(codex.id, latest.id)).some(entry => entry.text === DECISION)).toBe(false);

  const first = await runtime.host.previewHandover!(codex.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Gemini fixture', sessionId: gemini.id } });
  expect(first.canonicalId).toBe(canonicalId); expect(first.packet).not.toContain(DECISION);
  const firstReceipt = await runtime.host.applyHandover!(codex.id, { reviewId: first.reviewId, operationId: 'long-codex-gemini' });
  expect(firstReceipt).toMatchObject({ state: 'manual-ready', canonicalId, targetSessionId: gemini.id });
  const firstCode = codeFrom(first.packet);
  await writeFile(files.gemini, geminiRecord([
    geminiMessage('user', first.packet, 3), geminiMessage('gemini', 'GEMINI-PRE-COMPACTION: checked invalid rows.', 4),
  ]));
  await refresh(gemini.id);
  const geminiBefore = (await runtime.host.sessionContinuity!(gemini.id)).snapshots.at(-1)!;
  // Gemini has no verified native compaction decoder. A replaced recording tests
  // archive independence, and deliberately makes no compression-success claim.
  await writeFile(files.gemini, geminiRecord([
    geminiMessage('user', 'Continue after the synthetic recording replacement.', 5),
    geminiMessage('gemini', 'GEMINI-AFTER-REPLACEMENT: checked duplicate handling.', 6),
  ]));
  await refresh(gemini.id);
  const second = await runtime.host.previewHandover!(gemini.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Claude fixture', sessionId: claude.id } });
  const secondReceipt = await runtime.host.applyHandover!(gemini.id, { reviewId: second.reviewId, operationId: 'long-gemini-claude' });
  expect(secondReceipt).toMatchObject({ state: 'manual-ready', canonicalId, targetSessionId: claude.id });
  await restart();
  expect((await runtime.host.sessionContinuity!(gemini.id)).handovers).toEqual([firstReceipt, secondReceipt]);
  expect((await mcp('gemini', GEMINI, firstCode, 'read', { snapshot_id: checkpoint.id, offset: decisionIndex, limit: 1 })).isError).not.toBe(true);
  expect((await mcp('gemini', GEMINI, firstCode, 'read', { snapshot_id: geminiBefore.id })).isError).toBe(true);

  await appendFile(files.claude, lines([claudeMessage('user', second.packet, 2), claudeMessage('assistant', 'CLAUDE-PRE-COMPACTION: checked output ordering.', 3)]));
  await refresh(claude.id);
  const claudeBefore = (await runtime.host.sessionContinuity!(claude.id)).snapshots.at(-1)!;
  await writeFile(files.claude, lines([
    { type: 'system', subtype: 'compact_boundary', sessionId: CLAUDE, timestamp: at(4), compactMetadata: { trigger: 'manual' } },
    claudeMessage('user', 'Continue after the synthetic compact boundary.', 5),
    claudeMessage('assistant', 'CLAUDE-POST-COMPACTION: checked the command interface.', 6),
  ]));
  await refresh(claude.id);
  expect((await runtime.host.getState()).sessions.find(item => item.id === claude.id)?.context?.compactions).toBe(1);
  const third = await runtime.host.previewHandover!(claude.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Original Codex fixture', sessionId: codex.id } });
  expect(third.packet).not.toContain(DECISION);
  for (const packet of [first.packet, second.packet, third.packet]) expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(14 * 1024);
  const thirdReceipt = await runtime.host.applyHandover!(claude.id, { reviewId: third.reviewId, operationId: 'long-claude-codex' });
  expect(thirdReceipt).toMatchObject({ state: 'manual-ready', canonicalId, targetSessionId: codex.id });
  const finalCode = codeFrom(third.packet);
  await writeFile(files.codex, lines([codexMeta,
    { type: 'compacted', timestamp: at(200), payload: { message: 'Synthetic compacted summary without the middle decision.' } },
    { type: 'event_msg', timestamp: at(201), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500 }, model_context_window: 100_000 } } },
    codexMessage('user', third.packet, 202), codexMessage('assistant', 'CODEX-RETURN: inspect the retained original archive.', 203),
  ]));
  await refresh(codex.id);
  expect((await runtime.host.getState()).sessions.find(item => item.id === codex.id)?.context?.compactions).toBe(1);
  await restart();

  const final = await runtime.host.sessionContinuity!(codex.id);
  expect(final.canonicalId).toBe(canonicalId); expect(final.workspaceId).toBe(workspace.id);
  expect(final.handovers).toEqual([firstReceipt, secondReceipt, thirdReceipt]);
  expect((await runtime.host.getState()).sessions.filter(item => item.control === 'managed')).toEqual([]);
  expect((await runtime.host.getState()).sessions.find(item => item.id === codex.id)?.observation?.nativeSessionId).toBe(CODEX);
  const manifest: ContinuitySnapshotSummary[] = []; let offset = 0;
  for (;;) {
    const page = unpack<{ canonicalId: string; snapshots: ContinuitySnapshotSummary[]; nextOffset?: number }>(await mcp('codex', CODEX, finalCode, 'status', { offset, limit: 2 }));
    expect(page.canonicalId).toBe(canonicalId); manifest.push(...page.snapshots);
    if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  expect(manifest.find(snapshot => snapshot.id === checkpoint.id)).toEqual(checkpoint);
  const recovered = unpack<ContinuityReadPage>(await mcp('codex', CODEX, finalCode, 'read', { snapshot_id: checkpoint.id, offset: decisionIndex, limit: 1 }));
  expect(recovered.snapshot).toEqual(checkpoint); expect(recovered.entries).toEqual([checkpointEntries[decisionIndex]]);
  expect(recovered.snapshot).toMatchObject({ sessionId: codex.id, sourceId: 'codex', nativeSessionId: CODEX });
  expect((await archived(codex.id, geminiBefore.id)).some(entry => entry.text.includes('GEMINI-PRE-COMPACTION'))).toBe(true);
  expect((await archived(codex.id, claudeBefore.id)).some(entry => entry.text.includes('CLAUDE-PRE-COMPACTION'))).toBe(true);
  expect((await mcp('claude', CLAUDE, finalCode, 'read', { snapshot_id: checkpoint.id })).isError).toBe(true);
  const laterCodex = final.snapshots.at(-1)!;
  expect(manifest.some(snapshot => snapshot.id === laterCodex.id)).toBe(false);
  expect((await mcp('codex', CODEX, finalCode, 'read', { snapshot_id: laterCodex.id })).isError).toBe(true);
  expect((await mcp('gemini', GEMINI, firstCode, 'read', { snapshot_id: claudeBefore.id })).isError).toBe(true);
  expect(await readFile(files.codex, 'utf8')).not.toContain(DECISION);
  expect(provider).not.toHaveBeenCalled();
}, 30_000);
