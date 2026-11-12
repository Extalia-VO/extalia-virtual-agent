import { describe, expect, it } from 'vitest';
import type { SkillLoadReport } from '@extalia/protocol';
import type { ModelMessage } from '@extalia/runtime';
import { createHash } from 'node:crypto';
import { createNativeSkillPreparation } from '../src/nativeSkillPreparation.js';
import { buildAgentSkillCatalog, referenceSkill, type Skill } from '../src/skills.js';

const request = (text: string) => ({ system: 'base policy', messages: [{ role: 'user' as const, text }], tools: [], signal: new AbortController().signal });

describe('per-request Native skill preparation', () => {
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
});
