import type * as childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_HOST_METHODS, type ObservedControlStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { AttachmentStore } from '../src/attachments.js';
import { pollObservedInbox } from '../src/observedInboxClient.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { useTempDirs } from './helpers.js';

const shellFixtures = vi.hoisted(() => new Set<string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn((bin: string, args: string[], options: childProcess.SpawnOptions) =>
    // Execute only registered temporary fixtures through their declared interpreter.
    shellFixtures.has(bin) ? actual.spawn('/bin/sh', [bin, ...args], options) : actual.spawn(bin, args, options)) };
});
afterEach(() => { shellFixtures.clear(); });

const temporary = useTempDirs();
async function fixture(extraEnv: Record<string, string> = {}, observationIntervalMs = 60_000) {
  const root = await temporary(), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home);
  const fetch = vi.fn(async (_input?: unknown): Promise<Response> => { throw new Error('No provider call belongs to cooperative messaging.'); });
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data,
    homeDirectory: home, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '', ...extraEnv }, fetch, observationIntervalMs });
  return { root, home, data, runtime, host: runtime.host, fetch };
}
const inboxCapability = (status: ObservedControlStatus) => status.routes.find(route => route.route === 'cooperative-inbox')!.capabilities.find(capability => capability.available)!.capabilityId!;

it('routes two manual agents independently through the actual host and MCP without creating native sessions', async () => {
  const f = await fixture();
  try {
    for (const method of ['observedControlStatus', 'dispatchObservedControl', 'createObservedInbox', 'listManualObservedInboxes']) expect(AGENT_HOST_METHODS).toContain(method);
    const first = await f.host.createManualObservedInbox!('Claude Code');
    const second = await f.host.createManualObservedInbox!('Gemini CLI');
    expect((await f.host.listManualObservedInboxes!()).map(item => item.label)).toEqual(['Claude Code', 'Gemini CLI']);
    const status = await f.host.observedControlStatus!(first.sessionId);
    expect(status.routes.filter(route => route.state === 'ready').map(route => route.route)).toEqual(['cooperative-inbox']);
    expect(JSON.stringify(status)).not.toContain(first.token);
    const input = { operationId: 'message-one', capabilityId: inboxCapability(status), text: 'Review the current change.' };
    const receipt = await f.host.dispatchObservedControl!(first.sessionId, input);
    expect(receipt.state).toBe('queued');
    expect(await f.host.dispatchObservedControl!(first.sessionId, input)).toEqual(receipt);
    expect((await f.host.observedInboxStatus!(first.sessionId)).queued).toBe(1);
    expect(await pollObservedInbox({ url: second.url!, token: second.token!, waitMs: 0 })).toEqual({ status: 'empty' });
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'poll_inbox', arguments: { url: first.url, token: first.token, waitMs: 0 },
    } }, { extaliaHome: f.data, app: 'claude' });
    const result = response as { result: { content: { text: string }[] } };
    const message = JSON.parse(result.result.content[0]!.text) as { status: string; message: { messageId: string; text: string } };
    expect(message).toMatchObject({ status: 'message', message: { messageId: receipt.messageId, text: input.text } });
    expect(await pollObservedInbox({ url: first.url!, token: first.token!, ack: message.message.messageId })).toMatchObject({ status: 'empty', acknowledged: receipt.messageId });
    expect((await f.host.observedInboxStatus!(first.sessionId)).receipts?.[0]?.state).toBe('acknowledged');
    expect((await f.host.getState()).sessions).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  } finally { await f.runtime.close(); }
});

