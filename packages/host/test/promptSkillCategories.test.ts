import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '@extalia/runtime';
import { buildAgentSkillCatalog, createSkillTools, selectPromptSkillCategories } from '../src/skills.js';
import { runTool } from './helpers.js';

describe('deterministic prompt skill categories', () => {
  it.each([
    ['Fix auth bug and add tests', ['development', 'quality', 'security']],
    ['Tolong jelaskan arsitektur dan rencana pengujian keamanan', ['quality', 'documentation', 'planning', 'security']],
    ['Release docs and commit', ['documentation', 'delivery']],
    ['Hello there', []],
  ])('selects bounded category hints for %s', (prompt, expected) => {
    expect(selectPromptSkillCategories(prompt)).toEqual(expected);
  });

  it('normalizes case and punctuation without interpreting embedded procedures or scanning unbounded text', () => {
    expect(selectPromptSkillCategories('DEBUG!\nTESTS; DOKUMENTASI')).toEqual(['development', 'quality', 'documentation']);
    expect(selectPromptSkillCategories('hello '.repeat(400) + 'security')).toEqual([]);
  });

  it('keeps an unrelated initial preview empty and full canonical discovery available on demand', async () => {
    const catalog = await buildAgentSkillCatalog([], { prompt: 'Hello there', relevantOnly: true });
    expect(catalog.skills).toEqual([]);
    expect(catalog.categories).toEqual([]);
    expect(catalog.omitted).toBeGreaterThan(0);
    expect(catalog.incomplete).toBe(true);
    const tools = createSkillTools(catalog);
    expect((await runTool(tools, 'skill_search', { query: 'orchestrator' })).output).toContain('orchestrator');
    expect((await runTool(tools, 'skill_read', { name: 'orchestrator' })).output).toContain('A disabled team stays solo');
  });

  it('previews only bounded fitting metadata without bodies, activation or external inventory authority', async () => {
    const catalog = await buildAgentSkillCatalog([{ name: 'unverified', description: 'Security audit', source: 'user', body: 'Unverified instructions' }], {
      prompt: 'Review security tests', relevantOnly: true,
    });
    expect(catalog.categories).toEqual(['quality', 'security']);
    expect(catalog.skills.length).toBeLessThanOrEqual(4);
    expect(catalog.skills.map(skill => skill.name)).toContain('security-review');
    expect(catalog.skills.map(skill => skill.name)).not.toContain('unverified');
    const system = buildSystemPrompt({ workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' },
      skills: catalog.skills.map(({ name, description }) => ({ name, description })), skillCategories: catalog.categories });
    expect(system).toContain('Host category hints: quality, security.');
    expect(system).not.toContain('# Security review');
    const discovery = JSON.parse((await runTool(createSkillTools(catalog), 'skill_search', { query: 'plan' })).output);
    expect(discovery.skills.some((skill: { name: string }) => skill.name === 'plan-feature')).toBe(true);
  });
});
