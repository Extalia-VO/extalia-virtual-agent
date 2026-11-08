import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';
const temp = useTempDirs();

describe('configured Native context ceiling through the host', () => {
  it('persists the setting, avoids provider entry, and preserves the full prompt for an explicit retry', async () => {
    const root = await temp(); const project = path.join(root, 'project'); await mkdir(project);
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const runtime = await createAgentHost({
      kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'),
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(root, 'not-installed') }, knowledge: { watcher: false },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Continued after the explicit setting change.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const events: ExtaliaEvent[] = []; runtime.host.subscribe(event => events.push(event));
    const settings = { name: 'Example', preset: 'custom' as const, api: 'openai-chat' as const, baseUrl: 'https://example.com/v1', model: 'example-model', credential: { kind: 'none' as const }, features: { memory: 'off' as const, skills: 'off' as const } };
    try {
      const connected = await runtime.host.saveConnection({ ...settings, inputTokenLimit: 1024 });
      expect(connected.connections[0]!.inputTokenLimit).toBe(1024);
      const state = await runtime.host.saveWorkspace({ name: 'Example workspace', projectLocation: project, connectionId: connected.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const session = await runtime.host.createSession(state.workspaces[0]!.id);
      const fullPrompt = 'Important user requirement. '.repeat(300).trim();
      await runtime.host.sendPrompt(session.id, fullPrompt);
      for (let i = 0; i < 500 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(runtime.isBusy()).toBe(false); expect(requests).toHaveLength(0);
      expect(events.some(event => event.body.type === 'turn.failed' && event.body.error === 'native_context_limit' && event.body.reason === 'context')).toBe(true);
      expect((await runtime.host.getState()).sessions.find(item => item.id === session.id)?.context).toBeUndefined();
      await runtime.host.saveConnection({ ...settings, id: connected.connections[0]!.id });
      expect((await runtime.host.getState()).connections[0]!.inputTokenLimit).toBeUndefined();
      await runtime.host.sendPrompt(session.id, 'Continue after reviewing the input limit.');
      for (let i = 0; i < 500 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(runtime.isBusy()).toBe(false); expect(requests).toHaveLength(1);
      expect(requests[0]!.messages.some(message => message.role === 'user' && message.content === fullPrompt)).toBe(true);
      expect((await runtime.host.getState()).sessions.find(item => item.id === session.id)?.context).toMatchObject({ usedTokens: 2000, estimated: false });
    } finally { await runtime.close(); }
  });
});