it('seals an observed inbox and capability on pause/resume, including an ABA watch transition', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: '/projects/example', timestamp: '2026-11-10T00:00:00.000Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Source request' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const scan = await f.host.scanImports(['codex']);
    const state = await f.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const id = state.sessions[0]!.id;
    const inbox = await f.host.createObservedInbox!(id);
    const before = await f.host.observedControlStatus!(id), capabilityId = inboxCapability(before);
    const waiting = pollObservedInbox({ url: inbox.url!, token: inbox.token!, waitMs: 25_000 });
    await f.host.setObservation(id, false);
    expect((await waiting).status).toBe('unavailable');
    await f.host.setObservation(id, true);
    const after = await f.host.observedControlStatus!(id);
    expect(after.bindingId).not.toBe(before.bindingId);
    expect(await f.host.dispatchObservedControl!(id, { operationId: 'stale-operation', capabilityId, text: 'Must not send' })).toMatchObject({ state: 'rejected' });
    expect((await f.host.observedCodexQueueStatus!(id)).enabled).toBe(false);
    const replacement = await f.host.createObservedInbox!(id);
    expect(replacement.channelId).not.toBe(inbox.channelId);
    await f.host.deleteSession(id);
    expect((await pollObservedInbox({ url: replacement.url!, token: replacement.token!, waitMs: 0 })).status).toBe('unavailable');
  } finally { await f.runtime.close(); }
});

it('keeps concurrent manual creations independent and revokes them all at host close', async () => {
  const f = await fixture();
  const channels = await Promise.all(Array.from({ length: 8 }, (_, index) => f.host.createManualObservedInbox!(`CLI ${index + 1}`)));
  try {
    expect(channels.every(channel => channel.state === 'connected')).toBe(true);
    expect(new Set(channels.map(channel => channel.channelId)).size).toBe(8);
    expect((await f.host.listManualObservedInboxes!()).length).toBe(8);
  } finally { await f.runtime.close(); }
  expect((await pollObservedInbox({ url: channels[0]!.url!, token: channels[0]!.token!, waitMs: 0 })).status).toBe('unknown');
});

it.each([
  { app: 'gemini' as const, sourceId: 'gemini-cli', nativeSessionId: 'gem-session-101' },
  { app: 'antigravity' as const, sourceId: 'antigravity', nativeSessionId: 'agy-session-202' },
])('queues and delivers observed messages for watched $sourceId sessions via PromptQueues and session-bound MCP poll_inbox', async ({ app, sourceId, nativeSessionId }) => {
  const f = await fixture();
  try {
    await f.runtime.hooks!.listen();
    await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: nativeSessionId, intent: 'Inspecting workspace' } },
    }, { extaliaHome: f.data, app });

    await vi.waitFor(async () => {
      const state = await f.host.getState();
      expect(state.sessions.some(s => s.observation?.sourceId === sourceId && s.observation.nativeSessionId === nativeSessionId)).toBe(true);
    });
    const observed = (await f.host.getState()).sessions.find(
      s => s.observation?.sourceId === sourceId && s.observation.nativeSessionId === nativeSessionId,
    )!;

    // observedControlStatus automatically prepares the session-bound inbox for watched Gemini CLI / Antigravity sessions
    const controlStatus = await f.host.observedControlStatus!(observed.id);
    expect(controlStatus.state).toBe('ready');
    expect(controlStatus.routes.filter(r => r.state === 'ready').map(r => r.route)).toEqual(['cooperative-inbox']);

    // PromptQueues supports watched Gemini CLI / Antigravity sessions and dispatches into the session inbox
    const initialQueue = await f.host.promptQueueStatus!(observed.id);
    expect(initialQueue.supported).toBe(true);
    await f.host.changePromptQueue!(observed.id, {
      action: 'add',
      text: `Please run unit tests in ${sourceId}.`,
      start: true,
      revision: initialQueue.revision,
    });

    await vi.waitFor(async () => {
      const inbox = await f.host.observedInboxStatus!(observed.id);
      expect(inbox.queued).toBe(1);
    });

    // Session-bound MCP poll_inbox retrieves and acknowledges the message using session_id without manual URL/token pairing
    const pollRes = await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'poll_inbox', arguments: { session_id: nativeSessionId, waitMs: 0 } },
    }, { extaliaHome: f.data, app }) as { result: { content: { text: string }[]; isError: boolean } };
    expect(pollRes.result.isError).toBe(false);
    const delivered = JSON.parse(pollRes.result.content[0]!.text) as { status: string; message: { messageId: string; text: string } };
    expect(delivered).toMatchObject({
      status: 'message',
      message: { text: `Please run unit tests in ${sourceId}.` },
    });

    const ackRes = await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'poll_inbox', arguments: { session_id: nativeSessionId, ack: delivered.message.messageId } },
    }, { extaliaHome: f.data, app }) as { result: { content: { text: string }[]; isError: boolean } };
    expect(ackRes.result.isError).toBe(false);
    expect(JSON.parse(ackRes.result.content[0]!.text)).toMatchObject({
      status: 'empty',
      acknowledged: delivered.message.messageId,
    });
    expect((await f.host.observedInboxStatus!(observed.id)).receipts?.[0]?.state).toBe('acknowledged');
  } finally {
    await f.runtime.close();
  }
});

