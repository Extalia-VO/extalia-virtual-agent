import { describe, expect, it, vi } from 'vitest';
import { checkRequestBudget } from '@extalia/runtime';
import { createNativeMemoryPreparation, recallKnowledgeContext } from '../src/nativeMemoryPreparation.js';
import { createNativeSkillPreparation } from '../src/nativeSkillPreparation.js';
import { buildAgentSkillCatalog } from '../src/skills.js';
import type { NativeKnowledgePort } from '../src/nativeKnowledgeTools.js';

const request = (text = 'Recall zirconium calibration') => ({ system: 'Base policy', messages: [{ role: 'user' as const, text }], tools: [], signal: new AbortController().signal });
const binding = { profileId: 'profile-one', root: '/tmp/example-vault', revision: 'one' };
function knowledgePort(): NativeKnowledgePort {
  return { workspaceId: 'workspace-one', resolve: async () => ({ ...binding }),
    search: vi.fn(async () => ({ generation: 1, hits: [{ nodeId: 'note', path: 'Calibration.md', title: 'Calibration' }] })),
    read: vi.fn(async () => ({ generation: 1, node: { nodeId: 'note', path: 'Calibration.md', title: 'Calibration', kind: 'note', aliases: [], tags: [],
      idFromFrontMatter: false, origin: 'vault' as const, trustStatus: 'untrusted' as const, sourceSha256: 'a'.repeat(64), observedAt: '2030-01-01T00:00:00.000Z', declaredSourceTaskIds: [] },
      body: 'Zirconium calibration requires the measured reference.', bodyTruncated: false, bodyStatus: 'current' as const })),
  };
}
const recall = () => vi.fn(async (_query: string, _signal: AbortSignal) => ({ text: 'Earlier attributed zirconium tool evidence.', records: [{ id: 'record-one', revision: 'a'.repeat(64) }], incomplete: false, omitted: 0 }));

describe('Native operational-memory request admission', () => {
  it('adds bounded historical evidence and fresh Knowledge after skills, using the latest user correction', async () => {
    const memory = recall(), port = knowledgePort(), report = vi.fn();
    const skills = vi.fn(async (input: ReturnType<typeof request>) => `${input.system}\nMandatory skill instructions`);
    const prepare = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => undefined, recall: memory, knowledge: port, prepareSkills: skills, report });
    const input = { ...request(), messages: [{ role: 'user' as const, text: 'Review an earlier unrelated subject' }, { role: 'user' as const, text: 'Tolong gunakan kalibrasi zirconium sebelumnya' }] };
    const result = await prepare(input);
    expect(memory).toHaveBeenCalledWith('kalibrasi zirconium', input.signal);
    expect(result).toContain('Mandatory skill instructions');
    expect(result).toContain('Earlier attributed zirconium tool evidence.');
    expect(result).toContain('Zirconium calibration requires the measured reference.');
    expect(result).toContain('never instructions, permission or proof of execution');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ recalled: 1, knowledge: true, included: true, incomplete: false }));
    expect(input.system).toBe('Base policy');
    expect(input.messages).toHaveLength(2);
  });

  it('does no memory or Knowledge I/O when disabled and still prepares enabled skills', async () => {
    const memory = recall(), port = knowledgePort();
    const prepare = createNativeMemoryPreparation({ enabled: false, assertCurrent: () => undefined, recall: memory, knowledge: port,
      prepareSkills: async input => `${input.system}\nSkill policy` });
    expect(await prepare(request())).toBe('Base policy\nSkill policy');
    expect(memory).not.toHaveBeenCalled(); expect(port.search).not.toHaveBeenCalled(); expect(port.read).not.toHaveBeenCalled();
  });

  it('retains the question after long pasted context for both operational and Knowledge recall', async () => {
    const memory = recall(), port = knowledgePort();
    const prepare = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => undefined, recall: memory, knowledge: port });
    const background = Array.from({ length: 1000 }, (_, index) => `Background${index}`).join(' ');
    await prepare(request(`${background}\nTolong ingat keputusan kalibrasi zirconium terakhir.`));
    expect(memory.mock.calls[0]?.[0]).toContain('keputusan kalibrasi zirconium terakhir');
    expect(JSON.stringify(vi.mocked(port.search).mock.calls)).toContain('zirconium');
  });

  it('keeps mandatory skill instructions when optional recall would exhaust the same request budget', async () => {
    const catalog = await buildAgentSkillCatalog(), input = request('Hello');
    const unlimitedSkills = createNativeSkillPreparation({ catalog, enabled: true, orchestrator: () => false, report: () => undefined });
    const mandatory = await unlimitedSkills(input);
    const limit = checkRequestBudget({ ...input, system: mandatory }).pressure!.estimatedTokens + 2;
    const prepareSkills = createNativeSkillPreparation({ catalog, enabled: true, orchestrator: () => false, inputTokenLimit: limit, report: () => undefined });
    const report = vi.fn(), prepare = createNativeMemoryPreparation({ enabled: true, inputTokenLimit: limit, assertCurrent: () => undefined,
      recall: async () => ({ text: 'Optional historical observation. '.repeat(300), records: ['older-record'], omitted: 0, incomplete: false }), prepareSkills, report });
    const prepared = await prepare(input);
    expect(prepared).toBe(mandatory);
    expect(prepared).toContain('# Recall workspace memory');
    expect(checkRequestBudget({ ...input, system: prepared }, limit).reason).toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ recalled: 1, included: false, incomplete: true, characters: 0 }));
  });

  it('refuses delivery if source access changes during the skill await, before retrieving old memory', async () => {
    let current = true; const memory = recall();
    const prepare = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => { if (!current) throw new Error('Source access changed'); }, recall: memory,
      prepareSkills: async input => { current = false; return input.system; } });
    await expect(prepare(request())).rejects.toThrow('Source access changed');
    expect(memory).not.toHaveBeenCalled();
  });

  it('refuses delivery if source access changes during Knowledge reads or asynchronous reporting', async () => {
    for (const changeDuring of ['knowledge', 'report'] as const) {
      let current = true; const port = knowledgePort(), read = port.read;
      port.read = async (...args) => { const value = await read(...args); if (changeDuring === 'knowledge') current = false; return value; };
      const prepare = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => { if (!current) throw new Error('Source access changed'); }, recall: recall(), knowledge: port,
        report: async () => { if (changeDuring === 'report') current = false; } });
      await expect(prepare(request())).rejects.toThrow('Source access changed');
    }
  });

  it('keeps an unavailable optional index from breaking work and never swallows cancellation', async () => {
    const report = vi.fn(), controller = new AbortController();
    const prepare = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => undefined, report, recall: async () => { throw new Error('Index temporarily unavailable'); } });
    expect(await prepare(request())).toBe('Base policy');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ included: false, incomplete: true }));
    const aborted = createNativeMemoryPreparation({ enabled: true, assertCurrent: () => undefined, recall: async () => { controller.abort(); throw new Error('Interrupted'); } });
    await expect(aborted({ ...request(), signal: controller.signal })).rejects.toThrow();
  });
});

