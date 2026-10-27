import { decodeAgentTeam } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { boardRows } from '../src/office/overlay/boardTree';
import { portraitModel } from '../src/office/overlay/portrait';
import { projectOfficePresence, sessionAgentName, type OfficeAgent } from '../src/office/presence';
import { defaultCharacterAppearance, lookIdentity, lookSeed, nameSeed, resolvedAppearance } from '../src/office/scene/avatars/appearance';
import { addMemberPath, teamForSave, teamFromSpec, teamSpecPreview } from '../src/office/team';

/* v0.0.30 ui: looks generated from full names, names on the board, tree lines, prompt-defined teams. */

const OTP_PROMPT = `Eksekusi fitur OTP Login Endpoint:
Subagent A:
- Name: Elena Mark
- Gender: female
- Role: Backend Engineer
- Model: ag/claude-sonnet-4-6
- Soul: "Pragmatic, clean architect."
- Tugas: Buat route POST /api/auth/otp, controller, validasi request format, dan respon JSON standar.
Subagent B:
- Name: Kaelen Vael
- Gender: male
- Role: Backend Engineer
- Model: ag/claude-opus-4-6-thinking, ag/gemini-4-argon-high
- Soul: "Paranoid security & concurrency engineer."
- Tugas: Audit skema Elena. Tambahkan rate limiter, hash token OTP, transactional lock.
- Batasan: "src/legacy/"`;

describe('looks generated from a full name', () => {
  it('gives the same name the same look and palette, whatever the character id', () => {
    const identity = lookIdentity('Elena Mark', 'female')!;
    expect(identity).toEqual({ seed: nameSeed('Elena Mark'), presentation: 'feminine' });
    expect(nameSeed('  elena   MARK ')).toBe(nameSeed('Elena Mark'));
    const a = resolvedAppearance('s1:primary', undefined, identity);
    const b = resolvedAppearance('s2:member-7', undefined, identity);
    expect(a).toEqual(b);
    expect(a.presentation).toBe('feminine');
    // The 2D portrait (board, popover, team dialog) follows the same seed as the 3D character.
    expect(portraitModel('s1:primary', undefined, identity)).toEqual(portraitModel('team-dialog-id', undefined, identity));
    expect(lookSeed('s1:primary', identity)).toBe(identity.seed);
  });

  it('takes the presentation only from explicit gender metadata', () => {
    expect(lookIdentity('Kaelen Vael', 'male')?.presentation).toBe('masculine');
    const neutral = lookIdentity('Kaelen Vael')!;
    expect(neutral.presentation).toBeUndefined();
    expect(resolvedAppearance('x', undefined, neutral)).toEqual(defaultCharacterAppearance(neutral.seed));
    expect(lookIdentity('Kaelen Vael', 'robot')?.presentation).toBeUndefined();
    expect(lookIdentity('   ')).toBeUndefined();
  });

  it('lets a saved look win and keeps id-seeded looks for unnamed characters', () => {
    const saved = defaultCharacterAppearance('anything', 'masculine');
    expect(resolvedAppearance('s1:primary', saved, lookIdentity('Elena Mark', 'female'))).toBe(saved);
    expect(resolvedAppearance('s1:primary', undefined, undefined)).toEqual(defaultCharacterAppearance('s1:primary'));
  });
});

const session = (patch: Partial<SessionSummary> & Record<string, unknown> = {}): SessionSummary => ({
  id: 's1', workspaceId: 'w1', title: 'OTP login endpoint', control: 'managed', running: false,
  createdAt: '2026-10-16T00:00:00.000Z', lastActiveAt: '2026-10-16T00:00:00.000Z', ...patch,
} as SessionSummary);
const spawned = (subagentId: string, label: string, seq: number): ExtaliaEvent => ({
  id: `e${seq}`, seq, sessionId: 's1', agentId: 'primary', at: '2026-10-16T00:00:01.000Z',
  source: { channel: 'runtime' }, body: { type: 'subagent.spawned', subagentId, role: 'Backend Engineer', label },
} as unknown as ExtaliaEvent);

describe('agents are named by their full names', () => {
  it('names a lead by its agent name and keeps the session title as its task line', () => {
    const [lead] = projectOfficePresence([session({ agentName: 'Mira Solenne', agentGender: 'female' })], []);
    expect(lead).toMatchObject({ displayName: 'Mira Solenne', title: 'OTP login endpoint', look: { seed: nameSeed('Mira Solenne'), presentation: 'feminine' } });
    expect(sessionAgentName(session({ agentName: 'Mira Solenne' }))).toBe('Mira Solenne');
  });

  it('falls back to the session title (and an id-seeded look) without an agent name', () => {
    const [lead] = projectOfficePresence([session()], []);
    expect(lead!.displayName).toBe('OTP login endpoint');
    expect(lead!.title).toBeUndefined();
    expect(lead!.look).toBeUndefined();
    expect(sessionAgentName(session({ title: ' ' }), 'Untitled')).toBe('Untitled');
  });

  it('names and dresses subagents from their team members', () => {
    const teams = new Map([['s1', [{ id: 'm1', name: 'Elena Mark', gender: 'female' }, { id: 'm2', name: 'Kaelen Vael', gender: 'male' }]]]);
    const agents = projectOfficePresence([session({ agentName: 'Mira Solenne', team: { enabled: true, size: 2 } })],
      [spawned('m1', 'Elena Mark', 1), spawned('m2', 'Kaelen Vael', 2)], Date.now(), teams);
    const byName = new Map(agents.map(agent => [agent.displayName, agent]));
    expect(byName.get('Elena Mark')?.look).toEqual({ seed: nameSeed('Elena Mark'), presentation: 'feminine' });
    expect(byName.get('Kaelen Vael')?.look).toEqual({ seed: nameSeed('Kaelen Vael'), presentation: 'masculine' });
    expect(byName.get('Elena Mark')?.parentId).toBe('s1:primary');
  });
});