// This fake agentapi executable is a POSIX shell script.
it.skipIf(process.platform === 'win32')('delivers observed Antigravity prompts directly via native agentapi send-message when installed', async () => {
  const f = await fixture();
  try {
    const binDir = path.join(f.home, '.gemini', 'antigravity', 'bin');
    const daemonDir = path.join(f.home, '.gemini', 'antigravity', 'daemon');
    const logPath = path.join(f.home, 'agentapi-calls.json');
    const agentApiPath = path.join(binDir, 'agentapi');
    await mkdir(binDir, { recursive: true });
    await mkdir(daemonDir, { recursive: true });
    await writeFile(
      path.join(daemonDir, 'hub_63377.json'),
      JSON.stringify({ pid: process.pid, httpPort: 63377, httpsPort: 63376, csrfToken: 'test-csrf-123' }),
    );
    await writeFile(
      agentApiPath,
      `#!/bin/sh\nprintf '{"args":["%s","%s","%s","%s"],"ls":"%s","csrf":"%s"}' "$1" "$2" "$3" "$4" "$ANTIGRAVITY_LS_ADDRESS" "$ANTIGRAVITY_CSRF_TOKEN" > ${JSON.stringify(logPath)}\n`,
    );
    await chmod(agentApiPath, 0o755);
    shellFixtures.add(agentApiPath);

    await f.runtime.hooks!.listen();
    const nativeSessionId = '88888888-8888-4888-8888-888888888888';
    await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: nativeSessionId, intent: 'Ready in Antigravity' } },
    }, { extaliaHome: f.data, app: 'antigravity' });

    await vi.waitFor(async () => {
      const state = await f.host.getState();
      expect(state.sessions.some(s => s.observation?.sourceId === 'antigravity' && s.observation.nativeSessionId === nativeSessionId)).toBe(true);
    });
    const observed = (await f.host.getState()).sessions.find(
      s => s.observation?.sourceId === 'antigravity' && s.observation.nativeSessionId === nativeSessionId,
    )!;

    const initialQueue = await f.host.promptQueueStatus!(observed.id);
    await f.host.changePromptQueue!(observed.id, {
      action: 'add',
      text: 'Hello directly from Extalia composer!',
      start: true,
      revision: initialQueue.revision,
    });

    await vi.waitFor(async () => {
      const recorded = JSON.parse(await readFile(logPath, 'utf8')) as { args: string[]; ls: string; csrf: string };
      expect(recorded).toEqual({
        args: [
          'send-message',
          '--title=Extalia Prompt',
          nativeSessionId,
          'Hello directly from Extalia composer!',
        ],
        ls: 'localhost:63377',
        csrf: 'test-csrf-123',
      });
    });

    await vi.waitFor(async () => {
      const events = await f.host.sessionEvents(observed.id);
      expect(events.some(e => e.body.type === 'prompt.submitted' && e.body.text === 'Hello directly from Extalia composer!')).toBe(true);
    });
  } finally {
    await f.runtime.close();
  }
});

