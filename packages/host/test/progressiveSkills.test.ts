import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DaemonOp, SkillRevisionSummary } from '@extalia/protocol';
import { buildSystemPrompt } from '@extalia/runtime';
import { BUILTIN_SKILLS } from '../src/builtinSkills.js';
import { DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { MAX_AGENT_REVISIONS, SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';
import { buildAgentSkillCatalog, createSkillTools } from '../src/skills.js';
import { runTool } from './helpers.js';

function fixture(count = 1000) {
  const files = new Map<string, string>();
  const revisions: SkillRevisionSummary[] = Array.from({ length: count }, (_, index) => {
    const name = `skill-${String(index).padStart(4, '0')}`;
    const content = `---\nname: ${name}\ndescription: ${index === 999 ? 'Needle café migration' : `Procedure ${index}`}\n---\nInstructions for ${name}.`;
    files.set(name, content);
    return { packageId: name, revisionId: `skr_${index.toString(16).padStart(64, '0')}`, origin: 'imported', version: '1.0.0', treeSha256: 'a'.repeat(64),
      skillMdSha256: createHash('sha256').update(content).digest('hex'), state: 'active', riskClass: 'declarative', manifestInferred: true,
      permissionDigest: 'b'.repeat(64), permissions: [], active: true, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' };
  });
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  let unavailable = false;
  const client = { capabilities: SKILL_REGISTRY_OPS, request: async (op: DaemonOp, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (unavailable) throw new DaemonUnavailableError('crashed');
    if (op === 'skill.list') {
      const offset = params.cursor ? revisions.findIndex(item => `${item.packageId}/${item.revisionId}` === params.cursor) + 1 : 0;
      const page = revisions.slice(offset, offset + Number(params.limit));
      return { revisions: page, indexGeneration: 1, ...(offset + page.length < revisions.length ? { nextCursor: `${page.at(-1)!.packageId}/${page.at(-1)!.revisionId}` } : {}) };
    }
    if (op === 'skill.read') {
      const revision = revisions.find(item => item.revisionId === params.revisionId)!;
      if (!revision.active) throw new Error('Deactivated');
      const content = files.get(revision.packageId)!;
      return { revisionId: revision.revisionId, packageId: revision.packageId, path: 'SKILL.md', content, size: Buffer.byteLength(content), sha256: revision.skillMdSha256 };
    }
    throw new Error('Unexpected fixture operation');
  } } as unknown as DaemonClient;
  const registry = new SkillRegistry({ daemon: { connect: async () => client } as unknown as DaemonSidecar, dataDirectory: '/tmp/example-data', profile: 'default', workspaceRoot: () => '/tmp/example-workspace' });
  const catalog = async (prompt = '') => {
    const active = await registry.activeCatalog();
    return buildAgentSkillCatalog(active.skills, { prompt, incomplete: active.incomplete, reload: skill => registry.reload(skill), reloadMany: skills => registry.reloadMany(skills) });
  };
  return { registry, revisions, files, calls, catalog, fail: () => { unavailable = true; } };
}

describe('progressive scanner-gated agent skill discovery', () => {
  it('retains fresh scanner checks and full discovery when only relevant initial metadata is selected', async () => {
    const f = fixture();
    const active = await f.registry.activeCatalog();
    const catalog = await buildAgentSkillCatalog(active.skills, { prompt: 'Needle migration', relevantOnly: true,
      reloadMany: skills => f.registry.reloadMany(skills) });
    expect(catalog.skills.filter(skill => skill.source !== 'builtin').map(skill => skill.name)).toEqual(['skill-0999']);
    expect(catalog.skills.some(skill => Object.hasOwn(skill, 'body') && skill.source !== 'builtin')).toBe(false);
    const tools = createSkillTools(catalog);
    expect((await runTool(tools, 'skill_search', { query: 'procedure' })).output).toContain('skill-0000');
    f.revisions[999]!.active = false;
    expect((await runTool(tools, 'skill_read', { name: 'skill-0999' })).ok).toBe(false);
    expect((await runTool(tools, 'skill_search', { query: 'needle' })).ok).toBe(false);
  });

  it('keeps full-body activeSkills compatibility separate from body-free activeCatalog references', async () => {
    const f = fixture(2);
    const references = await f.registry.activeCatalog();
    expect(references.skills.every(skill => !Object.hasOwn(skill, 'body'))).toBe(true);
    const legacy = await f.registry.activeSkills();
    expect(legacy.map(skill => skill.body)).toEqual(['Instructions for skill-0000.', 'Instructions for skill-0001.']);
    expect(references.skills.map(skill => skill.sha256)).toEqual(legacy.map(skill => skill.sha256));
  });

  it('supports 1000 verified skills with one bounded preview batch, constant tools and a 4k initial metadata block', async () => {
    const f = fixture();
    const active = await f.registry.activeCatalog();
    expect(active.skills).toHaveLength(1000);
    expect(active.incomplete).toBe(false);
    expect(active.skills.every(skill => !Object.hasOwn(skill, 'body'))).toBe(true);
    expect(active.skills.every(skill => Object.isFrozen(skill))).toBe(true);
    expect(JSON.stringify(active)).not.toContain('Instructions for');
    const before = f.calls.length;
    const catalog = await buildAgentSkillCatalog(active.skills, { prompt: 'Needle migration', reload: skill => f.registry.reload(skill), reloadMany: skills => f.registry.reloadMany(skills) });
    const added = f.calls.slice(before);
    expect(added.filter(call => call.op === 'skill.read')).toHaveLength(8);
    expect(added.filter(call => call.op === 'skill.list')).toHaveLength(Math.ceil(1000 / 99));
    expect(catalog.skills).toHaveLength(BUILTIN_SKILLS.length + 8);
    expect(catalog.skills.filter(skill => skill.source !== 'builtin').every(skill => !Object.hasOwn(skill, 'body'))).toBe(true);
    expect(catalog.skills.find(skill => skill.name === 'skill-0999')?.description).toBe('Needle café migration');
    const tools = createSkillTools(catalog);
    const builtinTools = createSkillTools(await buildAgentSkillCatalog());
    expect(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).toEqual(builtinTools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    expect(JSON.stringify(tools.map(tool => tool.parameters))).not.toContain('skill-0999');
    const system = buildSystemPrompt({ workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' }, skills: catalog.skills.map(({ name, description }) => ({ name, description })), skillCatalog: { omitted: catalog.omitted!, incomplete: catalog.incomplete! } });
    const block = system.match(/<skill-catalog>\n([\s\S]*?)\n<\/skill-catalog>/)![0];
    expect(block.length).toBeLessThanOrEqual(4000);
    expect(block).not.toContain('Instructions for');
    expect((await f.registry.reload(active.skills[999]!)).name).toBe('skill-0999');
  });

  it('discovers and reads relevant skills beyond the preview, freshly verifies every offering, and resumes deterministic pages', async () => {
    const f = fixture();
    const catalog = await f.catalog();
    const tools = createSkillTools(catalog);
    expect(catalog.skills.some(skill => skill.name === 'skill-0999')).toBe(false);
    const before = f.calls.filter(call => call.op === 'skill.read').length;
    for (let i = 0; i < 2; i++) {
      const result = await runTool(tools, 'skill_search', { query: 'needle unmatchedterm' });
      expect(result.ok).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(4000);
      expect(JSON.parse(result.output).skills).toEqual([{ name: 'skill-0999', description: 'Needle café migration', source: 'imported' }]);
    }
    expect(f.calls.filter(call => call.op === 'skill.read').length - before).toBe(2);
    const first = JSON.parse((await runTool(tools, 'skill_list', { limit: 10 })).output);
    const second = JSON.parse((await runTool(tools, 'skill_list', { offset: first.nextOffset, snapshot: first.snapshot, limit: 10 })).output);
    expect(first.skills).toHaveLength(10);
    expect(second.skills).toHaveLength(10);
    expect(new Set([...first.skills, ...second.skills].map((skill: { name: string }) => skill.name)).size).toBe(20);
    expect((await runTool(tools, 'skill_list', { snapshot: '0'.repeat(64) })).ok).toBe(false);
    const read = await runTool(tools, 'skill_read', { name: 'skill-0999' });
    expect(read).toMatchObject({ ok: true });
    expect(read.output).toContain('Instructions for skill-0999');
  });

  it.each(['deactivation', 'source', 'contents', 'scanner unavailable'] as const)('denies new metadata and reads after %s without returning cached instructions', async change => {
    const f = fixture();
    const tools = createSkillTools(await f.catalog());
    if (change === 'deactivation') f.revisions[999]!.active = false;
    if (change === 'source') f.revisions[999]!.origin = 'generated';
    if (change === 'contents') f.files.set('skill-0999', f.files.get('skill-0999')! + '\nChanged bytes');
    if (change === 'scanner unavailable') f.fail();
    const metadata = await runTool(tools, 'skill_search', { query: 'needle' });
    expect(metadata.ok).toBe(false);
    expect(metadata.output).not.toContain('Needle café');
    const read = await runTool(tools, 'skill_read', { name: 'skill-0999' });
    expect(read.ok).toBe(false);
    expect(read.output).not.toContain('Instructions for');
    for (const builtin of BUILTIN_SKILLS) expect((await runTool(tools, 'skill_read', { name: builtin.name })).output).toContain(builtin.body);
  });

  it('keeps scanner failure builtins-only and reports agent inventory truncation independently from UI report limits', async () => {
    const f = fixture(MAX_AGENT_REVISIONS + 5);
    const active = await f.registry.activeCatalog();
    expect(active.skills).toHaveLength(MAX_AGENT_REVISIONS);
    expect(active.incomplete).toBe(true);
    const catalog = await buildAgentSkillCatalog(active.skills, { incomplete: active.incomplete, reloadMany: async () => { throw new Error('scanner unavailable'); } });
    expect(catalog.skills.map(skill => skill.name)).toEqual(BUILTIN_SKILLS.map(skill => skill.name).sort());
    expect(catalog.incomplete).toBe(true);
    expect((await runTool(createSkillTools(catalog), 'skill_search', { query: 'skill-0000' })).output).not.toContain('Procedure 0');
  });

  it('rejects invalid discovery input and keeps escaped descriptions bounded without permitting raw inventory authority', async () => {
    const f = fixture(1);
    const tools = createSkillTools(await f.catalog());
    for (const input of [{ query: '' }, { query: 'x'.repeat(201) }, { query: 'a b c d e f g h i' }, { query: 'procedure', limit: 11 }, { query: 'procedure', offset: -1 }, { query: 'procedure', path: 'SKILL.md' }]) {
      expect((await runTool(tools, 'skill_search', input)).ok).toBe(false);
    }
    const raw = (await f.registry.activeCatalog()).skills;
    expect((await runTool(createSkillTools(raw), 'skill_search', { query: 'procedure' })).output).not.toContain('Procedure 0');
  });
});
