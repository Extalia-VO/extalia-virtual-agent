import type { AgentHostApi, SkillConsentInput, WorkspaceSkills } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { applyProjectSkillsAction, hasProjectSkills, ProjectSkills, ProjectSkillsView, projectSkillsSupported, shortHash } from '../src/skills/ProjectSkills';

const t = MESSAGES.en;
const DEPLOY = 'd'.repeat(12) + '0123456789abcdef'.repeat(3) + '0123';
const LINT = 'b'.repeat(64);
const DOCS = 'c'.repeat(64);

const REPORT: WorkspaceSkills = {
  workspaceId: 'w1',
  allowed: [{ name: 'docs', description: 'Write the docs.', sha256: DOCS }],
  pending: [
    { name: 'deploy', description: 'Ship <the> app.', sha256: DEPLOY, source: 'workspace', reason: 'not-allowed' },
    { name: 'lint', description: 'Run the linters.', sha256: LINT, source: 'workspace', reason: 'changed' },
  ],
  warnings: ['.extalia/skills/broken/SKILL.md: missing front matter.'],
};

function fakeHost(report: WorkspaceSkills = REPORT) {
  return {
    workspaceSkills: vi.fn(async () => report),
    allowWorkspaceSkills: vi.fn(async (_id: string, _skills: SkillConsentInput[]) => report),
    revokeWorkspaceSkills: vi.fn(async (_id: string, _names?: string[]) => report),
  };
}

/** Every host element of a rendered (hook-free) view, depth first. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function view(overrides: Partial<Parameters<typeof ProjectSkillsView>[0]> = {}) {
  return ProjectSkillsView({ t, workspaceId: 'w1', report: REPORT, busy: false, error: null, onAllow: () => undefined, onRevoke: () => undefined, ...overrides });
}

const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : '';

/** A button by its accessible label or its own text. */
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(item => item.type === 'button' && (item.props['aria-label'] === label || text(item.props.children as ReactNode) === label));
  if (!found) throw new Error(`No button "${label}"`);
  return found.props as { onClick: () => void; disabled?: boolean };
}

