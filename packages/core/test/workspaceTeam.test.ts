import { describe, expect, it } from 'vitest';
import { decodeWorkspace, initialSessionTeam, withDistinctMemberNames, type AgentTeam } from '../src/index.js';

const TEAM: AgentTeam = {
  enabled: true, allowedModels: ['model-a'],
  members: [
    { id: 'm-1', name: 'Elena Vael', gender: 'female', role: 'Researcher', models: ['model-a'] },
    { id: 'm-2', name: 'Theo Mark', gender: 'male', role: 'Reviewer', models: ['model-a'] },
  ],
};
const base = { id: 'w1', profileId: 'p1', name: 'Site', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('v0.0.47 workspace default team', () => {
  it('decodes a workspace team for Extalia Native and Hermes Agent workspaces', () => {
    const native = decodeWorkspace({ ...base, providerProfileId: 'c1', team: TEAM });
    expect(native.ok && native.value.team).toEqual(TEAM);
    const hermes = decodeWorkspace({ ...base, runtimeId: 'hermes', runtimeProfileId: 'work', team: { ...TEAM, allowedModels: [], members: TEAM.members.map(member => ({ ...member, models: [] })) } });
    expect(hermes.ok && hermes.value.team?.members).toHaveLength(2);
    expect(decodeWorkspace({ ...base }).ok && 'team' in (decodeWorkspace(base) as { value: object }).value).toBe(false);
  });

  it('drops a damaged team but keeps the workspace', () => {
    const decoded = decodeWorkspace({ ...base, team: { enabled: 'yes', members: [] } });
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.value.team).toBeUndefined();
    expect(decodeWorkspace({ ...base, team: { ...TEAM, members: [{ ...TEAM.members[0], models: ['not-allowed'] }] } }).ok).toBe(true);
  });

  it('inherits: an explicit team wins, null disables, otherwise an independent copy of the default', () => {
    const explicit: AgentTeam = { ...TEAM, members: [TEAM.members[1]!] };
    expect(initialSessionTeam(TEAM, explicit)).toEqual(explicit);
    expect(initialSessionTeam(TEAM, null)).toBeUndefined();
    expect(initialSessionTeam(undefined, undefined)).toBeUndefined();
    const copy = initialSessionTeam(TEAM, undefined)!;
    expect(copy).toEqual(TEAM);
    copy.members[0]!.name = 'Changed';
    copy.allowedModels.push('model-b');
    expect(TEAM.members[0]!.name).toBe('Elena Vael');
    expect(TEAM.allowedModels).toEqual(['model-a']);
    // A disabled default is copied as it is (and then not applied by the runtimes).
    expect(initialSessionTeam({ ...TEAM, enabled: false }, undefined)?.enabled).toBe(false);
  });

  it('renames only members whose names the Office already uses, keeping ids, roles and gender', () => {
    const taken = new Set(['elena vael', 'lead person']);
    const result = withDistinctMemberNames(TEAM, taken, 's1');
    expect(result.members[0]).toMatchObject({ id: 'm-1', role: 'Researcher', gender: 'female' });
    expect(result.members[0]!.name).not.toBe('Elena Vael');
    expect(result.members[1]!.name).toBe('Theo Mark');
    expect(taken.has('theo mark')).toBe(true);
    expect(taken.has(result.members[0]!.name.toLowerCase())).toBe(true);
    expect(withDistinctMemberNames(TEAM, new Set(), 's1')).toEqual(TEAM);
  });
});