it('discovers only available models for watched Antigravity and Gemini CLI sessions', async () => {
  const f = await fixture();
  try {
    const daemonDir = path.join(f.home, '.gemini', 'antigravity', 'daemon');
    await mkdir(daemonDir, { recursive: true });
    await writeFile(
      path.join(daemonDir, 'hub_63377.json'),
      JSON.stringify({ pid: process.pid, httpPort: 63377, httpsPort: 63376, csrfToken: 'test-csrf-models' }),
    );
    await writeFile(
      path.join(f.home, '.gemini', 'settings.json'),
      JSON.stringify({
        model: { name: 'gemini-2.5-pro' },
        models: [
          { modelId: 'gemini-2.5-pro' },
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-ultra-disabled', disabled: true },
        ],
      }),
    );

    f.fetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === 'http://localhost:63377/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        return new Response(JSON.stringify({
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M418' } },
          clientModelConfigs: [
            {
              label: 'Gemini 4 Argon (Medium)',
              modelId: 'gemini-4-argon-medium',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M418' },
              quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-17T00:00:00Z' },
            },
            {
              label: 'Claude Sonnet 5.5 (High)',
              modelId: 'claude-sonnet-5-5-high',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M405' },
              quotaInfo: { remainingFraction: 1, resetTime: '2026-11-17T00:00:00Z' },
            },
            {
              label: 'Gemini 4 Carbon',
              modelId: 'gemini-4-carbon-disabled',
              disabled: true,
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
              quotaInfo: {},
            },
            {
              label: 'Exhausted Model',
              modelId: 'exhausted-model',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' },
              quotaInfo: { remainingFraction: 0 },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await f.runtime.hooks!.listen();
    const agySessionId = '99999999-9999-4999-8999-999999999999';
    const geminiSessionId = '77777777-7777-4777-8777-777777777777';
    await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: agySessionId, intent: 'Antigravity model test' } },
    }, { extaliaHome: f.data, app: 'antigravity' });
    await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: geminiSessionId, intent: 'Gemini model test' } },
    }, { extaliaHome: f.data, app: 'gemini' });

    await vi.waitFor(async () => {
      const state = await f.host.getState();
      expect(state.sessions.some(s => s.observation?.nativeSessionId === agySessionId)).toBe(true);
      expect(state.sessions.some(s => s.observation?.nativeSessionId === geminiSessionId)).toBe(true);
    });
    const sessions = (await f.host.getState()).sessions;
    const observedAgy = sessions.find(s => s.observation?.nativeSessionId === agySessionId)!;
    const observedGemini = sessions.find(s => s.observation?.nativeSessionId === geminiSessionId)!;

    const agyChoices = await f.host.modelChoices('', observedAgy.id);
    expect(agyChoices).toMatchObject({
      runtime: 'extalia-native',
      defaultModel: 'gemini-4-argon-medium',
      models: ['gemini-4-argon-medium', 'claude-sonnet-5-5-high'],
      efforts: [],
    });
    expect(agyChoices.models).not.toContain('gemini-4-carbon-disabled');
    expect(agyChoices.models).not.toContain('exhausted-model');

    const geminiChoices = await f.host.modelChoices('', observedGemini.id);
    expect(geminiChoices).toMatchObject({
      runtime: 'extalia-native',
      defaultModel: 'gemini-2.5-pro',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    });
    expect(geminiChoices.efforts).toEqual([]);
    expect(geminiChoices.models).not.toContain('gemini-ultra-disabled');
  } finally {
    await f.runtime.close();
  }
});