describe('project skills section', () => {
  it('lists pending skills with reason, source, short hash and full-hash tooltip, then allowed skills and warnings', () => {
    const html = renderToStaticMarkup(createElement(ProjectSkillsView, { t, workspaceId: 'w1', report: REPORT, busy: false, error: null, onAllow: () => undefined, onRevoke: () => undefined }));
    expect(html).toContain('Project skills');
    expect(html).toContain('untrusted guidance');
    expect(html).toContain('Waiting for your review (2)');
    expect(html).toContain('Ship &lt;the&gt; app.');
    expect(html).toContain('New in this project');
    expect(html).toContain('Changed since you allowed it');
    expect(html).toContain('.extalia/skills/deploy/SKILL.md');
    expect(shortHash(DEPLOY)).toBe('dddddddddddd');
    expect(html).toContain(`title="SHA-256 ${DEPLOY}">dddddddddddd</code>`);
    expect(html).not.toContain(`>${DEPLOY}<`);
    expect(html).toContain('aria-label="Allow skill deploy"');
    expect(html).toContain('Allow all');
    expect(html).toContain('Allowed (1)');
    expect(html).toContain('aria-label="Revoke skill docs"');
    expect(html).toContain('Revoke all');
    expect(html).toContain('missing front matter.');

    const id = renderToStaticMarkup(createElement(ProjectSkillsView, { t: MESSAGES.id, workspaceId: 'w1', report: REPORT, busy: false, error: 'Gagal.', onAllow: () => undefined, onRevoke: () => undefined }));
    expect(id).toContain('Skill project');
    expect(id).toContain('Baru di project ini');
    expect(id).toContain('Izinkan semua');
    expect(id).toContain('role="alert"');
  });

  it('offers Allow all only with more than one pending skill and hides an empty project', () => {
    const one = renderToStaticMarkup(createElement(ProjectSkillsView, { t, workspaceId: 'w1', report: { ...REPORT, pending: REPORT.pending.slice(0, 1) }, busy: false, error: null, onAllow: () => undefined, onRevoke: () => undefined }));
    expect(one).not.toContain('Allow all');
    const empty: WorkspaceSkills = { workspaceId: 'w1', allowed: [], pending: [], warnings: [] };
    expect(hasProjectSkills(empty)).toBe(false);
    expect(view({ report: empty })).toBeNull();
    expect(view({ report: null })).toBeNull();
  });

  it('allows exactly the name and hash shown, one skill or all of them', async () => {
    const host = fakeHost();
    const onAllow = (skills: SkillConsentInput[]) => void applyProjectSkillsAction(host, 'w1', { kind: 'allow', skills });
    button(view({ onAllow }), 'Allow skill deploy').onClick();
    expect(host.allowWorkspaceSkills).toHaveBeenLastCalledWith('w1', [{ name: 'deploy', sha256: DEPLOY }]);
    button(view({ onAllow }), 'Allow all').onClick();
    expect(host.allowWorkspaceSkills).toHaveBeenLastCalledWith('w1', [{ name: 'deploy', sha256: DEPLOY }, { name: 'lint', sha256: LINT }]);
    expect(button(view({ busy: true }), 'Allow skill deploy').disabled).toBe(true);
  });

  it('revokes one skill or every skill of the workspace', async () => {
    const host = fakeHost();
    const onRevoke = (names?: string[]) => void applyProjectSkillsAction(host, 'w1', { kind: 'revoke', names });
    button(view({ onRevoke }), 'Revoke skill docs').onClick();
    expect(host.revokeWorkspaceSkills).toHaveBeenLastCalledWith('w1', ['docs']);
    button(view({ onRevoke }), 'Revoke all').onClick();
    expect(host.revokeWorkspaceSkills).toHaveBeenLastCalledWith('w1', undefined);
  });

  it("shows the host's error and reloads the list when a skill changed after it was shown", async () => {
    const host = fakeHost();
    host.allowWorkspaceSkills.mockRejectedValueOnce(new Error('The skill "deploy" changed after it was shown. Review it again before allowing it.'));
    const result = await applyProjectSkillsAction(host, 'w1', { kind: 'allow', skills: [{ name: 'deploy', sha256: DEPLOY }] });
    expect(result.error).toContain('changed after it was shown');
    expect(result.report).toBe(REPORT);
    expect(host.workspaceSkills).toHaveBeenCalledWith('w1');
  });

  it('is hidden when the host does not implement project skills', () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    expect(projectSkillsSupported(agents)).toBe(true);
    const { workspaceSkills: _w, allowWorkspaceSkills: _a, revokeWorkspaceSkills: _r, ...older } = agents;
    const legacy = older as unknown as AgentHostApi;
    expect(projectSkillsSupported(legacy)).toBe(false);
    const workspace = { id: 'w1', profileId: 'p', name: 'demo', projectLocation: '/project', providerProfileId: 'c', createdAt: '', updatedAt: '' };
    expect(renderToStaticMarkup(createElement(ProjectSkills, { t, agents: legacy, workspace }))).toBe('');
  });

  it('round-trips consent through the mock host', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const workspaceId = (await agents.getState()).workspaces[0]!.id;
    const before = await agents.workspaceSkills(workspaceId);
    expect(before.pending.map(skill => [skill.name, skill.reason])).toEqual([['deploy', 'not-allowed']]);
    const allowed = await applyProjectSkillsAction(agents, workspaceId, { kind: 'allow', skills: before.pending });
    expect(allowed.report?.allowed.map(skill => skill.name)).toEqual(['deploy']);
    const stale = await applyProjectSkillsAction(agents, workspaceId, { kind: 'allow', skills: [{ name: 'deploy', sha256: 'f'.repeat(64) }] });
    expect(stale.error).toContain('changed after it was shown');
    const revoked = await applyProjectSkillsAction(agents, workspaceId, { kind: 'revoke' });
    expect(revoked.report?.pending).toHaveLength(1);
  });
});
