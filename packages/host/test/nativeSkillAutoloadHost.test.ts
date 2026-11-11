import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTeam, FeatureOwner } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
type Request = { messages: { role: string; content?: string; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] };
const reply = (delegate = false) => new Response(`data: ${JSON.stringify({ choices: [{ delta: delegate
  ? { tool_calls: [{ index: 0, id: 'delegate-1', function: { name: 'delegate_task', arguments: JSON.stringify({ member: 'Review worker', task: 'Review authentication security' }) } }] }
  : { content: 'Done.' }, finish_reason: delegate ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });

async function setup(skills: FeatureOwner = 'extalia', delegate = false) {
  const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
  const requests: Request[] = [], events: ExtaliaEvent[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'),
    homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH },
    modelDiscovery: async () => ['fixture'], fetch: async (_, init) => {
      const request = JSON.parse(String(init?.body)) as Request; requests.push(request);
      const worker = request.messages[0]?.content?.startsWith('You are a worker agent');
      return reply(delegate && !worker && !request.messages.some(message => message.role === 'tool'));
    } });
  runtimes.push(runtime); runtime.host.subscribe(event => events.push(event));
  const state = await runtime.host.saveConnection({ name: 'Fixture lead', preset: 'custom', api: 'openai-chat', baseUrl: 'http://fixture.example/v1', model: 'fixture',
    credential: { kind: 'none' }, features: { memory: 'off', skills } });
  const connection = state.connections.find(item => item.name === 'Fixture lead')!;
  const saved = await runtime.host.saveWorkspace({ name: 'Fixture project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  return { runtime, requests, events, connection, workspace: saved.workspaces[0]! };
}

async function finished(runtime: AgentHostRuntime) {
  for (let i = 0; i < 500; i++) { if (!runtime.isBusy()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic Native turn did not settle.');
}

describe('production host automatic skill composition', () => {
  it('prepares mandatory memory guidance before inference without enabling disabled memory', async () => {
    const f = await setup(); const session = await f.runtime.host.createSession(f.workspace.id);
    await f.runtime.host.sendPrompt(session.id, 'Hello there'); await finished(f.runtime);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.messages[0]!.content).toContain('# Recall workspace memory');
    expect(f.requests[0]!.tools?.some(tool => tool.function.name.startsWith('memory_'))).toBe(false);
    const report = f.events.find(event => event.body.type === 'skills.loaded')!;
    expect(report.body).toMatchObject({ type: 'skills.loaded', skills: expect.arrayContaining([
      expect.objectContaining({ name: 'memory-recall', status: 'loaded', reason: 'default-memory' }),
      expect.objectContaining({ name: 'orchestrator', status: 'not-configured' }),
    ]) });
    expect(f.events.indexOf(report)).toBeLessThan(f.events.findIndex(event => event.body.type === 'model.completed'));
    expect(JSON.stringify(report.body)).not.toContain('# Recall workspace memory');
    expect(f.events.some(event => event.body.type === 'turn.completed')).toBe(true);
    const stored = await f.runtime.host.sessionEvents(session.id);
    expect(stored.some(event => event.id === report.id)).toBe(true);
  });

  it('respects the connection skills-off feature', async () => {
    const f = await setup('off'); const session = await f.runtime.host.createSession(f.workspace.id);
    await f.runtime.host.sendPrompt(session.id, 'Review security'); await finished(f.runtime);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.messages[0]!.content).not.toContain('<extalia-loaded-skills>');
    expect(f.events.some(event => event.body.type === 'skills.loaded')).toBe(false);
  });

  it.each(['off', 'extalia'] as const)('prepares worker context using its own %s feature while the configured lead loads orchestrator', async workerSkills => {
    const f = await setup('extalia', true);
    const saved = await f.runtime.host.saveConnection({ name: 'Fixture worker', preset: 'custom', api: 'openai-chat', baseUrl: 'http://worker.example/v1', model: 'fixture',
      credential: { kind: 'none' }, features: { memory: 'off', skills: workerSkills } });
    const workerConnection = saved.connections.find(item => item.name === 'Fixture worker')!;
    const team: AgentTeam = { enabled: true, allowedModels: ['fixture'], connections: [
      { connectionId: f.connection.id, allowedModels: ['fixture'] }, { connectionId: workerConnection.id, allowedModels: ['fixture'] },
    ], members: [{ id: 'worker-a', name: 'Review worker', role: 'Reviewer', connectionId: workerConnection.id, models: ['fixture'] }] };
    const session = await f.runtime.host.createSession(f.workspace.id, { team });
    await f.runtime.host.sendPrompt(session.id, 'Have the reviewer inspect authentication security'); await finished(f.runtime);
    expect(f.events.some(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toBe(true);
    expect(f.requests).toHaveLength(3);
    const worker = f.requests.find(request => request.messages[0]!.content?.startsWith('You are a worker agent'))!;
    const lead = f.requests.find(request => !request.messages[0]!.content?.startsWith('You are a worker agent'))!;
    expect(lead.messages[0]!.content).toContain('# Bounded prompt routine');
    expect(worker.messages[0]!.content).not.toContain('# Bounded prompt routine');
    const receipts = f.events.filter(event => event.agentId === 'worker-a' && event.body.type === 'skills.loaded');
    if (workerSkills === 'extalia') {
      expect(worker.messages[0]!.content).toContain('# Recall workspace memory'); expect(receipts).toHaveLength(1);
      expect(receipts[0]!.body).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ name: 'code-review', status: 'loaded' })]) });
    } else { expect(worker.messages[0]!.content).not.toContain('<extalia-loaded-skills>'); expect(receipts).toEqual([]); }
  });
});