it('discovers listed Codex models and configured Claude Code models for observed sessions', async () => {
  const f = await fixture({}, 20);
  try {
    const codexRoot = path.join(f.home, '.codex'), sessionsDir = path.join(codexRoot, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(codexRoot, 'config.toml'), 'model = "example-model-a"\nmodel_reasoning_effort = "low"\n');
    await writeFile(path.join(codexRoot, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'example-model-a', visibility: 'list', supported_in_api: true },
      { slug: 'example-model-b', visibility: 'list', supported_in_api: false },
      { slug: 'example-hidden', visibility: 'hide', supported_in_api: true },
    ] }));
    await writeFile(path.join(sessionsDir, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: '22222222-2222-4222-8222-222222222222', cwd: '/projects/example', timestamp: '2026-11-10T00:00:00.000Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Example' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const scan = await f.host.scanImports(['codex']);
    const state = await f.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const codexChoices = await f.host.modelChoices('', state.sessions[0]!.id);
    expect(codexChoices.models).toEqual(['example-model-a', 'example-model-b']);
    expect(codexChoices.defaultModel).toBe('example-model-a');
    expect(codexChoices.defaultEffort).toBe('low');
    expect(codexChoices.observedSelection).toMatchObject({ canSetSettings: false });
    const transcript = path.join(sessionsDir, 'rollout.jsonl');
    await writeFile(transcript, (await readFile(transcript, 'utf8')) + JSON.stringify({
      type: 'turn_context', timestamp: '2026-11-11T00:00:00Z', payload: { model: 'example-model-b', effort: 'high' },
    }) + '\n');
    await vi.waitFor(async () => {
      const current = (await f.host.getState()).sessions.find(item => item.id === state.sessions[0]!.id);
      expect(current).toMatchObject({ model: 'example-model-b', effort: 'high' });
    }, { timeout: 5000 });
    const activeChoices = await f.host.modelChoices('', state.sessions[0]!.id);
    expect(activeChoices).toMatchObject({ defaultModel: 'example-model-b', defaultEffort: 'high',
      observedSelection: { model: 'example-model-b', effort: 'high', canSetSettings: false } });


    const claudeRoot = path.join(f.home, '.claude');
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(path.join(claudeRoot, 'settings.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'example-opus' } }));
    await f.runtime.hooks!.listen();
    const claudeSessionId = '33333333-3333-4333-8333-333333333333';
    await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: claudeSessionId, intent: 'Claude model test' } } }, { extaliaHome: f.data, app: 'claude' });
    await vi.waitFor(async () => expect((await f.host.getState()).sessions.some(s => s.observation?.nativeSessionId === claudeSessionId)).toBe(true));
    const observed = (await f.host.getState()).sessions.find(s => s.observation?.nativeSessionId === claudeSessionId)!;
    const claudeChoices = await f.host.modelChoices('', observed.id);
    expect(claudeChoices.defaultModel).toBe('sonnet');
    expect(claudeChoices.models).toEqual(expect.arrayContaining(['sonnet', 'example-opus']));
  } finally {
    await f.runtime.close();
  }
});