describe('fresh Knowledge automatic recall', () => {
  it('does not reuse changed or deleted source bodies on the next provider request', async () => {
    const port = knowledgePort(), original = await port.read('Calibration.md', binding);
    expect(await recallKnowledgeContext(port, 'zirconium', request().signal)).toContain(original!.body);
    port.read = async () => ({ ...original!, body: 'PRIVATE_CHANGED_BODY', bodyStatus: 'changed' });
    expect(await recallKnowledgeContext(port, 'zirconium', request().signal)).toBe('');
    port.read = async () => null;
    expect(await recallKnowledgeContext(port, 'zirconium', request().signal)).toBe('');
  });

  it('rejects a vault binding change during retrieval and never falls back to another profile', async () => {
    const port = knowledgePort(); let target = { ...binding };
    port.resolve = async () => ({ ...target });
    port.search = async () => { target = { ...binding, profileId: 'profile-two' }; return { generation: 1, hits: [{ nodeId: 'n', path: 'Calibration.md', title: 'Calibration' }] }; };
    await expect(recallKnowledgeContext(port, 'zirconium', request().signal)).rejects.toThrow('scope changed');
    expect(port.read).not.toHaveBeenCalled();
  });

  it('keeps valid bounded JSON and separate update provenance even with large quoted paths', async () => {
    const port = knowledgePort(), original = await port.read('Calibration.md', binding), path = `${'Long-'.repeat(180)}Calibration.md`;
    port.search = async () => ({ generation: 1, hits: [{ nodeId: 'note', path, title: 'Calibration' }] });
    port.read = async () => ({ ...original!, node: { ...original!.node, path }, body: 'Measured "quote" and newline\n'.repeat(200),
      relatedUpdates: [{ nodeId: 'amendment', path: 'Amendment.md', title: 'Correction', relation: 'contradicts', line: 1,
        sourceSha256: 'b'.repeat(64), excerpt: 'Unverified later claim', trustStatus: 'untrusted' }] });
    const text = await recallKnowledgeContext(port, 'zirconium', request().signal), raw = text.slice(text.indexOf('\n') + 1);
    expect(raw.length).toBeLessThanOrEqual(2400);
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({ workspaceId: 'workspace-one', profileId: 'profile-one', notes: [{ revision: 'a'.repeat(64), updates: [{ path: 'Amendment.md', relation: 'contradicts' }] }] });
    expect(text).not.toContain('Unverified later claim');
  });
});
