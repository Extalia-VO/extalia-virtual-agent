import { describe, expect, it } from 'vitest';
import {
  MAX_TEAM_MEMBERS, decodeAgentTeam, generateMemberNames, modelStrength, modelUsage, parseTeamPlan, parseTeamPlanResult, pickTeamModels, planGoal, planModelOrder, planTeamHeuristic,
  roleSoul, roleStrength, rotatedModels, suitedModels, teamPlanPrompt, type TeamMember,
} from '../src/index.js';

const member = (id: string, name: string, models: string[] = ['model-a']): TeamMember => ({ id, name, role: 'Researcher', task: 'Look things up', models });
const team = (overrides: Record<string, unknown> = {}) => ({ enabled: true, allowedModels: ['model-a', 'model-b'], members: [member('m-1', 'Ava')], ...overrides });

describe('decodeAgentTeam', () => {
  it('accepts a valid team and trims names, roles and tasks', () => {
    const decoded = decodeAgentTeam(team({ goal: '  Ship it  ', updatedAt: '2026-01-31T12:00:00.000Z', members: [{ id: 'm-1', name: ' Ava ', role: ' Reviewer ', task: '  ', models: ['model-b', 'model-a'] }] }));
    expect(decoded).toEqual({ ok: true, value: {
      enabled: true, allowedModels: ['model-a', 'model-b'], goal: 'Ship it', updatedAt: '2026-01-31T12:00:00.000Z',
      members: [{ id: 'm-1', name: 'Ava', role: 'Reviewer', models: ['model-b', 'model-a'] }],
    } });
  });

  it.each([
    ['enabled missing', { enabled: undefined }, /enabled/],
    ['member model not allowed', { members: [member('m-1', 'Ava', ['other'])] }, /not one of the team's allowed models/],
    ['duplicate allowed model', { allowedModels: ['model-a', 'model-a'] }, /twice/],
    ['option-like model id', { allowedModels: ['--yolo'] }, /model id/],
    ['too many allowed models', { allowedModels: Array.from({ length: 21 }, (_, index) => `m${index}`), members: [] }, /at most 20/],
    ['too many members', { members: Array.from({ length: MAX_TEAM_MEMBERS + 1 }, (_, index) => member(`m-${index}`, `N${index}`)) }, /at most 20/],
    ['too many member models', { allowedModels: Array.from({ length: 9 }, (_, index) => `m${index}`), members: [member('m-1', 'Ava', Array.from({ length: 9 }, (_, index) => `m${index}`))] }, /at most 8/],
    ['duplicate id', { members: [member('m-1', 'Ava'), member('m-1', 'Milo')] }, /id "m-1" is used twice/],
    ['duplicate name (case-insensitive)', { members: [member('m-1', 'Ava'), member('m-2', 'ava')] }, /name "ava" is used twice/],
    ['unsafe id', { members: [member('m 1', 'Ava')] }, /letters, digits/],
    ['multi-line name', { members: [member('m-1', 'A\nB')] }, /single line/],
    ['empty role', { members: [{ ...member('m-1', 'Ava'), role: ' ' }] }, /role/],
    ['credential field', { apiKey: 'x' }, /credentials/],
    ['bad timestamp', { updatedAt: 'yesterday' }, /updatedAt/],
  ])('rejects %s', (_label, overrides, error) => {
    const decoded = decodeAgentTeam(team(overrides));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.errors.join(' ')).toMatch(error);
  });

  it('accepts and normalizes v0.0.30 member fields and team rules', () => {
    const decoded = decodeAgentTeam(team({
      rules: [' Run the tests '],
      members: [{ ...member('m-1', 'Elena Vael'), gender: 'female', soul: ' Pragmatic ', access: 'write', scope: ['./src/auth/', 'src\\auth\\otp.ts', 'src/auth'], forbidden: ['src/db/migrations/**'] }],
    }));
    expect(decoded.ok && decoded.value).toMatchObject({
      rules: ['Run the tests'],
      members: [{ name: 'Elena Vael', gender: 'female', soul: 'Pragmatic', access: 'write', scope: ['src/auth', 'src/auth/otp.ts'], forbidden: ['src/db/migrations/**'] }],
    });
  });

  it.each([
    ['unknown gender', { gender: 'other' }, /gender/],
    ['soul over 1000 characters', { soul: 'x'.repeat(1001) }, /soul: longer than 1000/],
    ['unknown access', { access: 'admin' }, /access/],
    ['absolute scope path', { scope: ['/etc'] }, /scope\[0\]: "\/etc" is not relative/],
    ['home scope path', { scope: ['~/x'] }, /not relative/],
    ['windows drive path', { forbidden: ['C:\\x'] }, /not relative/],
    ['scope path leaving the workspace', { scope: ['src/../../x'] }, /leaves the workspace/],
    ['scope naming the root', { scope: ['./'] }, /workspace itself/],
    ['too many scope paths', { scope: Array.from({ length: 33 }, (_, index) => `p${index}`) }, /at most 32/],
    ['scope path too long', { forbidden: ['a'.repeat(201)] }, /up to 200/],
    ['scope not a list', { scope: 'src' }, /list of paths/],
  ])('rejects a member with %s', (_label, fields, error) => {
    const decoded = decodeAgentTeam(team({ members: [{ ...member('m-1', 'Ava'), ...fields }] }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.errors.join(' ')).toMatch(error);
  });

  it('bounds team rules', () => {
    expect(decodeAgentTeam(team({ rules: Array.from({ length: 21 }, () => 'r') })).ok).toBe(false);
    expect(decodeAgentTeam(team({ rules: ['x'.repeat(501)] })).ok).toBe(false);
    expect(decodeAgentTeam(team({ rules: 'r' })).ok).toBe(false);
  });

  it('allows members without models (they use the lead chain)', () => {
    expect(decodeAgentTeam({ enabled: false, allowedModels: [], members: [member('m-1', 'Ava', [])] }).ok).toBe(true);
  });
});

describe('team names and models', () => {
  it('generates short unique names, skipping taken ones, and numbers them when the list runs out', () => {
    expect(generateMemberNames(3, ['ava'])).toEqual(['Milo', 'Nova', 'Iris']);
    const many = generateMemberNames(40);
    expect(new Set(many).size).toBe(40);
    expect(many.at(-1)).toMatch(/ 2$/);
    expect(generateMemberNames(2, [], 1)).toEqual(['Milo', 'Nova']);
  });

  it('classifies model strength from naming', () => {
    expect(modelStrength('claude-opus-5-5')).toBe('strong');
    expect(modelStrength('google/gemini-3-pro')).toBe('strong');
    expect(modelStrength('claude-haiku-4-5')).toBe('light');
    expect(modelStrength('gemini-2.5-flash')).toBe('light');
    expect(modelStrength('gpt-5-mini')).toBe('light');
    expect(modelStrength('google/gemini-3')).toBe('standard');
    expect(modelStrength('claude-sonnet-5-5')).toBe('standard');
  });

  it('rotates the allowed order per member', () => {
    expect(rotatedModels(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotatedModels([], 3)).toEqual([]);
  });
});

describe('planTeamHeuristic', () => {
  it('assigns distinct roles, generated names, souls and spread models deterministically', () => {
    let n = 0;
    const plan = planTeamHeuristic({ goal: 'Add a coverage script', count: 3, allowedModels: ['big', 'mid'] }, () => `m-${++n}`);
    expect(plan.map(item => [item.id, item.role, item.models])).toEqual([
      ['m-1', 'Researcher', ['big', 'mid']],
      ['m-2', 'Reviewer', ['mid', 'big']],
      ['m-3', 'Analyst', ['big', 'mid']],
    ]);
    // Generated full names with explicit gender, unique and the same for the same request.
    expect(plan.every(item => /^\S+ \S+$/.test(item.name) && (item.gender === 'female' || item.gender === 'male'))).toBe(true);
    expect(new Set(plan.map(item => item.name)).size).toBe(3);
    let again = 0;
    expect(planTeamHeuristic({ goal: 'Add a coverage script', count: 3, allowedModels: ['big', 'mid'] }, () => `m-${++again}`).map(item => item.name)).toEqual(plan.map(item => item.name));
    // Names taken elsewhere in the Office are avoided.
    const avoided = planTeamHeuristic({ goal: 'Add a coverage script', count: 3, allowedModels: [] }, () => 'x', [plan[0]!.name.toUpperCase()]);
    expect(avoided.map(item => item.name)).not.toContain(plan[0]!.name);
    expect(plan[0]?.task).toContain('Add a coverage script');
    expect(plan.every(item => item.soul?.includes('Principles:') && item.soul.includes('Add a coverage script'))).toBe(true);
    expect(decodeAgentTeam({ enabled: true, allowedModels: ['big', 'mid'], members: plan }).ok).toBe(true);
  });

  it('keeps current members when re-planning and clamps the count', () => {
    const kept: TeamMember = { id: 'm-keep', name: 'Zed Vael', gender: 'male', role: 'Reviewer', task: 'Own task', models: ['gone'], soul: 'Calm', access: 'write', scope: ['src'] };
    const plan = planTeamHeuristic({ goal: 'x', count: 2, allowedModels: ['a'], members: [kept] }, () => 'm-new');
    expect(plan[0]).toEqual({ ...kept, models: ['a'] });
    expect(plan[1]).toMatchObject({ id: 'm-new', name: expect.stringMatching(/^\S+ \S+$/), role: 'Researcher' });
    expect(planTeamHeuristic({ goal: 'x', count: 99, allowedModels: [] })).toHaveLength(MAX_TEAM_MEMBERS);
  });
});

describe('parseTeamPlan', () => {
  const request = { goal: 'Refactor auth', count: 2, allowedModels: ['opus', 'haiku'] };
  let n = 0;
  const ids = () => `m-${++n}`;

  it('reads a fenced JSON reply, puts the chosen model first and keeps the rest as fallbacks', () => {
    const reply = 'Here you go:\n```json\n{"members":[{"role":"Architect","task":"Design the new flow","model":"opus"},{"role":"Scout","task":"Find call sites","model":"haiku"}]}\n```';
    const members = parseTeamPlan(reply, request, ids);
    // v0.0.39: a member gets the models it was given, not every allowed model.
    expect(members.map(item => [item.role, item.models])).toEqual([['Architect', ['opus']], ['Scout', ['haiku']]]);
    expect(members.every(item => item.soul?.startsWith('Principles:'))).toBe(true);
    expect(members.every(item => /^\S+ \S+$/.test(item.name) && item.gender)).toBe(true);
    expect(teamPlanPrompt(request).user).toContain('opus (strong)');
  });

  it.each([
    ['not JSON', 'I would suggest a researcher.'],
    ['wrong count', '{"members":[{"role":"A","task":"t","model":"opus"}]}'],
    ['unknown model', '{"members":[{"role":"A","task":"t","model":"gpt"},{"role":"B","task":"t","model":"opus"}]}'],
    ['duplicate role', '{"members":[{"role":"A","task":"t","model":"opus"},{"role":"a","task":"t","model":"opus"}]}'],
    ['missing task', '{"members":[{"role":"A","model":"opus"},{"role":"B","task":"t","model":"opus"}]}'],
  ])('rejects a reply with %s', (_label, reply) => {
    expect(() => parseTeamPlan(reply, request, ids)).toThrow();
  });
});

describe('plans without a goal or ticked models', () => {
  const catalog = [
    'ag/claude-opus-thinking', 'ag/claude-sonnet', 'ag/gemini-flash', 'ag/text-embedding-3', 'cx/gpt-pro', 'cx/gpt-mini', 'or/qwen3-coder', 'or/llama-70b',
    'tts-1', 'whisper-large', ...Array.from({ length: 40 }, (_, index) => `bulk/model-${index}`),
  ];

  it('picks a capped, diverse set of chat models with the preferred one first', () => {
    const picked = pickTeamModels(catalog, ['ag/claude-sonnet']);
    expect(picked).toHaveLength(20);
    expect(picked[0]).toBe('ag/claude-sonnet');
    expect(picked.some(model => /embedding|tts|whisper/.test(model))).toBe(false);
    // Strong, standard and light models take turns, so all three are in the first few.
    expect(new Set(picked.slice(1, 4).map(modelStrength))).toEqual(new Set(['strong', 'standard', 'light']));
    expect(pickTeamModels(catalog, [], 5)).toHaveLength(5);
    expect(pickTeamModels([])).toEqual([]);
  });

  it('plans a general team from the workspace context and lets the heuristic choose models by role', () => {
    const request = { goal: '', count: 8, allowedModels: [], candidateModels: pickTeamModels(catalog, ['ag/claude-sonnet']), context: { workspace: 'demo-app', recentTitles: ['Fix login'] } };
    expect(planGoal(request)).toBe('ongoing work in the demo-app project');
    let id = 0;
    const members = planTeamHeuristic(request, () => `m-${++id}`);
    expect(members).toHaveLength(8);
    expect(members[0]!.task).toContain('ongoing work in the demo-app project');
    const reviewer = members.find(member => member.role === 'Reviewer')!, scout = members.find(member => member.role === 'Scout')!;
    expect(modelStrength(reviewer.models[0]!)).toBe('strong');
    expect(modelStrength(scout.models[0]!)).toBe('light');
    const order = planModelOrder(members);
    expect(new Set(members.map(member => member.models[0])).size).toBeGreaterThan(3);
    expect(members.every(member => member.models.every(model => order.includes(model)) && member.models.length <= 8)).toBe(true);
    expect(decodeAgentTeam({ enabled: true, allowedModels: order, members }).ok).toBe(true);

    const prompt = teamPlanPrompt(request).user;
    expect(prompt).toContain('No goal was given: plan a general-purpose team for ongoing work in the demo-app project');
    expect(prompt).toContain('- Fix login');
    expect(prompt).toContain('No model was chosen by the user.');
    expect(prompt).toContain('"models":[');
  });

  it('reads the model\'s chosen models and priority order, and refuses models outside the candidates', () => {
    const request = { goal: 'Ship it', count: 2, allowedModels: [], candidateModels: ['ag/claude-opus-thinking', 'ag/gemini-flash', 'or/qwen3-coder'] };
    const reply = '{"members":[{"role":"Scout","task":"Look up","model":"ag/gemini-flash"},{"role":"Architect","task":"Design","model":"ag/claude-opus-thinking"}],"models":["ag/claude-opus-thinking","ag/gemini-flash"]}';
    const parsed = parseTeamPlanResult(reply, request, () => 'm-x' + Math.random().toString(36).slice(2, 6));
    expect(parsed.allowedModels).toEqual(['ag/claude-opus-thinking', 'ag/gemini-flash']);
    expect(parsed.members.map(member => member.models)).toEqual([['ag/gemini-flash'], ['ag/claude-opus-thinking']]);
    // Without a usable "models" list the order of first use counts.
    expect(parseTeamPlanResult(reply.replace(/,"models":\[[^\]]*\]/, ''), request).allowedModels).toEqual(['ag/gemini-flash', 'ag/claude-opus-thinking']);
    expect(() => parseTeamPlan(reply.replace('ag/gemini-flash"},', 'other/model"},'), request)).toThrow(/no allowed model/);
    // With ticked models nothing is chosen: no allowedModels in the result.
    expect(parseTeamPlanResult(reply, { ...request, allowedModels: ['ag/claude-opus-thinking', 'ag/gemini-flash'] }).allowedModels).toBeUndefined();
  });
});

describe('v0.0.39: per-member model subsets, souls and teams of up to 20', () => {
  const allowed = [
    'ag/claude-opus-thinking', 'ag/claude-sonnet', 'ag/gemini-flash', 'cx/gpt-pro', 'cx/gpt-mini', 'or/qwen3-coder', 'or/llama-70b', 'ds/deepseek-reasoner', 'ds/deepseek-chat', 'gg/gemini-pro',
  ];

  it('classifies roles by the model strength they need', () => {
    expect(roleStrength('Architect')).toBe('strong');
    expect(roleStrength('Security Reviewer')).toBe('strong');
    expect(roleStrength('Code reviewer')).toBe('strong');
    expect(roleStrength('Scout 9')).toBe('light');
    expect(roleStrength('Docs writer')).toBe('light');
    expect(roleStrength('Implementer')).toBe('standard');
    expect(roleStrength('Frontend Engineer')).toBe('standard');
    expect(roleSoul('Frontend Engineer', 'Ship it')).toMatch(/^Principles: .+ Mental model: .+ Priorities: .+ Dislikes: .+ Focus: Ship it$/);
  });

  it('gives a role one or two suited models, the fallback from another provider', () => {
    const usage = modelUsage();
    const reviewer = suitedModels('Reviewer', allowed, usage);
    expect(reviewer).toHaveLength(2);
    expect(modelStrength(reviewer[0]!)).toBe('strong');
    expect(reviewer[1]!.split('/')[0]).not.toBe(reviewer[0]!.split('/')[0]);
    // The next strong role prefers another strong model.
    expect(suitedModels('Architect', allowed, usage)[0]).not.toBe(reviewer[0]);
    expect(modelStrength(suitedModels('Scout', allowed)[0]!)).toBe('light');
    expect(suitedModels('Scout', ['only'])).toEqual(['only']);
    expect(suitedModels('Scout', [])).toEqual([]);
  });

  it('plans 12 members over 10 allowed models with 1–3 fitting models each and a soul', () => {
    let n = 0;
    const members = planTeamHeuristic({ goal: 'Build the billing page', count: 12, allowedModels: allowed }, () => `m-${++n}`);
    expect(members).toHaveLength(12);
    expect(new Set(members.map(member => member.role)).size).toBe(12);
    for (const member of members) {
      expect(member.models.length).toBeGreaterThanOrEqual(1);
      expect(member.models.length).toBeLessThanOrEqual(3);
      expect(member.models.every(model => allowed.includes(model))).toBe(true);
      expect(member.soul).toContain('Build the billing page');
      const wanted = roleStrength(member.role);
      expect(modelStrength(member.models[0]!)).toBe(wanted);
    }
    // Work spreads over the allowed models instead of everyone preferring the first one.
    expect(new Set(members.map(member => member.models[0])).size).toBeGreaterThanOrEqual(6);
    expect(decodeAgentTeam({ enabled: true, allowedModels: allowed, members }).ok).toBe(true);
  });

  it('allows up to 20 members with distinct roles', () => {
    let n = 0;
    const members = planTeamHeuristic({ goal: 'x', count: 20, allowedModels: ['a/model'] }, () => `m-${++n}`);
    expect(MAX_TEAM_MEMBERS).toBe(20);
    expect(members).toHaveLength(20);
    expect(new Set(members.map(member => member.role.toLowerCase())).size).toBe(20);
    expect(members.every(member => member.models.length === 1 && member.soul)).toBe(true);
    expect(decodeAgentTeam({ enabled: true, allowedModels: ['a/model'], members }).ok).toBe(true);
    expect(decodeAgentTeam({ enabled: true, allowedModels: ['a/model'], members: [...members, { ...members[0]!, id: 'm-21', name: 'Extra Person' }] }).ok).toBe(false);
    expect(planTeamHeuristic({ goal: 'x', count: 25, allowedModels: [] })).toHaveLength(20);
  });

  it('asks the planner for per-member model subsets with reasons and a soul', () => {
    const prompt = teamPlanPrompt({ goal: 'Build the billing page', count: 12, allowedModels: allowed }).user;
    expect(prompt).toContain('not what every member gets');
    expect(prompt).toContain('usually 1 to 3');
    expect(prompt).toContain('another provider');
    expect(prompt).toContain('working principles, mental model, priorities and what it dislikes');
    expect(prompt).toContain('"models":["<best fit>","<fallback>"],"why":"…"');
    expect(prompt).toContain('exactly 12 members');
    expect(teamPlanPrompt({ goal: 'x', count: 2, allowedModels: [] }).user).not.toContain('"why"');
  });

  it('reads per-member subsets, souls and reasons, dropping models outside the allowed list', () => {
    let n = 0;
    const reply = JSON.stringify({ members: [
      { role: 'Architect', task: 'Design', soul: 'Calm and   exact.', models: ['ag/claude-opus-thinking', 'cx/gpt-pro', 'ag/claude-opus-thinking'], why: 'Hard design needs strong reasoning.' },
      { role: 'Scout', task: 'Look up', models: ['cx/gpt-mini', 'not/allowed'] },
      { role: 'Tester', task: 'Test', model: 'or/qwen3-coder', soul: 'x'.repeat(1500) },
    ] });
    const parsed = parseTeamPlanResult(reply, { goal: 'Ship', count: 3, allowedModels: allowed }, () => `m-${++n}`);
    expect(parsed.members.map(member => member.models)).toEqual([['ag/claude-opus-thinking', 'cx/gpt-pro'], ['cx/gpt-mini'], ['or/qwen3-coder']]);
    expect(parsed.members[0]!.soul).toBe('Calm and exact.');
    expect(parsed.members[1]!.soul).toMatch(/^Principles: answers fast/);
    expect(parsed.members[2]!.soul!.length).toBeLessThanOrEqual(1000);
    expect(parsed.modelReasons).toEqual({ 'm-1': 'Hard design needs strong reasoning.' });
    expect(() => parseTeamPlan(reply.replace('"cx/gpt-mini","not/allowed"', '"not/allowed"'), { goal: 'Ship', count: 3, allowedModels: allowed })).toThrow(/no allowed model/);
  });

  it('keeps current members (ids, names) on a re-plan and takes the plan\'s role, task, soul and models', () => {
    const kept: TeamMember = { id: 'm-keep', name: 'Zed Vael', role: 'Reviewer', task: 'Old', models: [], soul: 'Old soul', access: 'write' };
    const reply = '{"members":[{"role":"Security Reviewer","task":"Audit","soul":"Paranoid.","models":["gg/gemini-pro"]},{"role":"Scout","task":"Find","models":["cx/gpt-mini"]}]}';
    const parsed = parseTeamPlanResult(reply, { goal: 'x', count: 2, allowedModels: allowed, members: [kept] }, () => 'm-new');
    expect(parsed.members[0]).toEqual({ id: 'm-keep', name: 'Zed Vael', role: 'Security Reviewer', task: 'Audit', models: ['gg/gemini-pro'], soul: 'Paranoid.', access: 'write' });
    expect(parsed.members[1]).toMatchObject({ id: 'm-new', role: 'Scout', models: ['cx/gpt-mini'] });
  });
});
