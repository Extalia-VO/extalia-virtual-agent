import { decodeAgentTeam } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import {
  applyPlan, clampCount, customModel, defaultAllowedModels, filterModels, generateIdentity, generateName, manualMember, markEdited, mergePlan, moveItem, newMemberId, planReasons, plainMembers,
  restrictModels, sessionTeamSummary, teamForSave, teamProblem, toggleAllowedModel, toggleMemberModel, type DraftMember,
} from '../src/office/team';

const ALLOWED = ['opus', 'sonnet', 'haiku'];

describe('team setup: ordering', () => {
  it('moves an item and clamps the target', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, 9)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, -4)).toEqual(['b', 'a', 'c']);
    const list = ['a'];
    expect(moveItem(list, 5, 0)).toEqual(['a']);
    expect(moveItem(list, 0, 0)).not.toBe(list);
  });

  it('ticks models last, unticks them and caps the allowed list at 20', () => {
    expect(toggleAllowedModel(ALLOWED, 'gpt', true)).toEqual([...ALLOWED, 'gpt']);
    expect(toggleAllowedModel(ALLOWED, 'opus', true)).toEqual(ALLOWED);
    expect(toggleAllowedModel(ALLOWED, 'sonnet', false)).toEqual(['opus', 'haiku']);
    const full = Array.from({ length: 20 }, (_, index) => `m${index}`);
    expect(toggleAllowedModel(full, 'extra', true)).toHaveLength(20);
  });

  it('validates a typed model id', () => {
    expect(customModel(ALLOWED, '  openai/gpt-5 ')).toEqual({ model: 'openai/gpt-5' });
    expect(customModel(ALLOWED, '--rm')).toEqual({ error: 'invalid' });
    expect(customModel(ALLOWED, 'has space')).toEqual({ error: 'invalid' });
    expect(customModel(ALLOWED, 'opus')).toEqual({ error: 'duplicate' });
    expect(customModel(Array.from({ length: 20 }, (_, index) => `m${index}`), 'x')).toEqual({ error: 'full' });
  });
});

describe('team setup: member models stay a subset of the allowed models', () => {
  it('drops unknown and repeated models but keeps the order', () => {
    expect(restrictModels(['haiku', 'gpt', 'opus', 'haiku'], ALLOWED)).toEqual(['haiku', 'opus']);
  });

  it('falls back to one or two allowed models that suit the role when nothing is left (never every allowed model)', () => {
    expect(restrictModels(['gone'], ALLOWED, 1)).toEqual(['sonnet', 'opus']);
    expect(restrictModels([], ALLOWED, 0, 'Architect')).toEqual(['opus', 'sonnet']);
    expect(restrictModels([], ALLOWED, 0, 'Scout')).toEqual(['haiku', 'sonnet']);
    expect(restrictModels([], [], 0)).toEqual([]);
  });

  it('v0.0.39: a hand-added member gets 1–2 suited models from the allowed list', () => {
    const many = ['a/opus', 'b/sonnet', 'c/haiku', 'd/pro', 'e/mini', 'f/large', 'g/model', 'h/flash', 'i/chat', 'j/max'];
    const member = manualMember([], many, 'Reviewer');
    expect(member.models.length).toBeGreaterThanOrEqual(1);
    expect(member.models.length).toBeLessThanOrEqual(2);
    expect(member.models.every(model => many.includes(model))).toBe(true);
    // A user can still add more models, but only allowed ones.
    expect(toggleMemberModel(member.models, 'zz/other', many, true)).toEqual(member.models);
    expect(toggleMemberModel(member.models, 'c/haiku', many, true)).toEqual([...member.models, 'c/haiku']);
  });

  it('v0.0.39: filters the models that can be ticked, leaving the selected ones out', () => {
    const offered = ['openai/gpt-5', 'openai/gpt-5-mini', 'anthropic/claude-opus-5-5', 'google/gemini-3-flash', 'openai/gpt-5'];
    expect(filterModels(offered, ['openai/gpt-5'], '')).toEqual(['openai/gpt-5-mini', 'anthropic/claude-opus-5-5', 'google/gemini-3-flash']);
    expect(filterModels(offered, ['openai/gpt-5'], 'GPT')).toEqual(['openai/gpt-5-mini']);
    expect(filterModels(offered, [], 'openai mini')).toEqual(['openai/gpt-5-mini']);
    expect(filterModels(offered, [], '  ')).toEqual(['openai/gpt-5', 'openai/gpt-5-mini', 'anthropic/claude-opus-5-5', 'google/gemini-3-flash']);
    expect(filterModels(offered, [], 'nothing')).toEqual([]);
  });

  it('adds and removes member models without leaving the order empty', () => {
    expect(toggleMemberModel(['opus'], 'haiku', ALLOWED, true)).toEqual(['opus', 'haiku']);
    expect(toggleMemberModel(['opus'], 'gpt', ALLOWED, true)).toEqual(['opus']);
    expect(toggleMemberModel(['opus', 'haiku'], 'opus', ALLOWED, false)).toEqual(['haiku']);
    expect(toggleMemberModel(['opus'], 'opus', ALLOWED, false)).toEqual(['opus']);
  });
});

