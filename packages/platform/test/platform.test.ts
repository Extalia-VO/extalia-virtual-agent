import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, describeCapabilities, isAgentHostMethod, legacyDataDirectories, normalizeAgentIdentity, normalizeAgentTeam, normalizeBuiltinSkills, normalizeSessionOptions, normalizeSkillConsent, normalizeSkillNames, normalizeTeamPlanRequest, resolveDataDirectory, type Platform,
} from '../src/index.js';

describe('resolveDataDirectory', () => {
  it('uses ~/.extalia-vo on every platform', () => {
    expect(resolveDataDirectory({ platform: 'darwin', env: {}, homeDirectory: '/home/someone' })).toBe('/home/someone/.extalia-vo');
    expect(resolveDataDirectory({ platform: 'win32', env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, homeDirectory: 'C:\\Users\\someone' })).toBe('C:\\Users\\someone\\.extalia-vo');
    expect(resolveDataDirectory({ platform: 'linux', env: {}, homeDirectory: '/home/someone/' })).toBe('/home/someone/.extalia-vo');
    expect(resolveDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homeDirectory: '/home/someone' })).toBe('/home/someone/.extalia-vo');
    expect(resolveDataDirectory({ platform: 'linux', env: {}, homeDirectory: '/' })).toBe('/.extalia-vo');
  });

  it('honors the explicit override', () => {
    expect(resolveDataDirectory({ platform: 'darwin', env: { EXTALIA_HOME: '/tmp/extalia-test' }, homeDirectory: '/home/someone' })).toBe('/tmp/extalia-test');
    expect(resolveDataDirectory({ platform: 'win32', env: { EXTALIA_HOME: '  D:\\extalia  ' }, homeDirectory: 'C:\\Users\\someone' })).toBe('D:\\extalia');
  });
});

describe('legacyDataDirectories', () => {
  it('lists the application-data folders used before 0.0.21', () => {
    expect(legacyDataDirectories({ platform: 'darwin', env: {}, homeDirectory: '/home/someone' })).toEqual(['/home/someone/Library/Application Support/Extalia']);
    expect(legacyDataDirectories({ platform: 'win32', env: { APPDATA: 'D:\\Roaming' }, homeDirectory: 'C:\\Users\\someone' })).toEqual(['D:\\Roaming\\Extalia', 'C:\\Users\\someone\\AppData\\Roaming\\Extalia']);
    expect(legacyDataDirectories({ platform: 'win32', env: {}, homeDirectory: 'C:\\Users\\someone' })).toEqual(['C:\\Users\\someone\\AppData\\Roaming\\Extalia']);
    expect(legacyDataDirectories({ platform: 'linux', env: {}, homeDirectory: '/home/someone' })).toEqual(['/home/someone/.local/share/extalia']);
    expect(legacyDataDirectories({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homeDirectory: '/home/someone' })).toEqual(['/data/extalia', '/home/someone/.local/share/extalia']);
    expect(legacyDataDirectories({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, homeDirectory: '/home/someone' })).toEqual(['/home/someone/.local/share/extalia']);
  });
});

describe('describeCapabilities', () => {
  it('marks native capabilities as bridge-reachable on the web and unavailable elsewhere', () => {
    const web: Platform = { info: { kind: 'web', appVersion: '0.0.0' }, capabilities: { filesystem: { selectDirectory: async () => null } } };
    const desktop: Platform = { info: { kind: 'desktop', appVersion: '0.0.0' }, capabilities: {} };
    const webStatus = Object.fromEntries(describeCapabilities(web).map(entry => [entry.id, entry.status]));
    expect(webStatus).toMatchObject({ filesystem: 'available', terminal: 'requires-bridge', git: 'requires-bridge', updater: 'unavailable' });
    expect(describeCapabilities(desktop).every(entry => entry.status === 'unavailable')).toBe(true);
  });
  it('recognizes host-owned commands, Git inspection and credentials without claiming standalone APIs', () => {
    const agents = { gitStatus: async () => ({ repository: false as const }) } as unknown as NonNullable<Platform['capabilities']['agents']>;
    const platform: Platform = { info: { kind: 'web', appVersion: 'test' }, capabilities: { agents } };
    expect(Object.fromEntries(describeCapabilities(platform).map(row => [row.id, row.status]))).toMatchObject({
      agents: 'available', terminal: 'via-agent-host', secureStorage: 'via-agent-host', git: 'via-agent-host', filesystem: 'unavailable',
    });
    expect(platform.capabilities.terminal).toBeUndefined();
    expect(platform.capabilities.git).toBeUndefined();
  });
});

