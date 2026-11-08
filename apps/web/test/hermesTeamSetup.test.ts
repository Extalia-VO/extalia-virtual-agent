import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentHostApi, AgentTeam, ModelChoices } from '@extalia/platform';
import { TeamSetupDialog } from '../src/office/TeamSetupDialog';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], effects: new Map<number, unknown[]>(), pending: [] as (() => void)[] }));
vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }));
vi.mock('../src/goals/goalDocument', async original => ({ ...await original<object>(), useGoalDocumentUrl: () => undefined }));
vi.mock('react', async original => {
  const effect = (run: () => void, deps: unknown[] = []) => {
    const id = hooks.index++, previous = hooks.effects.get(id);
    if (previous?.length === deps.length && previous.every((item, i) => Object.is(item, deps[i]))) return;
    hooks.effects.set(id, deps); hooks.pending.push(run);
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.state[id]) : next;
        if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect, useId: () => 'test-team',
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const content = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(content).join('') : isValidElement<{ children?: ReactNode }>(node) ? content(node.props.children) : '';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const models = Array.from({ length: 8 }, (_, index) => `example/model-${index}`);
const teamOf = (count: number): AgentTeam => ({ enabled: true, allowedModels: models,
  connections: [{ connectionId: 'saved-router', allowedModels: models }],
  members: Array.from({ length: count }, (_, index) => ({ id: `m-${index}`, name: `Member ${index}`, role: 'Reviewer', models,
    ...(index === 0 ? { connectionId: 'saved-router' } : {}) })),
});

function harness(runtime: ModelChoices['runtime'], team = teamOf(2), language: 'en' | 'id' = 'en') {
  const choices: ModelChoices = { runtime, models, defaultModel: models[0], efforts: [] };
  const plan = vi.fn(async () => ({ source: 'heuristic', members: team.members.slice(0, 2) }));
  const saved = vi.fn();
  const props: Parameters<typeof TeamSetupDialog>[0] = { t: MESSAGES[language], workspaceId: 'workspace', pending: team, onSaved: saved, onClose: vi.fn(),
    agents: { modelChoices: vi.fn(async () => choices), getState: vi.fn(async () => ({ sessions: [], workspaces: [], connections: [{ id: 'saved-router', name: 'Example router' }] })),
      planTeam: plan, saveSessionTeam: vi.fn(), teamModelChoices: vi.fn(async () => choices) } as unknown as AgentHostApi };
  const render = () => { let tree: ReactNode; do { hooks.dirty = false; hooks.index = 0; tree = TeamSetupDialog(props); for (const run of hooks.pending.splice(0)) run(); } while (hooks.dirty); return tree; };
  const button = (label: string) => elements(render()).find(node => node.type === 'button' && content(node) === label)!;
  const count = () => elements(render()).find(node => node.type === 'input' && node.props.type === 'number')!;
  return { render, button, count, plan, saved, props };
}

beforeEach(() => {
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.effects.clear(); hooks.pending = [];
  vi.stubGlobal('document', { createElement: () => ({ className: '' }), body: { children: [], appendChild: vi.fn() }, activeElement: null });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
});

it.each(['en', 'id'] as const)('hides eight stored model backups and connection controls for Hermes in %s, preserving them on save', async language => {
  const team = teamOf(2), h = harness('hermes', team, language), m = MESSAGES[language].team;
  h.render(); await settle();
  const nodes = elements(h.render());
  expect(h.count().props).toMatchObject({ max: 2, value: 2 });
  expect(h.button(m.addMember).props.disabled).toBe(true);
  expect(nodes.some(node => node.props.className === 'team-add-fallback')).toBe(false);
  expect(nodes.some(node => node.props.className === 'team-field team-models')).toBe(false);
  expect(nodes.some(node => node.props.label === m.memberConnection)).toBe(false);
  expect(content(h.render())).toContain(m.hermesSharedModel);
  expect(content(h.render())).not.toContain(models[0]);
  (h.button(m.save).props.onClick as () => void)();
  expect(h.saved).toHaveBeenCalledWith(team);
});

it('keeps the Native model pool, eight-model chain, fallback picker and connection assignment visible', async () => {
  const team = teamOf(2);
  team.members[1]!.models = models.slice(0, 2);
  const h = harness('extalia-native', team), m = MESSAGES.en.team;
  h.render(); await settle();
  expect(h.count().props.max).toBe(32);
  const nodes = elements(h.render());
  expect(nodes.some(node => node.props.className === 'team-field team-models')).toBe(true);
  expect(nodes.some(node => node.props.label === m.memberConnection)).toBe(true);
  expect(content(h.render())).toContain(models[7]);
  expect(content(h.render())).toContain(m.memberModels);
  expect(nodes.some(node => node.props.className === 'team-add-fallback')).toBe(true);
  expect(nodes.filter(node => node.props.className === 'team-chip')).toHaveLength(10);
  expect(h.button(m.addMember).props.disabled).toBe(false);
});

it('retains oversized stored rosters, warns and blocks Plan and enabled Save without silently dropping members', async () => {
  const h = harness('hermes', teamOf(32)), m = MESSAGES.en.team;
  h.render(); await settle();
  expect(elements(h.render()).filter(node => node.props.className === 'team-member')).toHaveLength(32);
  expect(content(h.render())).toContain(m.hermesTeamLimit);
  expect(h.count().props).toMatchObject({ max: 2, value: 2 });
  const planButton = elements(h.render()).find(node => node.props.className === 'button small primary team-plan')!;
  expect(planButton.props.disabled).toBe(true);
  expect(h.button(m.save).props.disabled).toBe(true);
  (planButton.props.onClick as () => void)();
  (h.button(m.save).props.onClick as () => void)();
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.saved).not.toHaveBeenCalled();
});

it('clamps typed Hermes plan counts and ignores an oversized host plan response', async () => {
  const h = harness('hermes', teamOf(1));
  h.render(); await settle();
  (h.count().props.onChange as (event: unknown) => void)({ target: { value: '32' } });
  expect(h.count().props.value).toBe(2);
  h.plan.mockResolvedValue({ source: 'heuristic', members: teamOf(3).members });
  const button = elements(h.render()).find(node => node.props.className === 'button small primary team-plan')!;
  (button.props.onClick as () => void)(); await settle();
  expect(h.plan).toHaveBeenCalledWith('workspace', expect.objectContaining({ count: 2 }));
  expect(elements(h.render()).filter(node => node.props.className === 'team-member')).toHaveLength(1);
  expect(content(h.render())).toContain(MESSAGES.en.team.hermesTeamLimit);
});

it('stops manual Hermes additions at two', async () => {
  const h = harness('hermes', teamOf(1)), m = MESSAGES.en.team;
  h.render(); await settle();
  (h.button(m.addMember).props.onClick as () => void)();
  expect(elements(h.render()).filter(node => node.props.className === 'team-member')).toHaveLength(2);
  expect(h.button(m.addMember).props.disabled).toBe(true);
  (h.button(m.addMember).props.onClick as () => void)();
  expect(elements(h.render()).filter(node => node.props.className === 'team-member')).toHaveLength(2);
});

function profileChoices(total: number, parallel = 3): ModelChoices {
  return { runtime: 'hermes', models, efforts: [], hermesDelegation: { profile: 'work', oneshotMaxChildren: total, maxConcurrentChildren: parallel,
    maxTeamMembers: total === 0 ? 32 : Math.min(32, total), workerModel: 'shared-worker', workerModelSource: 'delegation', modelRouting: 'shared', source: 'profile' } };
}

it.each([6, 8, 0])('uses the selected profile budget %s instead of a fixed two', async total => {
  const h = harness('hermes', teamOf(2)), choices = profileChoices(total);
  vi.mocked(h.props.agents.modelChoices).mockResolvedValue(choices);
  h.render(); await settle();
  const maximum = total === 0 ? 32 : total;
  expect(h.count().props.max).toBe(maximum);
  (h.count().props.onChange as (event: unknown) => void)({ target: { value: '32' } });
  expect(h.count().props.value).toBe(maximum);
  expect(content(h.render())).toContain(MESSAGES.en.team.hermesProfileLimits('work', total, 3, maximum));
  expect(content(h.render())).toContain(MESSAGES.en.team.hermesWorkerModel('shared-worker'));
  expect(elements(h.render()).some(node => node.props.className === 'team-field team-models')).toBe(false);
});

it('refreshes a lowered limit without discarding the existing roster', async () => {
  const h = harness('hermes', teamOf(2)), m = MESSAGES.en.team;
  vi.mocked(h.props.agents.modelChoices).mockResolvedValue(profileChoices(8));
  h.render(); await settle(); expect(h.count().props.max).toBe(8);
  vi.mocked(h.props.agents.modelChoices).mockResolvedValue(profileChoices(1));
  (h.button(m.hermesRefreshLimits).props.onClick as () => void)();
  h.render(); await settle();
  expect(h.count().props.max).toBe(1);
  expect(elements(h.render()).filter(node => node.props.className === 'team-member')).toHaveLength(2);
  expect(h.button(m.save).props.disabled).toBe(true);
});

it('plans for the saved session target rather than only the workspace default', async () => {
  const h = harness('hermes', teamOf(1)); h.props.sessionId = 'saved-session';
  vi.mocked(h.props.agents.modelChoices).mockResolvedValue(profileChoices(6));
  h.render(); await settle();
  (h.count().props.onChange as (event: unknown) => void)({ target: { value: '6' } });
  const button = elements(h.render()).find(node => node.props.className === 'button small primary team-plan')!;
  (button.props.onClick as () => void)(); await settle();
  expect(h.plan).toHaveBeenCalledWith('workspace', expect.objectContaining({ count: 6 }), 'saved-session');
});

it('blocks unverifiable and custom-routing shared-model plans', async () => {
  const h = harness('hermes', teamOf(2));
  const choices = profileChoices(6); choices.hermesDelegation!.modelRouting = 'profile-custom';
  vi.mocked(h.props.agents.modelChoices).mockResolvedValue(choices);
  h.render(); await settle();
  expect(h.button(MESSAGES.en.team.save).props.disabled).toBe(true);
  expect(content(h.render())).toContain(MESSAGES.en.team.hermesCustomRouting);
});


it('blocks enabled saves when fresh Hermes profile limits cannot be read', async () => {
  const h = harness('hermes', teamOf(1)), m = MESSAGES.en.team;
  vi.mocked(h.props.agents.getState).mockResolvedValue({ sessions: [], workspaces: [{ id: 'workspace', runtimeId: 'hermes' }], connections: [] } as never);
  vi.mocked(h.props.agents.modelChoices).mockRejectedValue(new Error('Unreadable profile'));
  h.render(); await settle();
  expect(content(h.render())).toContain(m.hermesLimitsFailed);
  expect(h.button(m.save).props.disabled).toBe(true);
  expect(h.button(m.addMember).props.disabled).toBe(true);
  (h.button(m.save).props.onClick as () => void)();
  expect(h.saved).not.toHaveBeenCalled();
});
