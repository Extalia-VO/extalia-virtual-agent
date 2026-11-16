import { PROTOCOL_VERSION, type EventBody, type ExtaliaEvent, type SkillLoadReport } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { projectActivity, projectTranscript, type SkillLoadItem, type WorkerItem } from '../src/chat/transcript';

const receipt = (): SkillLoadReport => ({ skills: [
  { name: 'memory-recall', source: 'builtin', reason: 'default-memory', status: 'loaded', characters: 800 },
  { name: 'orchestrator', source: 'builtin', reason: 'configured-team', status: 'not-configured', characters: 0 },
], characters: 1000, budgetCharacters: 24_000 });

function fixture() {
  let index = 0;
  return (body: EventBody, agentId = 'primary'): ExtaliaEvent => ({
    v: PROTOCOL_VERSION, id: `event-${++index}`, sessionId: 'example-session', agentId,
    source: { runtime: 'native', channel: 'system' }, at: '2026-11-11T00:00:00.000Z', body,
  });
}

describe('skill loading transcript receipts', () => {
  it('keeps a host receipt between the prompt and answer without creating a tool call', () => {
    const event = fixture();
    const report = receipt();
    const before = JSON.stringify(report);
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'Review the change', via: 'extalia' }),
      event({ type: 'skills.loaded', ...report }),
      event({ type: 'model.completed', text: 'Review finished' }),
    ]);
    expect(items.map(item => item.kind)).toEqual(['user', 'skills', 'assistant']);
    const skills = items[1] as SkillLoadItem;
    expect(skills).toMatchObject({ owner: 'primary', characters: 1000, budgetCharacters: 24_000 });
    expect(skills.skills).toEqual(report.skills);
    expect(skills.skills).not.toBe(report.skills);
    expect(skills.skills[0]).not.toBe(report.skills[0]);
    expect(JSON.stringify(report)).toBe(before);
    expect(items.some(item => item.kind === 'tool')).toBe(false);
  });

  it('deduplicates event ids while preserving distinct updates and subsequent turns', () => {
    const event = fixture();
    const first = event({ type: 'skills.loaded', ...receipt() });
    const changed = receipt();
    changed.skills[0]!.status = 'budget'; changed.skills[0]!.characters = 0; changed.characters = 0;
    const second = event({ type: 'skills.loaded', ...changed });
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'First', via: 'extalia' }), first, { ...first, body: { type: 'skills.loaded', ...changed } },
      event({ type: 'user.intervention', action: 'steer', text: 'Change direction' }), second,
      event({ type: 'turn.completed' }), event({ type: 'prompt.submitted', text: 'Next', via: 'extalia' }),
      event({ type: 'skills.loaded', ...receipt() }),
    ]);
    const reports = items.filter((item): item is SkillLoadItem => item.kind === 'skills');
    expect(reports).toHaveLength(3);
    expect(reports.map(item => item.skills[0]!.status)).toEqual(['loaded', 'budget', 'loaded']);
    expect(reports.map(item => item.id)).toEqual([first.id, second.id, reports[2]!.id]);
  });

  it('attributes worker preparation to the known worker without counting it as a tool or lead activity', () => {
    const event = fixture();
    const prompt = event({ type: 'prompt.submitted', text: 'Review', via: 'extalia' });
    const spawned = event({ type: 'subagent.spawned', subagentId: 'reviewer', role: 'review', label: 'Reviewer' });
    const loaded = event({ type: 'skills.loaded', ...receipt() }, 'reviewer');
    const items = projectTranscript([prompt, spawned, loaded]);
    expect(items.map(item => item.kind)).toEqual(['user', 'worker', 'skills']);
    expect(items[2]).toMatchObject({ owner: 'worker', agentId: 'reviewer', agentLabel: 'Reviewer' });
    expect((items[1] as WorkerItem).toolCalls).toBe(0);
    expect(projectActivity([prompt, spawned, loaded])).toEqual(projectActivity([prompt, spawned]));
  });

  it('does not call an unknown agent the primary agent', () => {
    const event = fixture();
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'Review', via: 'extalia' }),
      event({ type: 'skills.loaded', ...receipt() }, 'unknown-worker'),
    ]);
    expect(items[1]).toMatchObject({ owner: 'agent', agentId: 'unknown-worker' });
    expect(items[1]).not.toHaveProperty('agentLabel');
  });

  it('preserves a bounded omitted-candidate count without fabricating additional skill rows', () => {
    const event = fixture();
    const report = { ...receipt(), omitted: 7 };
    const [item] = projectTranscript([event({ type: 'skills.loaded', ...report })]);
    expect(item).toMatchObject({ kind: 'skills', omitted: 7, skills: report.skills });
    expect((item as SkillLoadItem).skills).toHaveLength(2);
    const [without] = projectTranscript([event({ type: 'skills.loaded', ...receipt() })]);
    expect(without).not.toHaveProperty('omitted');
  });
});
