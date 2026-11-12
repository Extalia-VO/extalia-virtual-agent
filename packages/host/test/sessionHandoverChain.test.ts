import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContinuityNotes, ContinuityReadPage, ContinuitySnapshotSummary } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { pollObservedInbox } from '../src/observedInboxClient.js';
import { SessionStore } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

// Scripted transports/transcripts exercise Extalia's integration boundary, not real
// Codex/Claude/Gemini applications or any remote model's retention of context.
const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
const CODEX = '11111111-1111-4111-8111-111111111111';
const CLAUDE = '22222222-2222-4222-8222-222222222222';
const notes: ContinuityNotes = { goal: 'CHAIN-OBJECTIVE: finish the original migration',
  decisions: 'DECISION-KEEP: retain the tested schema and existing work', completed: 'CHECKLIST-DONE: inspect the original source',
  pending: 'CHECKLIST-NEXT: verify the remaining adapter', verification: 'Source transcript claims are not independently verified tests',
  risks: 'Do not infer hidden context, replay tools, or claim model consumption' };
const timestamp = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
const codexRow = (role: 'user' | 'assistant', text: string, index: number) => ({ type: 'response_item', timestamp: timestamp(index),
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const jsonLines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const accessCode = (packet: string) => {
  const value = packet.match(/\bsk-extalia-context-[a-f0-9]{64}\b/)?.[0]; expect(value).toBeTruthy(); return value!;
};

it('preserves long original evidence through four mixed-runtime hops, pages omissions and excludes exact capsule echoes', async () => {
  const root = await temp('extalia-mixed-handover-chain-');
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  const codexFile = path.join(home, '.codex', 'sessions', 'rollout.jsonl');
  const claudeFile = path.join(home, '.claude', 'projects', 'example', `${CLAUDE}.jsonl`);
  await Promise.all([mkdir(project), mkdir(path.dirname(codexFile), { recursive: true }), mkdir(path.dirname(claudeFile), { recursive: true })]);
  const claudeRow = (role: 'user' | 'assistant', text: string, index: number) => ({ type: role, sessionId: CLAUDE,
    uuid: `claude-${index}`, parentUuid: index ? `claude-${index - 1}` : null, cwd: project, timestamp: timestamp(index),
    message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { model: 'claude-fixture', stop_reason: 'end_turn' } : {}) } });
  await writeFile(codexFile, jsonLines([
    { type: 'session_meta', payload: { id: CODEX, cwd: project, timestamp: timestamp(0) } },
    codexRow('user', notes.goal, 1), codexRow('assistant', 'ORIGINAL-CHECKPOINT: schema inspection completed', 2),
    ...Array.from({ length: 28 }, (_, index) => codexRow('assistant', `EVIDENCE-${index.toString().padStart(2, '0')}: ${'bounded source detail '.repeat(180)}`, index + 3)),
    codexRow('assistant', `LONG-TAIL: ${'long detail '.repeat(1000)}`, 40),
  ]));
  await writeFile(claudeFile, jsonLines([claudeRow('user', 'Existing destination conversation', 0), claudeRow('assistant', 'Ready for reviewed work', 1)]));
  const requests: { model: string; messages: unknown[] }[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'scripted-native' }] });
      requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'NATIVE-CHECKPOINT: verified the next adapter fixture' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  active.add(runtime);
  const host = runtime.host;
  const connection = (await host.saveConnection({ name: 'Gemini fixture (scripted OpenAI-compatible transport)', preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://fixture.example/v1', model: 'scripted-native', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } })).connections[0]!;
  await host.saveWorkspace({ name: 'Chain fixture', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const scan = await host.scanImports(['codex', 'claude-code']);
  const state = await host.observeImports(scan.scanId, scan.sessions.map(session => session.id));
  const codex = state.sessions.find(session => session.observation?.nativeSessionId === CODEX)!;
  const claude = state.sessions.find(session => session.observation?.nativeSessionId === CLAUDE)!;
  expect(codex).toBeDefined(); expect(claude).toBeDefined();
  await runtime.hooks!.listen(0);
  const mcp = async (app: 'codex' | 'claude', nativeId: string, code: string, name: 'status' | 'read', args: Record<string, unknown> = {}) => {
    const reply = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `extalia_continuity_${name}`,
      arguments: { access_code: code, ...args } } }, { extaliaHome: data, app, sessionId: nativeId });
    return reply!.result as { isError?: boolean; content: { type: string; text: string }[] };
  };
  const unpack = <T>(result: { isError?: boolean; content: { text: string }[] }): T => {
    expect(result.isError).not.toBe(true); return JSON.parse(result.content[0]!.text) as T;
  };

  const first = await host.previewHandover!(codex.id, { target: { kind: 'native', connectionId: connection.id }, notes });
  const canonicalId = first.canonicalId, original = first.coverage[0]!;
  expect(first.packetOmittedEntries).toBeGreaterThan(0);
  expect(Buffer.byteLength(first.packet)).toBeLessThanOrEqual(14 * 1024);
  expect(first.packet).toContain('No external context consumption is claimed');
  expect(original).toMatchObject({ sourceId: 'codex', nativeSessionId: CODEX, coverage: { mode: 'partial' } });
  expect(original.coverage.limits.join(' ')).toContain('shortened');
  expect(original.coverage.observedThrough).toBeTruthy();
  const adopted = await host.applyHandover!(codex.id, { reviewId: first.reviewId, operationId: 'chain-adopt-native' });
  const nativeId = adopted.targetSessionId!;
  expect(adopted).toMatchObject({ canonicalId, state: 'native-ready' }); expect(requests).toHaveLength(0);
  await host.sendPrompt(nativeId, 'Continue CHECKLIST-NEXT using the preserved source evidence');
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000, interval: 10 });
  expect(JSON.stringify(requests[0]!.messages)).toContain(notes.decisions);

  const inbox = await host.createObservedInbox!(claude.id);
  const controls = await host.observedControlStatus!(claude.id);
  const capabilityId = controls.routes.find(route => route.route === 'cooperative-inbox')!.capabilities.find(capability => capability.available)!.capabilityId!;
  const toClaude = await host.previewHandover!(nativeId, { target: { kind: 'observed', sessionId: claude.id, capabilityId } });
  const claudeCode = accessCode(toClaude.packet);
  expect((await mcp('claude', CLAUDE, claudeCode, 'status')).isError).toBe(true);
  const queued = await host.applyHandover!(nativeId, { reviewId: toClaude.reviewId, operationId: 'chain-native-claude' });
  expect(queued).toMatchObject({ canonicalId, targetSessionId: claude.id, state: 'queued' });
  const delivery = await pollObservedInbox({ url: inbox.url!, token: inbox.token!, waitMs: 0 });
  expect(delivery.status).toBe('message'); if (delivery.status !== 'message') throw new Error('Missing fixture inbox packet');
  expect(delivery.message.text).toBe(toClaude.packet);
  await pollObservedInbox({ url: inbox.url!, token: inbox.token!, ack: delivery.message.messageId, waitMs: 0 });

  // Recover an original entry omitted from the bounded capsule through the real hook/MCP path.
  const originalEntries = (await host.readContinuity!(nativeId, { snapshotId: original.id, limit: 50 })).entries;
  const omittedIndex = originalEntries.findIndex(entry => entry.text.startsWith('EVIDENCE-') && !toClaude.packet.includes(entry.text.slice(0, 12)));
  expect(omittedIndex).toBeGreaterThanOrEqual(0);
  const restored = unpack<ContinuityReadPage>(await mcp('claude', CLAUDE, claudeCode, 'read', { snapshot_id: original.id, offset: omittedIndex, limit: 1 }));
  expect(restored.entries[0]).toEqual(originalEntries[omittedIndex]);
  expect(restored.snapshot.coverage).toEqual(original.coverage);
  expect((await mcp('codex', CODEX, claudeCode, 'read', { snapshot_id: original.id })).isError).toBe(true);

  const genuineQuote = 'EXTALIA CONTINUITY CAPSULE v1\nUser comment: this quoted heading is evidence, not a delivered packet.';
  await appendFile(claudeFile, jsonLines([claudeRow('user', toClaude.packet, 2), claudeRow('assistant', 'CLAUDE-CHECKPOINT: reviewed the remaining fixture', 3),
    claudeRow('user', genuineQuote, 4), claudeRow('assistant', 'Recorded the user comment', 5)]));
  await host.setObservation(claude.id, true);
  const toCodex = await host.previewHandover!(claude.id, { target: { kind: 'manual', sessionId: codex.id, label: 'Original Codex fixture' } });
  expect(toCodex.notes).toEqual(notes); expect(toCodex.canonicalId).toBe(canonicalId);
  const claudeSnapshot = [...toCodex.coverage].reverse().find(source => source.sessionId === claude.id)!;
  expect(claudeSnapshot.coverage.limits.join(' ')).toContain('exact previously handed-over user capsules excluded');
  const claudeArchive = await host.readContinuity!(claude.id, { snapshotId: claudeSnapshot.id, limit: 50 });
  expect(claudeArchive.entries.some(entry => entry.text === genuineQuote)).toBe(true);
  expect(claudeArchive.entries.some(entry => entry.text.includes('Canonical work:'))).toBe(false);
  expect((await mcp('claude', CLAUDE, claudeCode, 'read', { snapshot_id: claudeSnapshot.id })).isError).toBe(true);
  const manual = await host.applyHandover!(claude.id, { reviewId: toCodex.reviewId, operationId: 'chain-claude-codex' });
  expect(manual).toMatchObject({ canonicalId, targetSessionId: codex.id, state: 'manual-ready' });
  const codexCode = accessCode(toCodex.packet);
  const manifest = unpack<{ canonicalId: string; notes: ContinuityNotes; snapshots: ContinuitySnapshotSummary[]; total: number; nextOffset?: number }>(await mcp('codex', CODEX, codexCode, 'status', { limit: 2 }));
  expect(manifest).toMatchObject({ canonicalId, notes });
  expect(manifest.snapshots[0]!.id).toBe(original.id);
  expect(manifest.total).toBeGreaterThan(2); expect(manifest.nextOffset).toBe(2);
  const manifestTail = unpack<{ snapshots: ContinuitySnapshotSummary[] }>(await mcp('codex', CODEX, codexCode, 'status', { offset: manifest.nextOffset, limit: 2 }));
  expect(manifestTail.snapshots.some(source => source.id === claudeSnapshot.id)).toBe(true);
  await appendFile(codexFile, jsonLines([codexRow('user', toCodex.packet, 41), codexRow('assistant', 'CODEX-RETURN-CHECKPOINT: continue without restarting', 42)]));
  await host.setObservation(codex.id, true);

  const returnNative = await host.previewHandover!(codex.id, { target: { kind: 'native', connectionId: connection.id } });
  expect(returnNative.targetSessionId).toBe(nativeId);
  expect(returnNative.notes).toEqual(notes); expect(returnNative.handoverCount).toBe(3);
  expect(Buffer.byteLength(returnNative.packet)).toBeLessThanOrEqual(14 * 1024);
  const returned = await host.applyHandover!(codex.id, { reviewId: returnNative.reviewId, operationId: 'chain-reuse-native' });
  expect(returned).toMatchObject({ canonicalId, targetSessionId: nativeId, state: 'native-ready' });
  expect(requests).toHaveLength(1); // No handover performs model inference or acknowledges context consumption.
  const view = await host.sessionContinuity!(nativeId);
  expect(view).toMatchObject({ canonicalId, notes, notesOrigin: 'user-reviewed' });
  expect(view.handovers.map(hop => hop.state)).toEqual(['native-ready', 'queued', 'manual-ready', 'native-ready']);
  expect(view.snapshots.some(source => source.model === 'scripted-native' && source.sourceId === 'extalia-native')).toBe(true);
  expect((await host.getState()).sessions.filter(session => session.control === 'managed')).toHaveLength(1);
  for (const source of view.snapshots) {
    const archive = await host.readContinuity!(nativeId, { snapshotId: source.id, limit: 50 });
    expect(archive.entries.some(entry => entry.text.includes('Canonical work:'))).toBe(false);
  }
  const newestCodex = [...view.snapshots].reverse().find(source => source.sessionId === codex.id)!;
  expect(newestCodex.coverage.limits.join(' ')).toContain('exact previously handed-over user capsules excluded');
  expect((await mcp('codex', CODEX, codexCode, 'read', { snapshot_id: newestCodex.id })).isError).toBe(true);
  expect((await host.readContinuity!(nativeId, { snapshotId: original.id, offset: 0, limit: 1 })).entries[0]!.text).toBe(notes.goal);
  const store = new SessionStore(path.join(data, 'sessions'));
  const history = await store.readMessages(nativeId) as { extaliaHandover?: unknown }[];
  expect(history.filter(message => message.extaliaHandover)).toHaveLength(1);
}, 30_000);
