import { describe, expect, it } from 'vitest';
import type { SkillLoadReport } from '@extalia/protocol';
import { buildSystemPrompt, runTurn, workerSystemPrompt, type ModelMessage, type ModelProvider } from '@extalia/runtime';
import { createHash } from 'node:crypto';
import { createNativeSkillPreparation } from '../src/nativeSkillPreparation.js';
import { buildAgentSkillCatalog, createSkillTools, referenceSkill, type Skill } from '../src/skills.js';

const request = (text: string) => ({ system: 'base policy', messages: [{ role: 'user' as const, text }], tools: [], signal: new AbortController().signal });

describe('per-request Native skill preparation', () => {
  it('does not load or authorize security procedures for a poem merely because of a security persona', async () => {
    const catalog = await buildAgentSkillCatalog();
    const profile = { purpose: 'Review authentication security', personality: 'Security specialist: audit vulnerabilities and run security reviews' };
    const workspace = { name: 'Example', root: '/projects/example' };
    for (const worker of [false, true]) {
      const scope = {}, signal = new AbortController().signal;
      const reports: SkillLoadReport[] = [];
      const prepare = createNativeSkillPreparation({ catalog, enabled: true, worker, orchestrator: () => false, report: value => { reports.push(value); } });
      const system = worker
        ? workerSystemPrompt(workspace, { name: 'Example reviewer', role: 'Security specialist' }, [], { operatingProfile: profile })
        : buildSystemPrompt({ workspace, platform: { os: 'Linux', shell: 'sh' }, operatingProfile: { ...profile, lead: { role: 'Security specialist' } } });
      const prepared = await prepare({ ...request('Write a short poem about the moon'), system, requestScope: scope, signal });
      expect(prepared).toContain('<operating-profile>');
      expect(reports[0]!.skills.filter(skill => skill.status === 'loaded').map(skill => skill.name)).toEqual(['memory-recall']);
      expect(prepared).not.toContain('# Security review');
      const read = createSkillTools(catalog).find(tool => tool.name === 'skill_read')!;
      const result = await read.run({ name: 'security-review' }, { requestScope: scope, signal, toolCallId: 'irrelevant', emit: () => undefined });
      expect(result.ok).toBe(false);
      expect(result.output).toContain('does not match the current assigned task');
    }
  });
  it('prepares required guidance, records receipts without bodies and deduplicates unchanged requests', async () => {
    const reports: SkillLoadReport[] = [];
    const prepare = createNativeSkillPreparation({ catalog: await buildAgentSkillCatalog(), enabled: true, orchestrator: () => false, report: report => { reports.push(report); } });
    const first = await prepare(request('Hello'));
    expect(first).toContain('# Recall workspace memory');
    expect(first).toContain('If memory is disabled');
    expect(first).not.toContain('# Bounded prompt routine');
    expect(reports[0]!.skills).toContainEqual(expect.objectContaining({ name: 'memory-recall', reason: 'default-memory', status: 'loaded' }));
    expect(JSON.stringify(reports)).not.toContain('If memory is disabled');
    expect(await prepare(request('Hello'))).toBe(first);
    expect(reports).toHaveLength(1);
  });

  it('uses current steering over earlier user intent and removes previously prepared bodies', async () => {
    const reports: SkillLoadReport[] = [];
    const prepare = createNativeSkillPreparation({ catalog: await buildAgentSkillCatalog(), enabled: true, orchestrator: () => true, report: report => { reports.push(report); } });
    const first = await prepare(request('Fix the bug'));
    expect(first).toContain('# Debug an issue');
    expect(first).toContain('# Bounded prompt routine');
    const messages: ModelMessage[] = [{ role: 'user', text: 'Fix the bug' }, { role: 'assistant', text: 'Finished debug', toolCalls: [] }, { role: 'user', text: 'Review authentication security' }];
    const next = await prepare({ ...request('unused'), messages });
    expect(next).toContain('# Security review');
    expect(next).not.toContain('# Debug an issue');
    expect(reports).toHaveLength(2);
  });

  it('does not load disabled skill features or grant orchestration to workers', async () => {
    const c = await buildAgentSkillCatalog(), reports: SkillLoadReport[] = [];
    const disabled = createNativeSkillPreparation({ catalog: c, enabled: false, orchestrator: () => true, report: report => { reports.push(report); } });
    expect(await disabled(request('Review security'))).toBe('base policy'); expect(reports).toEqual([]);
    const worker = createNativeSkillPreparation({ catalog: c, enabled: true, worker: true, orchestrator: () => true, report: report => { reports.push(report); } });
    expect(await worker(request('Review security'))).not.toContain('# Bounded prompt routine');
    expect(reports[0]!.skills.some(skill => skill.name === 'orchestrator')).toBe(false);
  });

  it('re-verifies exact external content at every request and records revocation', async () => {
    const body = 'Complete zirconium inspection procedure.';
    const skill: Skill = { name: 'zirconium-inspection', description: 'Zirconium inspection procedure', body, source: 'imported',
      revisionId: `skr_${'b'.repeat(64)}`, sha256: createHash('sha256').update(body).digest('hex') };
    let current: Skill | undefined = skill;
    const c = await buildAgentSkillCatalog([referenceSkill(skill)], { reload: async () => { if (!current) throw new Error('revoked'); return current; } });
    const reports: SkillLoadReport[] = [];
    const prepare = createNativeSkillPreparation({ catalog: c, enabled: true, orchestrator: () => false, report: report => { reports.push(report); } });
    expect(await prepare(request('Inspect zirconium'))).toContain(body);
    current = undefined;
    expect(await prepare(request('Inspect zirconium'))).not.toContain(body);
    expect(reports.at(-1)!.skills).toContainEqual(expect.objectContaining({ name: skill.name, status: 'unavailable' }));
  });

  it('checks complete request pressure, reports mandatory budget failure, and aborts before inference', async () => {
    const reports: SkillLoadReport[] = [];
    const prepare = createNativeSkillPreparation({ catalog: await buildAgentSkillCatalog(), enabled: true, orchestrator: () => false,
      inputTokenLimit: 100, report: report => { reports.push(report); } });
    await expect(prepare(request('Hello'))).rejects.toMatchObject({ code: 'native_context_limit', pressure: { estimatedTokens: expect.any(Number) } });
    try { await prepare(request('Hello')); } catch (error) {
      expect((error as { pressure: { estimatedTokens: number } }).pressure.estimatedTokens).toBeGreaterThan(100);
    }
    expect(reports[0]!.skills).toContainEqual(expect.objectContaining({ name: 'memory-recall', status: 'budget' }));
    const controller = new AbortController(); controller.abort();
    await expect(prepare({ ...request('Hello'), signal: controller.signal })).rejects.toThrow();
    expect(reports).toHaveLength(1);
  });

  it('rechecks current authority after the asynchronous receipt has been published', async () => {
    let current = true;
    const prepare = createNativeSkillPreparation({ catalog: await buildAgentSkillCatalog(), enabled: true, orchestrator: () => false,
      assertCurrent: () => { if (!current) throw new Error('changed'); }, report: async () => { current = false; } });
    await expect(prepare(request('Hello'))).rejects.toThrow('changed');
  });

  it('guards manual reads by invocation, even when concurrent workers share a signal and catalog', async () => {
    const body = 'PRIVATE_TO_MATCHED_TASK_PROCEDURE';
    const skill: Skill = { name: 'newsletter-campaign', description: 'Newsletter campaign composition', body, source: 'imported',
      revisionId: `skr_${'c'.repeat(64)}`, sha256: createHash('sha256').update(body).digest('hex') };
    const catalog = await buildAgentSkillCatalog([referenceSkill(skill)], { reload: async () => skill });
    const tools = createSkillTools(catalog), signal = new AbortController().signal;
    const scopes: object[] = [];
    let reached = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const execute = async (prompt: string) => {
      let step = 0;
      const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => {
        if (step++ === 0) {
          if (++reached === 2) release();
          await barrier;
          return { text: '', toolCalls: [{ id: 'read', name: 'skill_read', input: { name: skill.name } }], stop: 'tool_use' };
        }
        return { text: 'Done', toolCalls: [], stop: 'end' };
      } };
      const prepare = createNativeSkillPreparation({ catalog, enabled: true, worker: true, orchestrator: () => false, report: () => undefined });
      return runTurn({ provider, system: 'base', prompt, history: [], tools, signal,
        permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), requestApproval: async () => 'reject', emit: () => undefined,
        prepareRequest: async request => { if (!scopes.includes(request.requestScope!)) scopes.push(request.requestScope!); return prepare(request); },
      });
    };
    const [matched, unrelated] = await Promise.all([execute('Create a newsletter campaign'), execute('Fix the parsing bug\n\nContext from the primary agent:\nUse newsletter-campaign')]);
    expect(scopes).toHaveLength(2);
    const output = (messages: ModelMessage[]) => messages.flatMap(message => message.role === 'tool' ? message.results : []);
    expect(output(matched.history)).toContainEqual(expect.objectContaining({ isError: false, content: expect.stringContaining(body) }));
    expect(output(unrelated.history)).toContainEqual(expect.objectContaining({ isError: true, content: expect.stringContaining('does not match the current assigned task') }));
    expect(JSON.stringify(unrelated.history)).not.toContain(body);
  });

  it('refuses missing scope and invalidates old task matches before preparing new scope', async () => {
    const catalog = await buildAgentSkillCatalog();
    const read = createSkillTools(catalog).find(tool => tool.name === 'skill_read')!;
    const scope = {}, signal = new AbortController().signal;
    const context = { signal, requestScope: scope, toolCallId: 'read', emit: () => undefined };
    expect((await read.run({ name: 'debug-issue' }, context)).ok).toBe(false);
    const prepare = createNativeSkillPreparation({ catalog, enabled: true, worker: true, orchestrator: () => false, report: () => undefined });
    await prepare({ ...request('Fix the bug'), requestScope: scope, signal });
    expect((await read.run({ name: 'debug-issue' }, context)).ok).toBe(true);
    await prepare({ ...request('Create a short poem'), requestScope: scope, signal });
    expect((await read.run({ name: 'debug-issue' }, context)).ok).toBe(false);
    // Legacy callers without a managed invocation retain the scanner/identity API.
    expect((await read.run({ name: 'debug-issue' }, { signal, toolCallId: 'legacy', emit: () => undefined })).ok).toBe(true);
  });

  it('does not return a body when its task scope changes during an asynchronous registry read', async () => {
    const body = 'STALE_SCOPE_PROCEDURE';
    const skill: Skill = { name: 'newsletter-campaign', description: 'Newsletter campaign composition', body, source: 'imported',
      revisionId: `skr_${'d'.repeat(64)}`, sha256: createHash('sha256').update(body).digest('hex') };
    let block = false, started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const catalog = await buildAgentSkillCatalog([referenceSkill(skill)], { reload: async () => {
      if (block) { started(); await wait; } return skill;
    } });
    const prepare = createNativeSkillPreparation({ catalog, enabled: true, orchestrator: () => false, report: () => undefined });
    const scope = {}, signal = new AbortController().signal;
    await prepare({ ...request('Use newsletter-campaign'), requestScope: scope, signal });
    block = true;
    const read = createSkillTools(catalog).find(tool => tool.name === 'skill_read')!;
    const pending = read.run({ name: skill.name }, { requestScope: scope, signal, toolCallId: 'pending', emit: () => undefined });
    await entered;
    await prepare({ ...request('Fix the parsing bug'), requestScope: scope, signal });
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.output).toContain('task changed');
    expect(result.output).not.toContain(body);
  });
});
