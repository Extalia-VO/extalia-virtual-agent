import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';

// A scripted OpenAI-compatible endpoint that answers in one step, optionally reporting usage.
function answering(usage: Record<string, number> | undefined) {
  const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  return async (url: string): Promise<Response> => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-agent' }] });
    return sse([{ choices: [{ delta: { content: 'Hello.' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }]);
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function run(usage: Record<string, number> | undefined, prompt: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-context-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  const runtime: AgentHostRuntime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'),
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch: answering(usage) });
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const { host } = runtime;
  const saved = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } });
  await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const state = await host.completeSetup();
  const session = await host.createSession(state.workspaces[0]!.id);
  await host.sendPrompt(session.id, prompt);
  for (let i = 0; i < 300 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const summary = (await host.getState()).sessions.find(item => item.id === session.id);
  return summary;
}

describe('managed session context', () => {
  it('records the prompt size the endpoint reported for the turn', async () => {
    const summary = await run({ prompt_tokens: 3_210, completion_tokens: 9 }, 'Say hello');
    expect(summary?.context).toMatchObject({ usedTokens: 3_210, estimated: false, compactions: 0 });
    // The model is not in the known table, so no window is stated.
    expect(summary?.context?.windowTokens).toBeUndefined();
  });

  it('estimates the context from the text when the endpoint reports no usage', async () => {
    const summary = await run(undefined, 'Say hello');
    expect(summary?.context).toMatchObject({ estimated: true, compactions: 0 });
    expect(summary!.context!.usedTokens).toBeGreaterThan(0);
  });
});
