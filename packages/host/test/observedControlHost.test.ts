import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_HOST_METHODS, type ObservedControlStatus } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { pollObservedInbox } from '../src/observedInboxClient.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { useTempDirs } from './helpers.js';

const temporary = useTempDirs();
async function fixture() {
  const root = await temporary(), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home);
  const fetch = vi.fn(async () => { throw new Error('No provider call belongs to cooperative messaging.'); });
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data,
    homeDirectory: home, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, fetch, observationIntervalMs: 60_000 });
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