it('stages unique per-attachment files for observed prompts, avoids stale or duplicated tags, and cleans up on remove/delete', async () => {
  const f = await fixture();
  let releaseFirstFinalization!: () => void;
  const firstFinalization = new Promise<void>(resolve => { releaseFirstFinalization = resolve; });
  const consumeAttachments = AttachmentStore.prototype.consume;
  // The inbox can be consumed before attachment persistence and the queue's own receipt settle.
  // Hold that real boundary once so the sequential-prompt test does not rely on fast local disk I/O.
  const consume = vi.spyOn(AttachmentStore.prototype, 'consume').mockImplementationOnce(async function (this: AttachmentStore, sessionId, ids) {
    await firstFinalization;
    await consumeAttachments.call(this, sessionId, ids);
  });
  let firstInboxReceipt = true;
  const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pngA = Buffer.from([...PNG_HEAD, 1, 2, 3, 4]);
  const pngB = Buffer.from([...PNG_HEAD, 5, 6, 7, 8]);
  try {
    await f.runtime.hooks!.listen();
    const nativeSessionId = 'gem-attach-lifecycle';
    await handleMcpJsonRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_intent', arguments: { session_id: nativeSessionId, intent: 'Inspect attachments' } },
    }, { extaliaHome: f.data, app: 'gemini' });

    await vi.waitFor(async () => {
      const state = await f.host.getState();
      expect(state.sessions.some(s => s.observation?.nativeSessionId === nativeSessionId)).toBe(true);
    });
    const observed = (await f.host.getState()).sessions.find(s => s.observation?.nativeSessionId === nativeSessionId)!;

    const firstShot = await f.host.uploadAttachment(observed.id, { name: 'shot.png', mimeType: 'image/png', data: pngA.toString('base64') });
    const secondShot = await f.host.uploadAttachment(observed.id, { name: 'shot.png', mimeType: 'image/png', data: pngB.toString('base64') });
    const notes = await f.host.uploadAttachment(observed.id, { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('note-payload', 'utf8').toString('base64') });
    const pre = await f.host.uploadAttachment(observed.id, { name: 'pre.txt', mimeType: 'text/plain', data: Buffer.from('pre-payload', 'utf8').toString('base64') });
    const discard = await f.host.uploadAttachment(observed.id, { name: 'discard.txt', mimeType: 'text/plain', data: Buffer.from('discard', 'utf8').toString('base64') });

    const filesRoot = path.join(f.data, 'attachments', observed.id, 'files');
    const pathA = path.join(filesRoot, firstShot.id, 'shot.png');
    const pathB = path.join(filesRoot, secondShot.id, 'shot.png');
    const pathNotes = path.join(filesRoot, notes.id, 'notes.txt');
    const pathPre = path.join(filesRoot, pre.id, 'pre.txt');
    const pathDiscardDir = path.join(filesRoot, discard.id);
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    expect(existsSync(pathDiscardDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(filesRoot, firstShot.id))).mode & 0o777).toBe(0o700);
      expect((await stat(pathA)).mode & 0o777).toBe(0o600);
    }

    await f.host.removeAttachment(observed.id, discard.id);
    expect(existsSync(pathDiscardDir)).toBe(false);

    const pollNext = async (): Promise<string> => {
      let delivered: { status: string; message?: { messageId: string; text: string } } = { status: 'empty' };
      await vi.waitFor(async () => {
        const res = await handleMcpJsonRpc({
          jsonrpc: '2.0', id: 10, method: 'tools/call',
          params: { name: 'poll_inbox', arguments: { session_id: nativeSessionId, waitMs: 0 } },
        }, { extaliaHome: f.data, app: 'gemini' }) as { result: { content: { text: string }[]; isError: boolean } };
        expect(res.result.isError).toBe(false);
        delivered = JSON.parse(res.result.content[0]!.text) as { status: string; message?: { messageId: string; text: string } };
        expect(delivered.status).toBe('message');
      });
      await handleMcpJsonRpc({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'poll_inbox', arguments: { session_id: nativeSessionId, ack: delivered.message!.messageId } },
      }, { extaliaHome: f.data, app: 'gemini' });
      if (firstInboxReceipt) {
        firstInboxReceipt = false;
        await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
        const sending = await f.host.promptQueueStatus!(observed.id);
        expect(sending.items).toHaveLength(1);
        expect(sending.items[0]!.state).toBe('sending');
        await expect(f.host.changePromptQueue!(observed.id, {
          action: 'add', text: 'Must wait for the prior dispatch receipt', start: true, revision: sending.revision,
        })).rejects.toThrow('Inspect and acknowledge the unknown receipt, or wait for sending, before starting.');
        releaseFirstFinalization();
      }
      // MCP acknowledgement is independent of the sender's persisted dispatch receipt.
      // Starting the next prompt requires the actual queue to settle, without acknowledging uncertainty.
      await vi.waitFor(async () => {
        const settled = await f.host.promptQueueStatus!(observed.id);
        expect(settled.items.length).toBeGreaterThan(0);
        expect(settled.items.every(item => item.state === 'sent')).toBe(true);
      });
      return delivered.message!.text;
    };

    const queueAdd = async (text: string) => {
      const q = await f.host.promptQueueStatus!(observed.id);
      await f.host.changePromptQueue!(observed.id, { action: 'add', text, start: true, revision: q.revision });
    };

    // Prompt 1: two bare attachments sharing a filename resolve 1:1 in upload order without touching unrelated pending files.
    await queueAdd('[Attached file: shot.png]\n\n[Attached file: shot.png]\n\nCompare both');
    const delivered1 = await pollNext();
    expect(delivered1).toBe(`[Attached file: shot.png (${pathA})]\n\n[Attached file: shot.png (${pathB})]\n\nCompare both`);
    expect(await readFile(pathA)).toEqual(pngA);
    expect(await readFile(pathB)).toEqual(pngB);
    expect(existsSync(pathNotes)).toBe(true);
    expect(existsSync(pathPre)).toBe(true);

    // Prompt 2: already-pathed attachment keeps its original path (no duplicate tag) and cleans redundant staging.
    await queueAdd('[Attached file: pre.txt (/projects/example/pre.txt)]\n\nCheck pathed');
    const delivered2 = await pollNext();
    expect(delivered2).toBe('[Attached file: pre.txt (/projects/example/pre.txt)]\n\nCheck pathed');
    await vi.waitFor(() => {
      expect(existsSync(path.join(filesRoot, pre.id))).toBe(false);
    });

    // Prompt 3: consumes remaining pending notes.txt.
    await queueAdd('[Attached file: notes.txt]\n\nCheck notes');
    const delivered3 = await pollNext();
    expect(delivered3).toBe(`[Attached file: notes.txt (${pathNotes})]\n\nCheck notes`);
    expect(await readFile(pathNotes, 'utf8')).toBe('note-payload');

    // Prompt 4: plain prompt carries zero leftover attachment tags even though staged files remain readable for prior turns.
    await queueAdd('Follow-up without files');
    const delivered4 = await pollNext();
    expect(delivered4).toBe('Follow-up without files');

    await f.host.uploadAttachment(observed.id, { name: 'leftover.txt', mimeType: 'text/plain', data: Buffer.from('cleanup', 'utf8').toString('base64') });
    expect((await readdir(filesRoot)).length).toBeGreaterThanOrEqual(4);

    await f.host.deleteSession(observed.id);
    expect(existsSync(path.join(f.data, 'attachments', observed.id))).toBe(false);
  } finally {
    releaseFirstFinalization();
    consume.mockRestore();
    await f.runtime.close();
  }
});