function agent(id: string, parentId?: string): OfficeAgent {
  return { id, sessionId: 's', agentId: id, displayName: id, control: 'managed', status: 'idle', running: false, ...(parentId ? { parentId } : {}) };
}

describe('board tree lines', () => {
  it('runs a stem from a lead to its subagents with an elbow per child', () => {
    const rows = boardRows([agent('lead'), agent('a', 'lead'), agent('b', 'lead'), agent('other')]);
    expect(rows.map(row => [row.agent.id, row.stem, row.last, row.guides])).toEqual([
      ['lead', true, true, []], ['a', false, false, []], ['b', false, true, []], ['other', false, true, []],
    ]);
  });

  it('carries the parent trunk past a nested branch while the parent has later siblings', () => {
    const rows = boardRows([agent('lead'), agent('a', 'lead'), agent('a1', 'a'), agent('a2', 'a'), agent('b', 'lead'), agent('b1', 'b')]);
    const byId = new Map(rows.map(row => [row.agent.id, row]));
    expect(byId.get('a')).toMatchObject({ depth: 1, last: false, stem: true, guides: [] });
    expect(byId.get('a1')).toMatchObject({ depth: 2, last: false, guides: [true] });
    expect(byId.get('a2')).toMatchObject({ depth: 2, last: true, guides: [true] });
    expect(byId.get('b')).toMatchObject({ depth: 1, last: true, stem: true });
    // The lead's trunk ends at `b`, so nothing passes `b1`.
    expect(byId.get('b1')).toMatchObject({ depth: 2, last: true, guides: [false] });
  });

  it('drops the stem of a collapsed lead', () => {
    const [lead] = boardRows([agent('lead'), agent('a', 'lead')], new Set(['lead']));
    expect(lead).toMatchObject({ stem: false, expanded: false, descendants: 1 });
  });
});

describe('teams written into a prompt', () => {
  it('previews the subagents of the OTP example', () => {
    const preview = teamSpecPreview(OTP_PROMPT)!;
    expect(preview.names).toEqual(['Elena Mark', 'Kaelen Vael']);
    expect(preview.discord).toBe(false);
    expect(preview.spec.members[1]).toMatchObject({ gender: 'male', models: ['ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high'] });
    expect(teamSpecPreview('Fix the login bug, please.')).toBeUndefined();
    expect(teamSpecPreview(`${OTP_PROMPT}\n### ATURAN EKSEKUSI\n- Laporkan progres ke Discord`)?.discord).toBe(true);
  });

  it('turns a spec into a valid team with unique names that the dialog saves with every field', () => {
    let next = 0;
    const result = teamFromSpec(teamSpecPreview(OTP_PROMPT)!.spec, undefined, ['Mira Solenne'], 'w1', () => `m${++next}`);
    if (!('team' in result)) throw new Error(result.error);
    expect(result.team.members.map(member => member.name)).toEqual(['Elena Mark', 'Kaelen Vael']);
    const saved = teamForSave({ ...result.team, goal: result.team.goal ?? '', members: result.team.members.map(member => ({ ...member, access: 'write', scope: ['src/auth'] })) });
    expect(saved.members[0]).toMatchObject({ gender: 'female', access: 'write', scope: ['src/auth'], soul: expect.stringContaining('Pragmatic') });
    expect(decodeAgentTeam(saved).ok).toBe(true);
    // A read-only member keeps its forbidden paths but no edit scope.
    const read = teamForSave({ enabled: true, allowedModels: ['a'], goal: '', members: [{ id: 'r', name: 'Iris Vale', role: 'Reviewer', models: ['a'], access: 'read', scope: ['src'], forbidden: ['infra'] }] });
    expect(read.members[0]).toEqual({ id: 'r', name: 'Iris Vale', role: 'Reviewer', models: ['a'], access: 'read', forbidden: ['infra'] });
  });

  it('accepts only workspace-relative path chips', () => {
    expect(addMemberPath(undefined, './src/auth/')).toEqual({ paths: ['src/auth'] });
    expect(addMemberPath(['src/auth'], 'src/auth')).toEqual({ error: 'duplicate' });
    for (const bad of ['/etc', '~/x', '../up', 'C:\\x']) expect(addMemberPath([], bad)).toEqual({ error: 'invalid' });
  });
});