describe('team setup: names and ids', () => {
  it('generates a stable name that is not taken', () => {
    const name = generateName([], 'seed-1');
    expect(generateName([], 'seed-1')).toBe(name);
    const other = generateName([name.toUpperCase()], 'seed-1');
    expect(other.toLowerCase()).not.toBe(name.toLowerCase());
  });

  it('gives full names (first and last) that stay unique across many members', () => {
    const taken: string[] = [];
    for (let index = 0; index < 40; index += 1) taken.push(generateName(taken, `s${index}`));
    expect(new Set(taken.map(name => name.toLowerCase())).size).toBe(40);
    for (const name of taken) expect(name).toMatch(/^\S+ \S+/);
  });

  it('keeps an explicit gender and avoids every office name', () => {
    const office = ['Elena Mark', 'Kaelen Vael'];
    const first = generateIdentity(office, 'm-1', 'female');
    expect(first.gender).toBe('female');
    expect(office.map(name => name.toLowerCase())).not.toContain(first.name.toLowerCase());
    expect(generateIdentity(office, 'm-1', 'female')).toEqual(first);
    const member = manualMember([], ALLOWED, 'Assistant', () => 'm-9', office);
    expect(member.gender).toMatch(/^(female|male)$/);
    expect(office).not.toContain(member.name);
  });

  it('creates unique member ids accepted by the core decoder', () => {
    const ids = ['m-1'];
    let calls = 0;
    expect(newMemberId(ids, () => (calls++ === 0 ? 'm-1' : 'm-2'))).toBe('m-2');
    const member = manualMember([], ALLOWED, 'Assistant');
    expect(decodeAgentTeam({ enabled: true, allowedModels: ALLOWED, members: [member] }).ok).toBe(true);
    expect(manualMember([member], ALLOWED, 'Assistant').models[0]).toBe('sonnet');
  });
});

describe('team setup: re-plan merge', () => {
  const current: DraftMember[] = [
    { id: 'a', name: 'Nova', role: 'Researcher', task: 'Look around', models: ['opus'] },
    { id: 'b', name: 'My Reviewer', role: 'Code reviewer', task: 'Review', models: ['haiku', 'sonnet'], edited: ['name', 'role', 'models'] },
  ];

  it('keeps edited fields, takes the rest (and models) from the plan, and keeps ids', () => {
    const planned = [
      { id: 'a', name: 'Nova', role: 'Analyst', task: 'Analyse', models: ['sonnet'] },
      { id: 'b', name: 'Iris', role: 'Reviewer', task: 'Check risks', models: ['opus'] },
      { id: 'c', name: 'Kai', role: 'Tester', task: 'Test it', models: ['haiku', 'gpt'] },
    ];
    const merged = mergePlan(current, planned, ALLOWED);
    expect(merged.map(member => member.id)).toEqual(['a', 'b', 'c']);
    expect(merged[0]).toMatchObject({ role: 'Analyst', task: 'Analyse', models: ['sonnet'] });
    expect(merged[1]).toMatchObject({ name: 'My Reviewer', role: 'Code reviewer', task: 'Check risks', models: ['haiku', 'sonnet'], edited: ['name', 'role', 'models'] });
    expect(merged[2]!.models).toEqual(['haiku']);
  });

  it('matches by position when the plan returns new ids, and drops extra members on a smaller count', () => {
    const merged = mergePlan(current, [{ id: 'x', name: 'Juno', role: 'Planner', models: ['haiku'] }], ALLOWED);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('a');
    expect(merged[0]!.role).toBe('Planner');
  });

  it('keeps names unique and restricts models when the allowed list shrank', () => {
    const merged = mergePlan([], [
      { id: 'p', name: 'Leo', role: 'A', models: ['gone'] },
      { id: 'q', name: 'leo', role: 'B', models: ['opus'] },
    ], ['opus']);
    expect(merged[0]!.models).toEqual(['opus']);
    expect(merged[1]!.name.toLowerCase()).not.toBe('leo');
  });

  it('v0.0.39: keeps the plan\'s model reasons by merged member, except where the user edited the models', () => {
    const planned = [
      { id: 'x', name: 'Juno', role: 'Planner', models: ['opus'] },
      { id: 'y', name: 'Kai', role: 'Scout', models: ['haiku'] },
    ];
    const merged = mergePlan(current, planned, ALLOWED);
    expect(planReasons({ members: planned, modelReasons: { x: 'Planning needs depth.', y: 'Fast lookups.' } }, merged)).toEqual({ a: 'Planning needs depth.' });
    expect(planReasons({ members: planned }, merged)).toEqual({});
  });

  it('marks edits once', () => {
    expect(markEdited({ id: 'a', name: 'A', role: 'R', models: [] }, 'name')).toEqual(['name']);
    expect(markEdited({ id: 'a', name: 'A', role: 'R', models: [], edited: ['name'] }, 'name')).toEqual(['name']);
  });
});

