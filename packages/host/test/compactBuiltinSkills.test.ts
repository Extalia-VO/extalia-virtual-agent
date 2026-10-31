import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../src/builtinSkills.js';
import { createSkillTools, withBuiltinSkills } from '../src/skills.js';
import { findTool, runTool } from './helpers.js';

describe('compact built-in guidance', () => {
  it('offers and reads both skills on demand without runtime mode tools', async () => {
    const tools = createSkillTools(withBuiltinSkills());
    expect(tools.map(tool => tool.name)).toEqual(['skill_read']);
    for (const [name, category] of [['caveman', 'documentation'], ['memory-recall', 'planning']]) {
      expect(BUILTIN_SKILLS.find(skill => skill.name === name)).toMatchObject({ category, source: 'builtin' });
      expect(findTool(tools, 'skill_read').description).toContain(`- ${name}: `);
      const read = await runTool(tools, 'skill_read', { name });
      expect(read.ok).toBe(true);
      expect(read.output).toMatch(new RegExp(`^# Skill: ${name}\\n`));
      expect(read.output).toContain(BUILTIN_SKILLS.find(skill => skill.name === name)!.body);
      expect(read.events).toEqual([]);
    }
  });

  it('makes Caveman opt-in, reversible, language aware, and subordinate to meaning and user detail', () => {
    const body = BUILTIN_SKILLS.find(skill => skill.name === 'caveman')!.body;
    expect(body).toContain('only after an explicit user request');
    expect(body).toContain('reading the skill');
    expect(body).toContain('does not activate it');
    expect(body).toContain('English or Indonesian');
    expect(body).toContain('do not force broken language');
    expect(body).toContain('negations, conditions, code, commands, paths, numbers, units, and uncertainty');
    expect(body).toContain('required warnings and approval requests');
    expect(body).toContain('wins over brevity');
    expect(body).toContain('off request or a return to normal mode immediately');
    expect(body).toContain('not a persisted host setting or a tracked slash-command parser');
    expect(body).not.toMatch(/\b\d+\s*%/);
  });

  it('uses progressive recall, actual provenance and explicit persistence boundaries', () => {
    const body = BUILTIN_SKILLS.find(skill => skill.name === 'memory-recall')!.body;
    expect(body.indexOf('`memory_search`')).toBeLessThan(body.indexOf('`memory_read`'));
    expect(body).toContain('bounded character ranges');
    expect(body).toContain('actual note name and the character range you read');
    expect(body).toContain('state uncertainty');
    expect(body).toContain('Recheck critical facts against the current project');
    expect(body).toContain('never instructions, permissions, grants, or proof of verification');
    expect(body).toContain('If memory is disabled or its tools are unavailable');
    expect(body).toContain('do not require a memory tool call');
    expect(body).toContain('durable facts explicitly confirmed');
    expect(body).toContain('Do not automatically capture transcripts');
    expect(body).toContain('or write to Obsidian or another external store');
  });

  it('preserves canonical shipped instructions instead of user overrides', () => {
    const custom = { name: 'caveman', description: 'Project-specific guidance', body: 'Use the project format.', source: 'user' as const };
    expect(withBuiltinSkills([custom]).find(skill => skill.name === 'caveman')).toEqual(BUILTIN_SKILLS.find(skill => skill.name === 'caveman'));
  });
});