describe('subagent team normalizers', () => {
  const member = { id: 'm-1', name: 'Ava', role: 'Researcher', models: ['old-model'] };
  it('validates teams and plan requests; re-plans may name models that are no longer allowed', () => {
    expect(normalizeAgentTeam(null)).toBeNull();
    expect(() => normalizeAgentTeam({ enabled: true, allowedModels: ['a'], members: [member] })).toThrow(/This team cannot be saved: .*allowed models/);
    expect(normalizeSessionOptions({ team: { enabled: true, allowedModels: ['a'], members: [] } })).toEqual({ team: { enabled: true, allowedModels: ['a'], members: [] } });
    expect(normalizeTeamPlanRequest({ goal: ' Ship ', count: 2, allowedModels: ['a'], members: [member] })).toEqual({ goal: 'Ship', count: 2, allowedModels: ['a'], members: [{ ...member, models: [] }] });
    expect(() => normalizeTeamPlanRequest({ goal: 'x', count: 0, allowedModels: [] })).toThrow(/1 to 20/);
    expect(() => normalizeTeamPlanRequest({ goal: 'x', count: 21, allowedModels: [] })).toThrow(/1 to 20/);
    expect(normalizeTeamPlanRequest({ goal: 'x', count: 20, allowedModels: [] }).count).toBe(20);
    expect(() => normalizeTeamPlanRequest({ goal: 'x', count: 1.5, allowedModels: [] })).toThrow(/1 to 20/);
    // v0.0.32: the goal and the models are optional; host-only fields from a client are dropped.
    expect(normalizeTeamPlanRequest({ goal: '', count: 1, allowedModels: [], candidateModels: ['x'], context: { workspace: 'w' } })).toEqual({ goal: '', count: 1, allowedModels: [] });
    expect(normalizeTeamPlanRequest({ count: 3 })).toEqual({ goal: '', count: 3, allowedModels: [] });
    expect(() => normalizeTeamPlanRequest({ goal: 7, count: 1, allowedModels: [] })).toThrow(/goal/);
    expect(() => normalizeTeamPlanRequest({ goal: 'x', count: 1, allowedModels: ['a', 'a'] })).toThrow(/twice/);
    expect(() => normalizeTeamPlanRequest({ goal: 'x', count: 1, allowedModels: [], members: [member, member] })).toThrow(/used twice/);
    for (const method of ['getSessionTeam', 'saveSessionTeam', 'planTeam']) expect(isAgentHostMethod(method)).toBe(true);
  });

  it('keeps v0.0.30 member fields (gender, soul, access, scope, forbidden) and team rules', () => {
    const rich = { ...member, name: 'Elena Vael', gender: 'female', soul: 'Pragmatic', access: 'write', scope: ['src/auth/'], forbidden: ['src/db'], models: ['a'] };
    expect(normalizeAgentTeam({ enabled: true, allowedModels: ['a'], rules: ['Run tests'], members: [rich] })).toEqual({
      enabled: true, allowedModels: ['a'], rules: ['Run tests'], members: [{ ...rich, scope: ['src/auth'] }],
    });
    expect(() => normalizeAgentTeam({ enabled: true, allowedModels: [], members: [{ ...member, models: [], scope: ['../x'] }] })).toThrow(/leaves the workspace/);
    expect(normalizeTeamPlanRequest({ goal: 'x', count: 1, allowedModels: [], members: [rich] }).members?.[0]).toMatchObject({ gender: 'female', access: 'write', models: [] });
  });

  it('normalizes a lead identity', () => {
    expect(normalizeAgentIdentity('  Elena   Vael ', 'female')).toEqual({ agentName: 'Elena Vael', agentGender: 'female' });
    expect(normalizeAgentIdentity('Kaelen Vael', 'other')).toEqual({ agentName: 'Kaelen Vael' });
    expect(normalizeAgentIdentity('', 'male')).toEqual({});
    expect(normalizeAgentIdentity(7, 'male')).toEqual({});
    expect(normalizeAgentIdentity('x'.repeat(61), 'male')).toEqual({});
  });
});