describe('team setup: save', () => {
  it('reports what blocks saving', () => {
    expect(teamProblem({ enabled: false, allowedModels: [], members: [] })).toBeUndefined();
    expect(teamProblem({ enabled: true, allowedModels: [], members: [] })).toBe('models');
    expect(teamProblem({ enabled: true, allowedModels: ALLOWED, members: [] })).toBe('members');
    const member = { id: 'a', name: 'Nova', role: 'R', models: ['opus'] };
    expect(teamProblem({ enabled: true, allowedModels: ALLOWED, members: [member, { ...member, id: 'b', name: ' nova ' }] })).toBe('names');
    expect(teamProblem({ enabled: true, allowedModels: ALLOWED, members: [{ ...member, role: ' ' }] })).toBe('roles');
    expect(teamProblem({ enabled: true, allowedModels: ALLOWED, members: [member] })).toBeUndefined();
  });

  it('sends a trimmed team the core decoder accepts', () => {
    const team = teamForSave({
      enabled: true, allowedModels: ALLOWED, goal: '  Ship it  ',
      members: [{ id: 'a', name: ' Nova ', role: ' Researcher ', task: '  ', models: ['gpt', 'haiku'], edited: ['task'] }],
    });
    expect(team).toEqual({ enabled: true, allowedModels: ALLOWED, goal: 'Ship it', members: [{ id: 'a', name: 'Nova', role: 'Researcher', models: ['haiku'] }] });
    expect(decodeAgentTeam(team).ok).toBe(true);
    expect(plainMembers([{ id: 'a', name: 'N', role: 'R', models: ['opus'], edited: ['name'] }])).toEqual([{ id: 'a', name: 'N', role: 'R', models: ['opus'] }]);
  });

  it('starts from the default model and two more, clamps the count and reads the session summary', () => {
    expect(defaultAllowedModels('sonnet', ['opus', 'sonnet', 'haiku', 'gpt'])).toEqual(['sonnet', 'opus', 'haiku']);
    expect(defaultAllowedModels(undefined, [])).toEqual([]);
    expect([clampCount(0), clampCount(3.4), clampCount(12), clampCount(25), clampCount(Number.NaN)]).toEqual([1, 3, 12, 20, 1]);
    expect(sessionTeamSummary(undefined)).toBeUndefined();
    expect(sessionTeamSummary({ team: { enabled: true, size: 3 } } as SessionSummary)).toEqual({ enabled: true, size: 3 });
  });
});

describe('v0.0.32: plans without ticked models', () => {
  const planned = [
    { id: 'p1', name: 'Elena Mark', role: 'Architect', task: 'Design', models: ['x/opus', 'x/flash'] },
    { id: 'p2', name: 'Kaelen Vael', role: 'Scout', task: 'Look up', models: ['x/flash', 'x/opus'] },
  ];

  it('ticks the models the plan chose, in its priority order, and keeps ticked models as they are', () => {
    const chosen = applyPlan([], [], { members: planned, allowedModels: ['x/opus', 'x/flash'] });
    expect(chosen.allowed).toEqual(['x/opus', 'x/flash']);
    expect(chosen.members.map(member => member.models)).toEqual([['x/opus', 'x/flash'], ['x/flash', 'x/opus']]);
    // Without the plan's list, the order its members use the models.
    expect(applyPlan([], [], { members: [planned[1]!, planned[0]!] }).allowed).toEqual(['x/flash', 'x/opus']);
    const ticked = applyPlan([], ['x/flash'], { members: planned, allowedModels: ['x/opus', 'x/flash'] });
    expect(ticked.allowed).toEqual(['x/flash']);
    expect(ticked.members.every(member => member.models.join() === 'x/flash')).toBe(true);
  });

  it('keeps the user\'s edits on a re-plan that chooses models', () => {
    const current = [{ ...planned[0]!, role: 'Lead designer', edited: ['role' as const] }];
    const next = applyPlan(current, [], { members: [{ ...planned[0]!, role: 'Architect' }], allowedModels: ['x/opus'] });
    expect(next.members[0]).toMatchObject({ id: 'p1', role: 'Lead designer', models: ['x/opus'] });
  });

  it('lets a Hermes team be saved without ticked models', () => {
    const team = { enabled: true, allowedModels: [], members: [{ id: 'a', name: 'Ava Stone', role: 'Researcher', models: [] }] };
    expect(teamProblem(team)).toBe('models');
    expect(teamProblem(team, true)).toBeUndefined();
  });
});
