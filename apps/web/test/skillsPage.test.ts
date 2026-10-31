import type { AgentHostApi, HostState } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { navigationGroups } from '../src/appMode';
import { createMockPlatform } from '../src/host/mockHost';
import { MOCK_BUILTIN_SKILLS } from '../src/host/mockSkillRegistry';
import { MESSAGES } from '../src/i18n';
import { SettingsPage, SkillsMovedPointer } from '../src/pages/SettingsPage';
import { DEFAULT_PREFERENCES } from '../src/preferences';
import { ProjectSkills, ProjectSkillsNoticeView, ProjectSkillsPendingLinkView, takeProjectSkillsReveal } from '../src/skills/ProjectSkills';
import { SkillSecurityCenter } from '../src/skills/SkillSecurityCenter';
import { needsUserDecision } from '../src/skills/skillCenterModel';
import { BuiltinSkillsSection, SkillsPageView } from '../src/skills/SkillsPage';
import { loadBuiltinSkills, skillsWaitingCount } from '../src/skills/skillsModel';

const t = MESSAGES.en;

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(item => item.type === 'button' && (item.props['aria-label'] === label || text(item.props.children as ReactNode) === label));
  if (!found) throw new Error(`No button "${label}"`);
  return found.props as { onClick: () => void };
}

async function mockHost(skills?: 'legacy' | 'review'): Promise<{ agents: AgentHostApi; state: HostState }> {
  const platform = createMockPlatform({ seed: 'ready', host: 'bridge', ...(skills ? { skills } : {}) });
  const agents = platform.capabilities.agents!;
  return { agents, state: await agents.getState() };
}

function page(agents: AgentHostApi, state: HostState, patch: Partial<Parameters<typeof SkillsPageView>[0]> = {}) {
  return SkillsPageView({ t, agents, state, mode: 'legacy', filter: null, onFilter: () => undefined, builtin: null, builtinLoading: false, ...patch });
}

describe('Skills page navigation', () => {
  it('lists Skills in the Extalia group next to Settings whenever an agent host exists', () => {
    for (const workflow of ['managed', 'observe'] as const) {
      for (const canChat of [true, false]) {
        const groups = navigationGroups({ agents: true, workflow, canChat });
        expect(groups.find(group => group.section === 'app')!.pages).toEqual(['skills', 'settings', 'diagnostics']);
        expect(groups.find(group => group.section === 'work')!.pages).not.toContain('skills');
      }
    }
    // The static web build has no host to ask.
    expect(navigationGroups({ agents: false, workflow: 'managed', canChat: false }).flatMap(group => group.pages)).not.toContain('skills');
    expect(t.nav.skills).toBe('Skills');
    expect(MESSAGES.id.nav.skills).toBe('Skill');
    expect(t.nav.skillsWaiting(2)).toBe('Skills, 2 waiting for review');
  });

  it('counts skills waiting for review or approval for the nav badge, in both modes', async () => {
    const registry = await mockHost();
    const report = await registry.agents.skillRegistry();
    const expected = report.revisions.filter(needsUserDecision).length;
    expect(expected).toBe(2);
    expect(await skillsWaitingCount(registry.agents, registry.state.workspaces)).toBe(expected);

    const legacy = await mockHost('legacy');
    const folders = legacy.state.workspaces.filter(workspace => workspace.projectLocation);
    expect(folders.length).toBeGreaterThan(0);
    expect(await skillsWaitingCount(legacy.agents, legacy.state.workspaces)).toBe(folders.length);
    const first = folders[0]!;
    await legacy.agents.allowWorkspaceSkills(first.id, (await legacy.agents.workspaceSkills(first.id)).pending);
    expect(await skillsWaitingCount(legacy.agents, legacy.state.workspaces)).toBe(folders.length - 1);
  });
});