it.skipIf(process.platform === 'win32')('stages attachment paths into queued Codex messages and consumes pending state on acceptance', async () => {
  const f = await fixture();
  const threadId = '11111111-1111-4111-8111-111111111111';
  const messageId = '22222222-2222-4222-8222-222222222222';
  const codexBin = path.join(f.root, 'codex-queue-stub.sh');
  const logPath = path.join(f.root, 'codex-queue-call.json');
  await writeFile(
    codexBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(1))); process.stdout.write("Queued message ${messageId} for thread ${threadId}.\\n");' "$@"\n`,
  );
  await chmod(codexBin, 0o755);
  shellFixtures.add(codexBin);
  await f.runtime.close();

  const f2 = await fixture({ EXTALIA_CODEX_BIN: codexBin });
  try {
    const folder = path.join(f2.home, '.codex', 'sessions');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: threadId, cwd: '/projects/example', timestamp: '2026-11-10T00:00:00.000Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex request' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const scan = await f2.host.scanImports(['codex']);
    const state = await f2.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const observed = state.sessions[0]!;

    const attached = await f2.host.uploadAttachment(observed.id, {
      name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('codex-evidence', 'utf8').toString('base64'),
    });
    const stagedPath = path.join(f2.data, 'attachments', observed.id, 'files', attached.id, 'evidence.txt');

    const q = await f2.host.promptQueueStatus!(observed.id);
    await f2.host.changePromptQueue!(observed.id, {
      action: 'add', text: '[Attached file: evidence.txt]\n\nInspect this', start: true, revision: q.revision,
    });

    await vi.waitFor(async () => {
      const args = JSON.parse(await readFile(logPath, 'utf8')) as string[];
      expect(args).toEqual(['queue', '--thread', threadId, '--message', `[Attached file: evidence.txt (${stagedPath})]\n\nInspect this`]);
    });
    expect(await readFile(stagedPath, 'utf8')).toBe('codex-evidence');
  } finally {
    await f2.runtime.close();
  }
});
