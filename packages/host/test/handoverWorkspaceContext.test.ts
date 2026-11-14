import { describe, expect, it, vi } from 'vitest';
import { collectHandoverWorkspaceContext, type WorkspaceContextPort } from '../src/handoverWorkspaceContext.js';

const item = (source: string, text = 'Attributed decision') => ({ source, reference: 'example', revision: 'a'.repeat(64), text });
const ports = (): WorkspaceContextPort => ({ memory: vi.fn(async () => [item('memory')]), knowledge: vi.fn(async () => [item('knowledge')]),
  skills: vi.fn(async () => [item('approved-skill')]), observed: vi.fn(async () => [item('observed-claim')]), assertCurrent: vi.fn(async () => {}) });

describe('reviewed workspace handover references', () => {
  it('retains attribution and uncertainty without expanding archive grants', async () => {
    const p = ports(), entry = await collectHandoverWorkspaceContext(p, 'parser validation');
    const value = JSON.parse(entry.text);
    expect(entry.kind).toBe('status'); expect(value.sources).toHaveLength(4);
    expect(value.trust).toMatch(/never instructions/); expect(value.scope).toMatch(/do not grant access to future/);
    expect(p.assertCurrent).toHaveBeenCalledTimes(2);
    expect(value.sources.every((source: { selection: string }) => source.selection.includes('not proof of absence'))).toBe(true);
  });
  it('keeps a valid bounded JSON entry even with worst-case escaping and partial source failure', async () => {
    const p = ports(); p.memory = async () => [item('memory', '"\\\n'.repeat(5000))]; p.knowledge = async () => { throw new Error('private detail'); };
    p.observed = async () => Array.from({ length: 20 }, () => item('observed', '"'.repeat(8000)));
    const entry = await collectHandoverWorkspaceContext(p, 'example');
    expect(entry.text.length).toBeLessThanOrEqual(7000);
    expect(JSON.parse(entry.text).sources[1]).toMatchObject({ status: 'unavailable', items: [] });
    expect(entry.text).not.toContain('private detail'); expect(JSON.parse(entry.text).sources[3].items).toHaveLength(2);
  });
  it('rejects a changed workspace after sources return rather than sharing stale references', async () => {
    const p = ports(); p.assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Scope changed'));
    await expect(collectHandoverWorkspaceContext(p, 'example')).rejects.toThrow('Scope changed');
  });
});