describe('Skills page modes', () => {
  it('shows the Skill Security Center with the native core and no W0 panels', async () => {
    const { agents, state } = await mockHost();
    const tree = page(agents, state, { mode: 'registry' });
    expect(elements(tree).some(item => item.type === SkillSecurityCenter)).toBe(true);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('<h1>Skills</h1>');
    expect(html).not.toContain('Project skills');
    expect(html).not.toContain('preview native core');
  });

  it('shows project skills for every workspace with a folder, with the registry note, in legacy mode', async () => {
    const { agents, state } = await mockHost('legacy');
    const tree = page(agents, state);
    expect(elements(tree).some(item => item.type === SkillSecurityCenter)).toBe(false);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Project skills');
    for (const workspace of state.workspaces.filter(item => item.projectLocation)) expect(html).toContain(`aria-label="${workspace.name}"`);
    expect(html).toContain(t.skillsPage.registryNote);
    expect(html).not.toContain('Show all workspaces');

    const id = renderToStaticMarkup(SkillsPageView({ t: MESSAGES.id, agents, state, mode: 'legacy', filter: null, onFilter: () => undefined, builtin: null, builtinLoading: false }));
    expect(id).toContain('<h1>Skill</h1>');
    expect(id).toContain('Skill project');
    expect(id).toContain(MESSAGES.id.skillsPage.registryNote);
  });

  it('waits for the host before choosing a mode', async () => {
    const { agents, state } = await mockHost();
    const html = renderToStaticMarkup(page(agents, state, { mode: null }));
    expect(html).toContain('Loading skills…');
    expect(html).not.toContain('Project skills');
  });

  it('narrows to one workspace when opened from Settings, and shows all again on request', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge', skills: 'legacy' });
    const agents = platform.capabilities.agents!;
    const base = await agents.getState();
    // Two workspaces with folders, so narrowing is visible.
    const state: HostState = { ...base, workspaces: [base.workspaces[0]!, { ...base.workspaces[0]!, id: 'w_second000000000', name: 'second-project', projectLocation: '/projects/second' }] };
    const onFilter = vi.fn();
    const html = renderToStaticMarkup(page(agents, state, { filter: 'w_second000000000', onFilter }));
    expect(html).toContain('aria-label="second-project"');
    expect(html).not.toContain(`aria-label="${base.workspaces[0]!.name}"`);
    expect(html).toContain('Showing second-project only.');
    // The section is a child component; render it to press its button.
    const section = elements(page(agents, state, { filter: 'w_second000000000', onFilter })).find(item => typeof item.type === 'function' && item.type.name === 'ProjectSkillsSection')!;
    const rendered = (section.type as (props: Record<string, unknown>) => ReactNode)(section.props);
    button(rendered, 'Show all workspaces').onClick();
    expect(onFilter).toHaveBeenCalledWith(null);
    // A workspace that no longer exists shows every workspace.
    const stale = renderToStaticMarkup(page(agents, state, { filter: 'w_gone' }));
    expect(stale).toContain('aria-label="second-project"');
    expect(stale).toContain(`aria-label="${base.workspaces[0]!.name}"`);
  });

  it('lets a workspace without project skills say so in one line', () => {
    const workspace = { id: 'w1', profileId: 'p', name: 'demo', projectLocation: '/project', providerProfileId: 'c', createdAt: '', updatedAt: '' };
    const agents = { workspaceSkills: async () => ({ workspaceId: 'w1', allowed: [], pending: [], warnings: [] }), allowWorkspaceSkills: async () => undefined, revokeWorkspaceSkills: async () => undefined } as unknown as AgentHostApi;
    // Before the report arrives it shows the workspace with a loading line.
    const html = renderToStaticMarkup(createElement(ProjectSkills, { t, agents, workspace }));
    expect(html).toContain('demo');
    expect(html).toContain('Loading skills…');
  });
});