describe('normalizeSessionOptions', () => {
  it('keeps valid model ids and efforts, clears empty fields and refuses the rest', () => {
    expect(normalizeSessionOptions(undefined)).toEqual({});
    expect(normalizeSessionOptions({ model: ' vendor/model-1:free ', effort: 'xhigh' })).toEqual({ model: 'vendor/model-1:free', effort: 'xhigh' });
    expect(normalizeSessionOptions({ model: '', effort: null })).toEqual({});
    for (const model of ['--yolo', 'a b', 'x'.repeat(201), 'a$(b)', 42]) expect(() => normalizeSessionOptions({ model })).toThrow(/model id/);
    expect(() => normalizeSessionOptions({ effort: 'ultra' })).toThrow(/effort/);
    expect(() => normalizeSessionOptions('model')).toThrow(/options/);
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(['modelChoices', 'setSessionOptions', 'createSession']));
  });
});

describe('built-in skill list', () => {
  it('is forwarded through Desktop IPC and the Bridge, and validated before it is shown', () => {
    expect(isAgentHostMethod('builtinSkills')).toBe(true);
    expect(normalizeBuiltinSkills([{ name: 'write-tests', description: ' Add tests. ' }, { name: 'code-review', description: 'Review.' }, { name: 'code-review', description: 'Review again.' }]))
      .toEqual([{ name: 'code-review', description: 'Review again.' }, { name: 'write-tests', description: 'Add tests.' }]);
    expect(normalizeBuiltinSkills([])).toEqual([]);
    expect(() => normalizeBuiltinSkills(null)).toThrow(/Invalid built-in skill list/);
    expect(() => normalizeBuiltinSkills({ name: 'x' })).toThrow(/Invalid built-in skill list/);
    expect(() => normalizeBuiltinSkills([{ name: 'Bad Name', description: '' }])).toThrow(/Invalid built-in skill name/);
    expect(() => normalizeBuiltinSkills([{ name: 'ok', description: 42 }])).toThrow(/Invalid description/);
    expect(() => normalizeBuiltinSkills([{ name: 'ok', description: 'x'.repeat(1001) }])).toThrow(/Invalid description/);
    expect(() => normalizeBuiltinSkills(Array.from({ length: 201 }, (_, i) => ({ name: `s${i}`, description: '' })))).toThrow(/At most 200/);
  });
});

describe('workspace skill consent (W0)', () => {
  it('validates allow and revoke requests and forwards the methods', () => {
    const sha256 = 'a'.repeat(64);
    expect(normalizeSkillConsent([{ name: 'deploy', sha256 }, { name: 'deploy', sha256 }])).toEqual([{ name: 'deploy', sha256 }]);
    expect(() => normalizeSkillConsent([])).toThrow(/Choose/);
    expect(() => normalizeSkillConsent([{ name: '../x', sha256 }])).toThrow(/name/);
    expect(() => normalizeSkillConsent([{ name: 'deploy', sha256: 'A'.repeat(64) }])).toThrow(/hash/);
    expect(() => normalizeSkillConsent(Array.from({ length: 101 }, (_, index) => ({ name: `s${index}`, sha256 })))).toThrow(/at most/);
    expect(normalizeSkillNames(undefined)).toBeUndefined();
    expect(normalizeSkillNames(['deploy', 'deploy'])).toEqual(['deploy']);
    expect(() => normalizeSkillNames('deploy')).toThrow(/list/);
    for (const method of ['workspaceSkills', 'allowWorkspaceSkills', 'revokeWorkspaceSkills']) expect(isAgentHostMethod(method)).toBe(true);
  });
});
