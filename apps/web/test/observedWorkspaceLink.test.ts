import { AGENT_HOST_METHODS, normalizeObservedWorkspaceLinkInput, type AgentHostApi, type HostState, type ObservedWorkspaceLinkStatus, type SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { canApplyObservedWorkspaceLink, ObservedWorkspaceLinkButton, ObservedWorkspaceLinkController, ObservedWorkspaceLinkDialogView, observedWorkspaceLinkSupported } from '../src/observe/ObservedWorkspaceLinkDialog';

const revision = 'a'.repeat(64), newer = 'b'.repeat(64);
const session = { id: 'session-a', workspaceId: 'workspace-a', control: 'observed', observation: { sourceId: 'codex', nativeSessionId: 'native-a', projectPath: '/project/app' } } as SessionSummary;
const state = { workspaces: [{ id: 'workspace-a', name: 'Project', projectLocation: '/project' }, { id: 'workspace-b', name: 'App', projectLocation: '/project/app' }], sessions: [session], connections: [] } as unknown as HostState;
const status = (): ObservedWorkspaceLinkStatus => ({ sessionId: session.id, revision, projectPath: '/project/app', mode: 'ambiguous', candidates: [{ workspaceId: 'workspace-a', name: 'Project', root: '/project' }, { workspaceId: 'workspace-b', name: 'App', root: '/project/app' }] });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (failure: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function harness(initial = status()) {
  const host = { observedWorkspaceLink: vi.fn(async (_session: string): Promise<ObservedWorkspaceLinkStatus> => initial),
    setObservedWorkspaceLink: vi.fn(async (_session: string, _input: { revision: string; workspaceId: string | null }): Promise<HostState> => state) };
  const agents = host as unknown as AgentHostApi, applied = vi.fn();
  const owner = new ObservedWorkspaceLinkController(applied); owner.bind(agents, session, state);
  return { host, agents, applied, owner };
}
const render = (value: Parameters<typeof ObservedWorkspaceLinkDialogView>[0]['value'], language: 'en' | 'id' = 'en') => renderToStaticMarkup(createElement(ObservedWorkspaceLinkDialogView, {
  t: MESSAGES[language].observedWorkspaceLink, value, onSelect: vi.fn(), onRefresh: vi.fn(), onApply: vi.fn(), onClose: vi.fn(),
}));

describe('observed workspace association request ownership', () => {
  it('does not apply or request metadata until opened and loaded, and needs no Native connection', async () => {
    const h = harness();
    expect(h.host.observedWorkspaceLink).not.toHaveBeenCalled();
    expect(h.host.setObservedWorkspaceLink).not.toHaveBeenCalled();
    expect(observedWorkspaceLinkSupported(h.agents, session)).toBe(true);
    await h.owner.load();
    expect(h.owner.value.status?.mode).toBe('ambiguous');
    expect(h.owner.value.selected).toBe(null);
    expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(false);
    expect(h.host.setObservedWorkspaceLink).not.toHaveBeenCalled();
  });

  it('keeps an existing explicit link and sends only the exact revision and chosen existing ID', async () => {
    const h = harness({ ...status(), mode: 'explicit', workspaceId: 'workspace-a', linkedWorkspaceId: 'workspace-a' });
    await h.owner.load();
    expect(h.owner.value.selected).toBe('workspace-a');
    expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(false);
    h.owner.select('workspace-b'); await h.owner.apply();
    expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledExactlyOnceWith(session.id, { revision, workspaceId: 'workspace-b' });
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(state);
  });

  it('uses null to explicitly return to automatic association without creating a workspace', async () => {
    const h = harness({ ...status(), mode: 'explicit', linkedWorkspaceId: 'workspace-a' });
    await h.owner.load(); h.owner.select(null); await h.owner.apply();
    expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledExactlyOnceWith(session.id, { revision, workspaceId: null });
  });

  it('permits a continuity-bound explicit link to reset to the same host-resolved automatic workspace', async () => {
    const current = { ...status(), mode: 'explicit' as const, linkedWorkspaceId: 'workspace-a', lockedWorkspaceId: 'workspace-a', automaticWorkspaceId: 'workspace-a' };
    const h = harness(current); await h.owner.load(); h.owner.select(null);
    expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(true);
    const html = render(h.owner.value);
    expect(html).toMatch(/<input type="radio" name="[^"]*" checked=""\/>/);
    await h.owner.apply();
    expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledExactlyOnceWith(session.id, { revision, workspaceId: null });
  });

  it('blocks automatic reset when its host-resolved destination is absent or differs from the continuity lock', async () => {
    for (const automaticWorkspaceId of [undefined, 'workspace-b']) {
      const h = harness({ ...status(), mode: 'explicit', linkedWorkspaceId: 'workspace-a', lockedWorkspaceId: 'workspace-a', automaticWorkspaceId });
      await h.owner.load(); h.owner.select(null);
      expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(false);
      expect(render(h.owner.value)).toMatch(/<input type="radio" disabled="" name="[^"]*" checked=""\/>/);
      await h.owner.apply(); expect(h.host.setObservedWorkspaceLink).not.toHaveBeenCalled();
    }
  });

  it('admits a metadata load and an apply only once while they are pending', async () => {
    const h = harness(), loading = deferred<ObservedWorkspaceLinkStatus>(), saving = deferred<HostState>();
    h.host.observedWorkspaceLink.mockReturnValueOnce(loading.promise);
    const first = h.owner.load(); await h.owner.load(); expect(h.host.observedWorkspaceLink).toHaveBeenCalledOnce();
    loading.resolve(status()); await first; h.owner.select('workspace-a');
    h.host.setObservedWorkspaceLink.mockReturnValueOnce(saving.promise);
    const apply = h.owner.apply(); h.owner.select('workspace-b'); await h.owner.apply();
    expect(h.owner.value.selected).toBe('workspace-a'); expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledOnce();
    saving.resolve(state); await apply;
  });

  it('retains a stale revision selection, blocks blind retry and requires an explicit fresh review', async () => {
    const h = harness(); await h.owner.load(); h.owner.select('workspace-b');
    h.host.setObservedWorkspaceLink.mockRejectedValueOnce(new Error('Workspace review changed. Refresh.'));
    await h.owner.apply();
    expect(h.owner.value.selected).toBe('workspace-b'); expect(h.owner.value.needsRefresh).toBe(true);
    await h.owner.apply(); expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledOnce();
    h.host.observedWorkspaceLink.mockResolvedValueOnce({ ...status(), revision: newer, linkedWorkspaceId: 'workspace-a' });
    await h.owner.load(); expect(h.owner.value.selected).toBe('workspace-b');
    await h.owner.apply(); expect(h.host.setObservedWorkspaceLink).toHaveBeenLastCalledWith(session.id, { revision: newer, workspaceId: 'workspace-b' });
  });

  it('preserves edits when the reported source changes and ignores its old metadata reply', async () => {
    const h = harness(), old = deferred<ObservedWorkspaceLinkStatus>(); await h.owner.load(); h.owner.select('workspace-b');
    h.host.observedWorkspaceLink.mockReturnValueOnce(old.promise); const stale = h.owner.load();
    const updated = { ...session, observation: { ...session.observation!, projectPath: '/project/other' } };
    h.owner.bind(h.agents, updated, state);
    expect(h.owner.value.selected).toBe('workspace-b'); expect(h.owner.value.sourceChanged).toBe(true);
    old.resolve(status()); await stale;
    expect(h.owner.value.status).toBeUndefined(); expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(false);
    h.host.observedWorkspaceLink.mockResolvedValueOnce({ ...status(), revision: newer, projectPath: '/project/other', candidates: [status().candidates[0]!] });
    await h.owner.load(); expect(h.owner.value.selected).toBe('workspace-b');
    expect(canApplyObservedWorkspaceLink(h.owner.value)).toBe(false);
  });

  it('invalidates an old review when registered roots change without losing the draft', async () => {
    const h = harness(); await h.owner.load(); h.owner.select('workspace-b');
    h.owner.bind(h.agents, session, { ...state, workspaces: [{ ...state.workspaces[0]!, projectLocation: '/new-root' }] });
    expect(h.owner.value.status).toBeUndefined(); expect(h.owner.value.selected).toBe('workspace-b');
    await h.owner.apply(); expect(h.host.setObservedWorkspaceLink).not.toHaveBeenCalled();
  });

  it('does not deliver an admitted apply acknowledgement to another session or a closed dialog', async () => {
    for (const close of [false, true]) {
      const h = harness(), saving = deferred<HostState>(); await h.owner.load(); h.owner.select('workspace-a');
      h.host.setObservedWorkspaceLink.mockReturnValueOnce(saving.promise); const pending = h.owner.apply();
      if (close) h.owner.invalidate(); else h.owner.bind(h.agents, { ...session, id: 'session-b' }, state);
      saving.resolve(state); await pending; expect(h.applied).not.toHaveBeenCalled();
    }
  });

  it('waits for an entered mutation to settle after a source change, without applying its old acknowledgement', async () => {
    const h = harness(), saving = deferred<HostState>(); await h.owner.load(); h.owner.select('workspace-a');
    h.host.setObservedWorkspaceLink.mockReturnValueOnce(saving.promise); const pending = h.owner.apply();
    const updated = { ...session, observation: { ...session.observation!, projectPath: '/project/other' } };
    h.owner.bind(h.agents, updated, state); await h.owner.load(); h.owner.select('workspace-b'); await h.owner.apply();
    expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledOnce(); expect(h.host.observedWorkspaceLink).toHaveBeenCalledOnce();
    expect(h.owner.value.busy).toBe('apply');
    saving.resolve(state); await pending;
    expect(h.applied).not.toHaveBeenCalled(); expect(h.owner.value.busy).toBeUndefined(); expect(h.owner.value.needsRefresh).toBe(true);
    await h.owner.load(); expect(h.host.observedWorkspaceLink).toHaveBeenCalledTimes(2);
  });

  it('rejects a reply for another source session without manufacturing a valid review', async () => {
    const h = harness({ ...status(), sessionId: 'other' }); await h.owner.load();
    expect(h.owner.value.status).toBeUndefined(); expect(h.owner.value.error).toContain('another session');
  });

  it('ignores a late metadata response after closing and retains an edit made during refresh', async () => {
    const h = harness(), first = deferred<ObservedWorkspaceLinkStatus>();
    h.host.observedWorkspaceLink.mockReturnValueOnce(first.promise);
    const closed = h.owner.load(); h.owner.invalidate(); first.resolve(status()); await closed;
    expect(h.owner.value.status).toBeUndefined();
    h.owner.bind(h.agents, session, state); await h.owner.load();
    const refresh = deferred<ObservedWorkspaceLinkStatus>(); h.host.observedWorkspaceLink.mockReturnValueOnce(refresh.promise);
    const pending = h.owner.load(); h.owner.select('workspace-b');
    refresh.resolve({ ...status(), revision: newer, linkedWorkspaceId: 'workspace-a' }); await pending;
    expect(h.owner.value.selected).toBe('workspace-b'); expect(h.owner.value.status?.revision).toBe(newer);
  });

  it('blocks unlisted or continuity-incompatible destinations even if a handler supplies their ID', async () => {
    const h = harness({ ...status(), lockedWorkspaceId: 'workspace-a' }); await h.owner.load();
    for (const selected of ['unregistered', 'workspace-b']) { h.owner.select(selected); await h.owner.apply(); }
    expect(h.host.setObservedWorkspaceLink).not.toHaveBeenCalled();
    h.owner.select('workspace-a'); await h.owner.apply(); expect(h.host.setObservedWorkspaceLink).toHaveBeenCalledOnce();
  });
});

describe('observed workspace link presentation and contract', () => {
  it('hides the compact control without host support or for managed sessions', () => {
    const h = harness();
    for (const [agents, source] of [[{} as AgentHostApi, session], [h.agents, { ...session, control: 'managed' as const }]] as const) {
      expect(renderToStaticMarkup(createElement(ObservedWorkspaceLinkButton, { agents, session: source, state, t: MESSAGES.en, onState: vi.fn() }))).toBe('');
    }
    const html = renderToStaticMarkup(createElement(ObservedWorkspaceLinkButton, { agents: h.agents, session, state, t: MESSAGES.en, onState: vi.fn() }));
    expect(html).toContain('aria-label="Link observed workspace"'); expect(html).not.toContain('<dialog');
    expect(h.host.observedWorkspaceLink).not.toHaveBeenCalled();
  });

  it.each(['en', 'id'] as const)('shows reported folders, literal candidate names and continuity locks in %s', language => {
    const html = render({ selected: 'workspace-a', edited: true, status: { ...status(), lockedWorkspaceId: 'workspace-a', reason: 'continuity-bound', candidates: [{ ...status().candidates[0]!, name: '<script>literal</script>' }, status().candidates[1]!] } }, language);
    expect(html).toContain('/project/app'); expect(html).toContain('/project');
    expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="workspace-b"/);
    expect(html).toContain(MESSAGES[language].observedWorkspaceLink.scopeHint);
    expect(html).not.toContain('href=');
  });

  it('gives registration guidance for an unregistered project and retains a missing selection visibly', () => {
    const html = render({ selected: 'workspace-b', edited: true, needsRefresh: true, status: { ...status(), mode: 'unbound', candidates: [] } });
    expect(html).toContain(MESSAGES.en.observedWorkspaceLink.registerHint);
    expect(html).toContain(MESSAGES.en.observedWorkspaceLink.selectionMissing);
    expect(html).toContain('workspace-b'); expect(html).toContain('disabled="">Apply association');
  });

  it('forwards only the two optional metadata capabilities and strictly bounds mutation input', () => {
    expect(AGENT_HOST_METHODS).toContain('observedWorkspaceLink'); expect(AGENT_HOST_METHODS).toContain('setObservedWorkspaceLink');
    expect(normalizeObservedWorkspaceLinkInput({ revision, workspaceId: null })).toEqual({ revision, workspaceId: null });
    expect(normalizeObservedWorkspaceLinkInput({ revision, workspaceId: 'workspace-a' })).toEqual({ revision, workspaceId: 'workspace-a' });
    for (const input of [{ revision }, { revision: 'a', workspaceId: null }, { revision: 'A'.repeat(64), workspaceId: null }, { revision, workspaceId: '/new/path' }, { revision, workspaceId: 'x'.repeat(129) }, { revision, workspaceId: 'workspace-a', path: '/new' }]) {
      expect(() => normalizeObservedWorkspaceLinkInput(input)).toThrow();
    }
  });
});