describe('built-in skills', () => {
  it('lists name and description, read-only, and says they update with app releases', () => {
    const html = renderToStaticMarkup(createElement(BuiltinSkillsSection, { t, skills: [...MOCK_BUILTIN_SKILLS], loading: false }));
    expect(html).toContain('Built-in skills');
    expect(html).toContain('ship with the app and are updated with app releases');
    for (const skill of MOCK_BUILTIN_SKILLS) {
      expect(html).toContain(`>${skill.name}</code>`);
      expect(html).toContain(skill.description);
    }
    expect(html).toContain(t.skillsPage.builtinBrowseOnly);
    expect(html).toContain('<details');
    expect(html).toContain(t.skillsPage.builtinCategory);
    expect(renderToStaticMarkup(createElement(BuiltinSkillsSection, { t, skills: null, loading: true }))).toContain('Loading skills…');
    expect(renderToStaticMarkup(createElement(BuiltinSkillsSection, { t, skills: null, loading: false }))).toBe('');
    expect(renderToStaticMarkup(createElement(BuiltinSkillsSection, { t: MESSAGES.id, skills: [...MOCK_BUILTIN_SKILLS], loading: false }))).toContain('Skill bawaan');
  });

  it('loads and validates the host list, and hides it for an older or misbehaving host', async () => {
    const { agents } = await mockHost();
    expect(await loadBuiltinSkills(agents)).toEqual([...MOCK_BUILTIN_SKILLS].sort((a, b) => (a.name < b.name ? -1 : 1)));
    const { builtinSkills: _b, ...older } = agents;
    expect(await loadBuiltinSkills(older as AgentHostApi)).toBeNull();
    expect(await loadBuiltinSkills({ ...agents, builtinSkills: async () => { throw new Error('This host does not support this action.'); } })).toBeNull();
    expect(await loadBuiltinSkills({ ...agents, builtinSkills: async () => [{ name: 'Bad Name', description: '' }] })).toBeNull();
  });

  it('appears in both modes', async () => {
    const { agents, state } = await mockHost();
    for (const mode of ['registry', 'legacy'] as const) {
      expect(renderToStaticMarkup(page(agents, state, { mode, builtin: [...MOCK_BUILTIN_SKILLS] }))).toContain('Built-in skills');
    }
  });
});

describe('links into the Skills page', () => {
  it('Settings keeps only a pointer to the Skills page', async () => {
    const onOpen = vi.fn();
    const pointer = SkillsMovedPointer({ t, onOpen });
    expect(renderToStaticMarkup(pointer)).toContain('Skills moved to the Skills page.');
    button(pointer, 'Open Skills').onClick();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(SkillsMovedPointer({ t: MESSAGES.id, onOpen }))).toContain('Skill dipindahkan ke halaman Skill.');

    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const hostState = await platform.capabilities.agents!.getState();
    const html = renderToStaticMarkup(createElement(SettingsPage, {
      t, platform, preferences: DEFAULT_PREFERENCES, onChange: () => undefined, hostState, onHostState: () => undefined, updateStatus: null, onOpenSkills: () => undefined,
    }));
    expect(html).toContain('Skills moved to the Skills page.');
    expect(html).not.toContain('Skill Security Center');
    expect(html).not.toContain('Built-in skills');
  });

  it('Settings → Workspaces links pending project skills to the Skills page on that workspace', () => {
    const onReview = vi.fn();
    const link = ProjectSkillsPendingLinkView({ t, workspaceId: 'w1', workspaceName: 'demo', count: 2, onReview });
    expect(renderToStaticMarkup(link)).toContain('2 project skills waiting for review');
    button(link, 'Review the project skills of demo').onClick();
    expect(onReview).toHaveBeenCalledWith('w1');
    // The page focuses that workspace once.
    expect(takeProjectSkillsReveal('w1')).toBe(true);
    expect(takeProjectSkillsReveal('w1')).toBe(false);
    expect(renderToStaticMarkup(ProjectSkillsPendingLinkView({ t, workspaceId: 'w1', workspaceName: 'demo', count: 1, onReview }))).toContain('1 project skill waiting for review');
  });

  it('the Chat notice says "Review skills" and opens the Skills page focused on the workspace', () => {
    const onReview = vi.fn();
    const onClose = vi.fn();
    const notice = ProjectSkillsNoticeView({ t, workspaceId: 'w9', count: 1, onReview, onClose });
    const html = renderToStaticMarkup(notice);
    expect(html).toContain('Review skills');
    expect(html).not.toContain('Settings');
    button(notice, 'Review skills').onClick();
    expect(onReview).toHaveBeenCalledWith('w9');
    expect(takeProjectSkillsReveal('w9')).toBe(true);
    expect(takeProjectSkillsReveal('w9')).toBe(false);
    button(notice, t.common.close).onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(ProjectSkillsNoticeView({ t: MESSAGES.id, workspaceId: 'w9', count: 1, onReview, onClose }))).toContain('Tinjau skill');
  });
});


it.each(['en', 'id'] as const)('keeps the mandatory scanner notice visible in all registry modes (%s)', async language => {
  const { agents, state } = await mockHost();
  for (const mode of ['legacy', 'registry', null] as const) {
    const html = renderToStaticMarkup(page(agents, state, { mode, t: MESSAGES[language] }));
    expect(html).toContain(MESSAGES[language].skillsPage.scannerRequired);
  }
});
