import type { AgentHostApi, HostMissionRun, IntegrationProposalView, SessionSummary } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import {
  confirmChange, gateOrigin, hasWriteTasks, missionChangeItems, MissionChangesView, missionChangesSupported, missionOrphans, proposeForm, proposeRequest,
  type ChangesConfirm, type MissionChangesViewProps,
} from '../src/missions/MissionChanges';
import { MissionMonitor } from '../src/missions/MissionMonitor';
import { activityFromEvent } from '../src/office/activityFeed';

type Agents = NonNullable<ReturnType<typeof createMockPlatform>['capabilities']['agents']>;
const t = MESSAGES.en;

async function seeded(): Promise<{ agents: Agents; run: HostMissionRun; session: SessionSummary }> {
  const agents = createMockPlatform({ seed: 'ready', host: 'bridge', missions: true }).capabilities.agents!;
  for (let n = 0; n < 200; n++) {
    const state = await agents.getState();
    for (const session of state.sessions) {
      if (session.control !== 'managed' || session.runtime) continue;
      const run = (await agents.listNativeMissions(session.id).catch(() => [])).find(item => hasWriteTasks(item) && item.state !== 'running');
      if (run && (await agents.integrationProposals!()).length >= 5) return { agents, run, session };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The write mission demo was not seeded.');
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';

async function viewProps(agents: Agents, run: HostMissionRun, patch: Partial<MissionChangesViewProps> = {}): Promise<MissionChangesViewProps> {
  const worktrees = await agents.listWorktrees!();
  const statuses = Object.fromEntries(await Promise.all(worktrees.map(async item => [item.id, await agents.worktreeStatus!(item.id)] as const)));
  const diffs = Object.fromEntries(await Promise.all(worktrees.map(async item => [item.id, await agents.worktreeDiff!(item.id)] as const)));
  return {
    t, language: 'en', run, items: missionChangeItems(run, worktrees, await agents.integrationProposals!(), statuses, diffs), orphans: missionOrphans(run, await agents.worktreeOrphans!()),
    workspace: (await agents.getState()).workspaces.find(item => item.id === run.workspaceId),
    forms: {}, busy: null, error: null, confirm: null, onRefresh: vi.fn(), onForm: vi.fn(), onPropose: vi.fn(), onAskApply: vi.fn(), onAskRemove: vi.fn(), onConfirm: vi.fn(), onCancelConfirm: vi.fn(), ...patch,
  };
}

describe('mission Changes panel (ADR 0028)', () => {
  it('seeds every integration outcome in the mock host and shows write workers in the journal-shaped events', async () => {
    const { agents, run, session } = await seeded();
    expect(missionChangesSupported(agents)).toBe(true);
    const proposals = await agents.integrationProposals!();
    expect(new Set(proposals.map(item => item.status))).toEqual(new Set(['stale', 'ready', 'gate_failed', 'conflict', 'applied']));
    expect(proposals.find(item => item.status === 'conflict')!.conflicts).toEqual(['src/login/LoginForm.tsx', 'src/login/form.css']);
    expect(proposals.find(item => item.status === 'gate_failed')!.gate).toMatchObject({ ok: false, exitCode: 1, basis: 'verified_by_extalia' });
    expect((await agents.worktreeOrphans!()).map(item => item.reason).sort()).toEqual(['owner-ended', 'unregistered']);
    const events = (await agents.sessionEvents(session.id)).filter(event => event.correlationId === run.id);
    expect(events.filter(event => event.body.type === 'subagent.spawned').every(event => event.body.type === 'subagent.spawned' && event.body.role === 'write-worker')).toBe(true);
    const edit = events.find(event => event.body.type === 'tool.started' && event.body.kind === 'edit')!;
    expect(edit.body).toMatchObject({ tool: 'edit_file', target: 'src/fix-validation.ts' });
    // The Office treats write workers like read-only mission workers: the hand-off is the lead's.
    const spawn = events.find(event => event.body.type === 'subagent.spawned')!;
    expect(activityFromEvent(spawn)?.characterId).toBe(`${session.id}:primary`);
  });

  it('renders conflict paths, the failed gate log, branch and diff summary per write task', async () => {
    const { agents, run } = await seeded();
    const html = renderToStaticMarkup(createElement(MissionChangesView, await viewProps(agents, run)));
    expect(html).toContain('Changes');
    for (const value of ['Fix login validation', 'extalia/worker/w-', 'Conflicting paths', 'src/login/LoginForm.tsx', 'src/login/form.css', 'Test gate failed', 'AssertionError', 'Ready to apply', 'Stale', 'Applied', 'Orphaned worktrees', 'Folder not linked to any mission']) {
      expect(html, value).toContain(value);
    }
    expect(html).toMatch(/2 files · \+\d+ −\d+/);
    // Integrated worktrees offer no new proposal; released ones do, pre-filled from the workspace gate.
    expect(html).toContain(t.missions.changes.gateNote.slice(0, 40));
    expect(html).toContain('value="npm test"');
    expect(html).toContain(t.missions.changes.gateFromWorkspace('demo-app'));
    // The seeded proposals ran the workspace setting (the requests named no gate).
    expect(html).toContain(`· ${t.missions.changes.gateSourceWorkspace}`);
  });

  it('applies only after a confirmation that shows and sends the exact diff digest', async () => {
    const { agents, run } = await seeded();
    const onAskApply = vi.fn();
    const tree = MissionChangesView(await viewProps(agents, run, { onAskApply }));
    const apply = elements(tree).find(item => item.type === 'button' && text(item.props.children as ReactNode).includes(t.missions.changes.apply))!;
    (apply.props.onClick as () => void)();
    const proposal = onAskApply.mock.calls[0]![0] as IntegrationProposalView;
    expect(proposal.status).toBe('ready');
    const confirm: ChangesConfirm = { kind: 'apply', proposalId: proposal.id, targetBranch: proposal.targetBranch, diffDigest: proposal.diffDigest! };
    const html = renderToStaticMarkup(createElement(MissionChangesView, await viewProps(agents, run, { confirm })));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(proposal.diffDigest);
    const fake = { applyIntegration: vi.fn(async () => proposal), removeWorktree: vi.fn() };
    await confirmChange(fake as unknown as Parameters<typeof confirmChange>[0], confirm);
    expect(fake.applyIntegration).toHaveBeenCalledWith(proposal.id, { diffDigest: proposal.diffDigest });
    // The real (mock) host refuses any other digest and applies the exact one.
    await expect(agents.applyIntegration!(proposal.id, { diffDigest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/does not match/);
    expect((await confirmChange(agents as Parameters<typeof confirmChange>[0], confirm) as IntegrationProposalView).status).toBe('applied');
  });

  it('removes unmerged work only with the fingerprint that was shown', async () => {
    const { agents, run } = await seeded();
    const worktree = (await agents.listWorktrees!()).find(item => item.owner.missionId === run.id && !item.integratedAs)!;
    await expect(agents.removeWorktree!(worktree.id)).rejects.toThrow(/discard them explicitly/);
    await expect(agents.removeWorktree!(worktree.id, { fingerprint: `sha256:${'1'.repeat(64)}` })).rejects.toThrow(/changed since you reviewed/);
    const status = await agents.worktreeStatus!(worktree.id);
    const confirm: ChangesConfirm = { kind: 'remove', worktreeId: worktree.id, fingerprint: status.fingerprint, unmerged: true };
    const html = renderToStaticMarkup(createElement(MissionChangesView, await viewProps(agents, run, { confirm })));
    expect(html).toContain(status.fingerprint);
    expect(html).toContain('Discard changes');
    await confirmChange(agents as Parameters<typeof confirmChange>[0], confirm);
    expect((await agents.listWorktrees!()).some(item => item.id === worktree.id)).toBe(false);
  });

  it('builds the proposal from the form: base branch target, the workspace gate by default, a custom gate only when typed', () => {
    const worktree = { baseBranch: 'main' } as Parameters<typeof proposeForm>[0];
    const gate = { command: 'pnpm test', timeoutSeconds: 900 };
    // No built-in default: without a workspace setting the field starts empty.
    expect(proposeForm(worktree)).toEqual({ target: 'main', gate: '' });
    expect(proposeForm(worktree, undefined, gate)).toEqual({ target: 'main', gate: 'pnpm test' });
    expect(proposeForm(worktree, { target: 'dev', gate: 'x' }, gate)).toEqual({ target: 'dev', gate: 'x' });
    expect(gateOrigin({ target: 'main', gate: ' pnpm test ' }, gate)).toBe('workspace');
    expect(gateOrigin({ target: 'main', gate: '' }, gate)).toBe('workspace');
    expect(gateOrigin({ target: 'main', gate: 'npm test' }, gate)).toBe('custom');
    expect(gateOrigin({ target: 'main', gate: 'npm test' })).toBe('custom');
    expect(gateOrigin({ target: 'main', gate: '  ' })).toBe('none');
    // The workspace gate is not resent: the host runs its stored setting (with its timeout).
    expect(proposeRequest({ target: ' main ', gate: 'pnpm test' }, gate)).toEqual({ targetBranch: 'main' });
    expect(proposeRequest({ target: ' main ', gate: '  ' })).toEqual({ targetBranch: 'main' });
    expect(proposeRequest({ target: 'main', gate: ' npm test ' }, gate)).toEqual({ targetBranch: 'main', gate: { command: 'npm test' } });
  });

  it('without a workspace gate: says so, offers the suggestion and a link to Settings, and the proposal stays gate_missing', async () => {
    const { agents, run } = await seeded();
    const state = await agents.getState();
    const demo = state.workspaces.find(item => item.id === run.workspaceId)!;
    const onEditGate = vi.fn(), onForm = vi.fn();
    const props = await viewProps(agents, run, { workspace: { ...demo, integrationGate: undefined }, gateSuggestion: 'npm test', onEditGate, onForm });
    const html = renderToStaticMarkup(createElement(MissionChangesView, props));
    expect(html).toContain(t.missions.changes.gateNone('demo-app'));
    expect(html).not.toContain('value="npm test"');
    const tree = MissionChangesView(props);
    const button = (label: string) => elements(tree).find(item => item.type === 'button' && text(item.props.children as ReactNode).includes(label));
    (button(t.missions.changes.gateSuggestion('npm test'))!.props.onClick as () => void)();
    expect(onForm).toHaveBeenCalledWith(expect.stringMatching(/^w-/), expect.objectContaining({ gate: 'npm test' }));
    (button(t.missions.changes.setGate)!.props.onClick as () => void)();
    expect(onEditGate).toHaveBeenCalledWith(demo.id);
    // With a configured gate the link edits it and no suggestion is offered.
    const configured = MissionChangesView(await viewProps(agents, run, { gateSuggestion: 'pnpm test', onEditGate }));
    expect(elements(configured).some(item => item.type === 'button' && text(item.props.children as ReactNode).includes(t.missions.changes.editGate))).toBe(true);
    expect(elements(configured).some(item => item.type === 'button' && text(item.props.children as ReactNode).includes('pnpm test'))).toBe(false);
    // The mock host behaves like the real one: request gate, else workspace gate, else gate_missing.
    const worktree = (await agents.listWorktrees!()).find(item => item.owner.missionId === run.id && !item.integratedAs && item.state === 'released')!;
    expect(await agents.proposeIntegration!(worktree.id)).toMatchObject({ gateSource: 'workspace', gate: { command: 'npm test' } });
    expect(await agents.proposeIntegration!(worktree.id, { gate: { command: 'pnpm test' } })).toMatchObject({ gateSource: 'request', gate: { command: 'pnpm test' } });
    await agents.saveWorkspace({ id: demo.id, name: demo.name, projectLocation: demo.projectLocation!, connectionId: demo.providerProfileId!, permissions: demo.permissions!, integrationGate: null });
    const missing = await agents.proposeIntegration!(worktree.id);
    expect(missing.status === 'gate_missing' || missing.status === 'conflict').toBe(true);
    expect(missing.gate).toBeUndefined();
  }, 20_000);

  it('hides the panel on a host without the worktree methods', async () => {
    const { agents, run, session } = await seeded();
    const render = (host: AgentHostApi) => renderToStaticMarkup(createElement(MissionMonitor, {
      t, language: 'en', agents: host, session, connections: [], initial: run, onBack: () => undefined, onChanged: () => undefined,
    }));
    expect(render(agents)).toContain(`id="mission-changes-${run.id}"`);
    const { listWorktrees: _l, worktreeStatus: _s, worktreeDiff: _d, worktreeOrphans: _o, removeWorktree: _r, proposeIntegration: _p, integrationProposals: _i, applyIntegration: _a, ...older } = agents;
    expect(missionChangesSupported(older)).toBe(false);
    const html = render(older as AgentHostApi);
    expect(html).not.toContain('mission-changes');
    expect(html).toContain(run.title);
  });
});
