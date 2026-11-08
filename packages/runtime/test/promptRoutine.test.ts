import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, runTurn, type ModelMessage, type ModelProvider, type ModelRequest } from '../src/index.js';

const plain = { workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' } };

describe('bounded per-prompt routine', () => {
  it('keeps core guidance independent of feature catalogs and conditionally offers retrieval', () => {
    const solo = buildSystemPrompt({ ...plain, teamState: 'none' });
    expect(solo).toContain('compact internal brief');
    expect(solo).toContain('never rewrite, truncate or replace');
    expect(solo).toContain('Handle this request yourself');
    expect(solo).not.toContain('skill_read');
    expect(solo).not.toContain('memory_search');
    const enabled = buildSystemPrompt({ ...plain, skills: [], skillCategories: ['quality', 'quality', 'invalid\npermission'], memory: [] });
    expect(enabled).toContain('Host category hints: quality.');
    expect(enabled).not.toContain('invalid\npermission');
    expect(enabled).toContain('skill_search');
    expect(enabled).toContain('do not load every skill');
    expect(enabled).toContain('memory_search');
    expect(enabled).toContain('skip unrelated notes');
    expect(enabled).toContain('"skills":[]');
  });

  it('honors explicit disabled and absent saved teams over generic preferences and stale roster metadata', () => {
    for (const teamState of ['none', 'disabled'] as const) {
      const system = buildSystemPrompt({ ...plain, teamState, orchestration: { maxDelegations: 4 },
        ...(teamState === 'disabled' ? { team: { members: [{ name: 'Example reviewer', role: 'Reviewer' }] } } : {}) });
      expect(system).not.toContain('You can delegate with');
      expect(system).not.toContain('You lead a team');
      if (teamState === 'disabled') expect(system).toContain('do not bypass this toggle with generic delegation');
    }
  });

  it('routes active fitting work by actual saved capabilities while preserving small-task solo handling', () => {
    const system = buildSystemPrompt({ ...plain, teamState: 'active', orchestration: { maxDelegations: 4 }, team: {
      members: [{ name: 'Example reviewer', role: 'Reviewer', access: 'read', scope: ['src'] }],
    } });
    expect(system).toContain('You lead a team');
    expect(system).toContain('request actually concerns a member');
    expect(system).toContain('handle small, quick or unrelated requests');
    expect(system).toContain('saved connection/model grants and authorized workspace scope');
    expect(system).not.toContain('You can delegate with');
  });

  it('passes the exact full user text and history to the provider without an extra classification call', async () => {
    const prompt = 'Jangan hapus constraints.  Keep all spaces.\n```ts\nconst value = "a  b";\n```\nDo NOT change /src/file.ts; limit 42.\n' + 'Complete detail. '.repeat(1000);
    const history: ModelMessage[] = [{ role: 'user', text: 'Earlier  instruction\nunchanged.' }, { role: 'assistant', text: 'Recorded  exactly.', toolCalls: [] }];
    const seen: ModelRequest[] = [];
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
      seen.push({ ...request, messages: [...request.messages] });
      return { text: 'Done.', toolCalls: [], stop: 'end' };
    } };
    await runTurn({ provider, system: buildSystemPrompt({ ...plain, teamState: 'none' }), history, prompt, tools: [],
      permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), requestApproval: async () => 'reject', emit: () => undefined,
      signal: new AbortController().signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages).toEqual([...history, { role: 'user', text: prompt }]);
    expect(history).toEqual([{ role: 'user', text: 'Earlier  instruction\nunchanged.' }, { role: 'assistant', text: 'Recorded  exactly.', toolCalls: [] }]);
  });
});
