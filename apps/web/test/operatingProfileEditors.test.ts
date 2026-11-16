import type * as React from 'react';
import type { AgentHostApi, HostState } from '@extalia/platform';
import type { OperatingProfile, SessionOperatingProfile } from '@extalia/core';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatingProfilesSection } from '../src/operatingProfiles/OperatingProfilesSection';
import { WorkspaceProfilePicker } from '../src/operatingProfiles/WorkspaceProfilePicker';
import { SessionPersonaEditor } from '../src/operatingProfiles/SessionPersonaEditor';
import { TeamSetupDialog } from '../src/office/TeamSetupDialog';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { WorkspaceForm } from '../src/setup/WorkspaceForm';
import type { WorkspaceDraft } from '../src/setup/validation';
import { MESSAGES } from '../src/i18n';
import { Select } from '../src/ui/Select';
import { DirectoryBrowser } from '../src/setup/DirectoryBrowser';
import { emptyWorkspaceDraft } from '../src/setup/validation';
import { ComboBox } from '../src/ui/ComboBox';

type Store = { state: unknown[]; effects: Map<number, { dependencies?: unknown[]; cleanup?: () => void }> };
const hooks = vi.hoisted(() => ({ index: 0, store: null as Store | null, pending: [] as (() => void)[] }));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useId: () => `profile-editor-${hooks.index++}`,
  useState: (initial: unknown) => {
    const store = hooks.store!, index = hooks.index++;
    if (!(index in store.state)) store.state[index] = typeof initial === 'function' ? initial() : initial;
    return [store.state[index], (value: unknown) => { store.state[index] = typeof value === 'function' ? value(store.state[index]) : value; }];
  },
  useRef: (value: unknown) => { const index = hooks.index++; return hooks.store!.state[index] ??= { current: value }; },
  useCallback: (callback: unknown) => { hooks.index++; return callback; },
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
    const store = hooks.store!, index = hooks.index++, previous = store.effects.get(index);
    if (previous && dependencies && previous.dependencies?.length === dependencies.length && previous.dependencies.every((value, at) => Object.is(value, dependencies[at]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); store.effects.set(index, { dependencies, cleanup: cleanup || undefined }); });
  },
  useLayoutEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
    const store = hooks.store!, index = hooks.index++, previous = store.effects.get(index);
    if (previous && dependencies && previous.dependencies?.length === dependencies.length && previous.dependencies.every((value, at) => Object.is(value, dependencies[at]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); store.effects.set(index, { dependencies, cleanup: cleanup || undefined }); });
  },
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function mount<P>(Component: (props: P) => ReactNode, initial: P) {
  let props = initial;
  let childKey: string | undefined;
  const stores = new Map<string, Store>();
  const call = (component: (props: never) => ReactNode, value: unknown, key: string) => {
    const store = stores.get(key) ?? { state: [], effects: new Map() }; stores.set(key, store); hooks.store = store; hooks.index = 0;
    return component(value as never);
  };
  return {
    draw(next: Partial<P> = {}) {
      props = { ...props, ...next };
      let tree = call(Component as (props: never) => ReactNode, props, 'root');
      if (isValidElement<Record<string, unknown>>(tree) && typeof tree.type === 'function') {
        const nextKey = `${tree.type.name}-${tree.key}`;
        if (childKey && childKey !== nextKey) {
          for (const effect of stores.get(childKey)?.effects.values() ?? []) effect.cleanup?.();
          stores.delete(childKey);
        }
        childKey = nextKey;
        tree = call(tree.type as (props: never) => ReactNode, tree.props, nextKey);
      }
      while (hooks.pending.length) hooks.pending.shift()!();
      return tree;
    },
    close() { for (const store of stores.values()) for (const effect of store.effects.values()) effect.cleanup?.(); },
  };
}
const flush = async () => { for (let count = 0; count < 6; count++) await Promise.resolve(); };
const input = (tree: ReactNode, suffix: string) => elements(tree).find(node => typeof node.props.id === 'string' && node.props.id.endsWith(suffix))!;
const change = (node: ReactElement<Record<string, unknown>>, value: string) => (node.props.onChange as (event: unknown) => void)(node.type === Select || node.type === ComboBox ? value : { target: { value } });
const click = (node: ReactElement<Record<string, unknown>>) => (node.props.onClick as () => void)();
const button = (tree: ReactNode, text: string) => elements(tree).find(node => node.type === 'button' && node.props.children === text)!;
const submit = (tree: ReactNode) => (elements(tree).find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
const stamp = '2026-01-01T00:00:00.000Z';
const baseProfile: OperatingProfile = { id: 'op_example', name: 'Example team', revision: 1, createdAt: stamp, updatedAt: stamp, personality: 'Shared style', defaults: {} };
const state = { profile: { id: 'default', name: 'Default' }, workspaces: [{ id: 'w_example', profileId: 'default', name: 'Example project', providerProfileId: 'c_example', createdAt: stamp, updatedAt: stamp }], connections: [{ id: 'c_example', name: 'Example connection', model: 'model-a' }], sessions: [] } as unknown as HostState;
function fixture(profiles: OperatingProfile[] = []) {
  const agents = { listOperatingProfiles: vi.fn(async () => profiles), saveOperatingProfile: vi.fn(async () => baseProfile), deleteOperatingProfile: vi.fn(async () => undefined), getState: vi.fn(async () => state), runtimes: vi.fn(async () => []) } as unknown as AgentHostApi;
  return { t: MESSAGES.en, agents, state, onState: vi.fn(), onCatalogChanged: vi.fn() };
}
beforeEach(() => { hooks.pending = []; });

describe('operating profile editors', () => {
  it('uses library selects with labeled, reversible inheritance choices and real saved connection choices', async () => {
    for (const t of [MESSAGES.en, MESSAGES.id]) {
      const props = { ...fixture(), t }, page = mount(OperatingProfilesSection, props);
      page.draw(); await flush(); click(button(page.draw(), t.operatingProfiles.add));
      let tree = page.draw();
      expect(elements(tree).some(node => node.type === 'select')).toBe(false);
      expect(input(tree, '-connection').type).toBe(Select);
      expect(input(tree, '-connection').props).toMatchObject({ label: t.operatingProfiles.connection, value: '', options: [
        { value: '', label: t.operatingProfiles.inheritConnection }, { value: 'c_example', label: 'Example connection' },
      ] });
      change(input(tree, '-model'), 'custom-model'); change(input(page.draw(), '-connection'), 'c_example');
      tree = page.draw(); expect(input(tree, '-model').props.value).toBe('');
      change(input(tree, '-effort'), 'high'); expect(input(page.draw(), '-effort').props.value).toBe('high');
      change(input(page.draw(), '-effort'), ''); change(input(page.draw(), '-connection'), '');
      change(input(page.draw(), '-team-mode'), 'solo'); change(input(page.draw(), '-team-mode'), 'inherit');
      change(input(page.draw(), '-name'), 'Inherited profile'); submit(page.draw()); await flush();
      expect(props.agents.saveOperatingProfile).toHaveBeenCalledWith(expect.objectContaining({ defaults: { lead: { role: '', task: '' } } }));
      page.close();
    }
  });
  it('shows a missing saved connection without silently assigning a different one', async () => {
    const props = fixture([{ ...baseProfile, defaults: { connectionId: 'removed-connection', model: 'retained-model' } }]);
    const page = mount(OperatingProfilesSection, props); page.draw(); await flush(); click(button(page.draw(), props.t.common.edit));
    const tree = page.draw();
    expect(input(tree, '-connection').props.value).toBe('removed-connection');
    expect(input(tree, '-connection').props.options).toContainEqual({ value: 'removed-connection', label: props.t.settings.missingConnection, disabled: true });
    expect(input(tree, '-model').props.value).toBe('retained-model'); page.close();
  });
  it('saves explicit profile data once, preserves failed drafts and refreshes project defaults after persistence', async () => {
    const props = fixture(), page = mount(OperatingProfilesSection, props);
    page.draw(); await flush(); click(button(page.draw(), props.t.operatingProfiles.add));
    let tree = page.draw(); change(input(tree, '-name'), 'Review team'); change(input(tree, '-purpose'), 'Build carefully');
    for (const suffix of ['-name', '-role']) expect(input(tree, suffix).props.type).toBe('text');
    expect(input(tree, '-model').type).toBe(ComboBox);
    expect(input(tree, '-model').props).toMatchObject({ maxLength: 200, disabled: false, customLabel: props.t.connection.modelCustom });
    tree = page.draw(); submit(tree); submit(tree); await flush();
    expect(props.agents.saveOperatingProfile).toHaveBeenCalledTimes(1);
    expect(props.agents.saveOperatingProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Review team', purpose: 'Build carefully' }));
    expect(props.onState).toHaveBeenCalledWith(state);
    expect(props.onCatalogChanged).toHaveBeenCalledOnce();
    click(button(page.draw(), props.t.operatingProfiles.add)); tree = page.draw(); change(input(tree, '-name'), 'Keep my draft');
    vi.mocked(props.agents.saveOperatingProfile!).mockRejectedValueOnce(new Error('Profile changed. Refresh.'));
    submit(page.draw()); await flush(); tree = page.draw();
    expect(input(tree, '-name').props.value).toBe('Keep my draft');
    expect(elements(tree).some(node => node.props.role === 'alert' && node.props.children === 'Profile changed. Refresh.')).toBe(true);
    page.close();
  });
  it('edits team members as a draft using a real catalog project without project-save callbacks', async () => {
    const props = fixture(), page = mount(OperatingProfilesSection, props);
    page.draw(); await flush(); click(button(page.draw(), props.t.operatingProfiles.add));
    change(input(page.draw(), '-team-mode'), 'team'); click(button(page.draw(), props.t.operatingProfiles.configureTeam));
    const team = elements(page.draw()).find(node => node.type === TeamSetupDialog)!;
    expect(team.props).toMatchObject({ scope: 'draft', profileDraft: true, workspaceId: 'w_example' });
    expect(team.props.onState).toBeUndefined();
    expect(props.agents.saveOperatingProfile).not.toHaveBeenCalled(); page.close();
  });
  it('refreshes profiles read-only without replacing an open draft or its reviewed revision', async () => {
    const props = fixture([baseProfile]), page = mount(OperatingProfilesSection, props);
    page.draw(); await flush(); click(button(page.draw(), props.t.common.edit));
    change(input(page.draw(), '-name'), 'Keep this edit');
    vi.mocked(props.agents.listOperatingProfiles!).mockResolvedValue([{ ...baseProfile, revision: 2, name: 'New saved version' }]);
    click(button(page.draw(), props.t.operatingProfiles.refreshList)); await flush();
    const tree = page.draw();
    expect(input(tree, '-name').props.value).toBe('Keep this edit');
    expect(props.agents.saveOperatingProfile).not.toHaveBeenCalled();
    expect(props.onCatalogChanged).toHaveBeenCalledOnce();
    expect(elements(tree).some(node => node.props.role === 'status' && node.props.children === props.t.operatingProfiles.refreshed)).toBe(true);
    submit(tree); await flush();
    expect(props.agents.saveOperatingProfile).toHaveBeenCalledWith(expect.objectContaining({ id: baseProfile.id, expectedRevision: 1, name: 'Keep this edit' }));
    page.close();
  });
  it('drops late list/save responses after the host context is retired', async () => {
    const props = fixture(); let complete!: (profile: OperatingProfile) => void;
    vi.mocked(props.agents.saveOperatingProfile!).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const page = mount(OperatingProfilesSection, props); page.draw(); await flush(); click(button(page.draw(), props.t.operatingProfiles.add)); change(input(page.draw(), '-name'), 'Private draft'); submit(page.draw());
    page.close(); complete(baseProfile); await flush();
    expect(props.onState).not.toHaveBeenCalled(); expect(props.agents.getState).not.toHaveBeenCalled();
  });
  it('resets workspace overrides explicitly and keeps unsupported runtimes disabled', async () => {
    const props = fixture([baseProfile]); props.agents.setWorkspaceOperatingProfile = vi.fn(async () => state);
    const workspace = { ...state.workspaces[0]!, operatingProfileId: baseProfile.id, operatingProfileOverrides: { model: 'custom-model' } };
    const page = mount(WorkspaceProfilePicker, { ...props, workspace, profiles: [baseProfile] });
    click(button(page.draw(), props.t.operatingProfiles.reset)); await flush();
    expect(props.agents.setWorkspaceOperatingProfile).toHaveBeenCalledWith(workspace.id, { profileId: baseProfile.id, overrides: {} });
    const tree = page.draw({ workspace: { ...workspace, runtimeId: 'hermes' } });
    expect(elements(tree).find(node => node.type === Select)?.props.disabled).toBe(true); page.close();
  });
  it('preserves the empty workspace profile choice and discards a prior host assignment reply', async () => {
    const props = fixture([baseProfile]); let resolve!: (value: HostState) => void;
    props.agents.setWorkspaceOperatingProfile = vi.fn(() => new Promise<HostState>(complete => { resolve = complete; }));
    const page = mount(WorkspaceProfilePicker, { ...props, workspace: state.workspaces[0]!, profiles: [baseProfile] });
    const picker = elements(page.draw()).find(node => node.type === Select)!;
    expect(picker.props.value).toBe('');
    expect(picker.props.options).toContainEqual({ value: '', label: props.t.operatingProfiles.noProfile });
    change(picker, baseProfile.id); change(picker, baseProfile.id);
    expect(props.agents.setWorkspaceOperatingProfile).toHaveBeenCalledOnce();
    page.draw({ agents: { ...props.agents } }); resolve(state); await flush();
    expect(props.onState).not.toHaveBeenCalled(); page.close();
  });
  it('guards duplicate project saves, freezes inputs while saving and ignores a retired owner reply', async () => {
    const props = fixture(); props.state = { ...state, workspaces: [{ ...state.workspaces[0]!, projectLocation: '/projects/example' }] };
    let resolve!: (value: HostState) => void;
    props.agents.saveWorkspace = vi.fn(() => new Promise<HostState>(complete => { resolve = complete; }));
    const page = mount(WorkspacesSection, props); let tree = page.draw();
    click(elements(tree).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(props.t.common.edit))!);
    tree = page.draw(); submit(tree); submit(tree);
    expect(props.agents.saveWorkspace).toHaveBeenCalledOnce();
    tree = page.draw();
    expect(elements(tree).find(node => node.type === 'fieldset' && node.props.className === 'workspace-editor-fields')?.props.disabled).toBe(true);
    page.close(); resolve(state); await flush(); expect(props.onState).not.toHaveBeenCalled();
  });
  it('waits for selected folder validation before allowing project submission', async () => {
    const props = fixture(); props.state = { ...state, workspaces: [{ ...state.workspaces[0]!, projectLocation: '/projects/example' }] };
    props.agents.saveWorkspace = vi.fn(async () => props.state);
    const page = mount(WorkspacesSection, props); let tree = page.draw();
    click(elements(tree).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(props.t.common.edit))!);
    tree = page.draw();
    const fields = elements(tree).find(node => node.type === WorkspaceForm)!;
    const pending = fields.props.onValidationBusyChange as (busy: boolean) => void;
    pending(true); tree = page.draw();
    expect(button(tree, props.t.common.save).props.disabled).toBe(true);
    submit(tree); expect(props.agents.saveWorkspace).not.toHaveBeenCalled();
    pending(false); tree = page.draw();
    expect(button(tree, props.t.common.save).props.disabled).toBe(false);
    submit(tree); await flush(); expect(props.agents.saveWorkspace).toHaveBeenCalledOnce();
    page.close();
  });
  it('picks both project locations through host browsing and validates them before updating the draft', async () => {
    const props = fixture(), onChange = vi.fn();
    props.agents.checkFolder = vi.fn(async path => ({ ok: true, path, name: path.split('/').at(-1)! }));
    const page = mount(WorkspaceForm, { t: props.t, agents: props.agents, draft: emptyWorkspaceDraft('c_example'), onChange });
    let tree = page.draw();
    expect(elements(tree).filter(node => node.type === 'input').some(node => String(node.props.id).endsWith('-folder-input') || String(node.props.id).endsWith('-additional-path'))).toBe(false);
    click(input(tree, '-folder'));
    let browser = elements(page.draw()).find(node => node.type === DirectoryBrowser)!;
    (browser.props.onSelect as (path: string) => void)('/projects/primary'); await flush();
    let draft = onChange.mock.lastCall![0] as WorkspaceDraft;
    expect(draft.folder?.path).toBe('/projects/primary');
    tree = page.draw({ draft });
    const add = elements(tree).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(props.t.workspace.additionalFolders.add))!;
    click(add); browser = elements(page.draw()).find(node => node.type === DirectoryBrowser)!;
    (browser.props.onSelect as (path: string) => void)('/projects/shared'); await flush();
    draft = onChange.mock.lastCall![0] as WorkspaceDraft;
    expect(draft.additionalProjectLocations).toEqual(['/projects/shared']);
    expect(props.agents.checkFolder).toHaveBeenNthCalledWith(1, '/projects/primary');
    expect(props.agents.checkFolder).toHaveBeenNthCalledWith(2, '/projects/shared'); page.close();
  });
  it('refetches a structurally shared project catalog explicitly while retaining an unrelated form draft', async () => {
    const props = fixture(), page = mount(WorkspacesSection, { ...props, profileCatalogRevision: 0 });
    page.draw(); await flush();
    let tree = page.draw();
    expect(elements(tree).find(node => node.type === WorkspaceProfilePicker)?.props.profiles).toEqual([]);
    const edit = elements(tree).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(props.t.common.edit))!;
    click(edit); tree = page.draw();
    const form = elements(tree).find(node => node.type === WorkspaceForm)!;
    (form.props.onChange as (draft: WorkspaceDraft) => void)({ ...(form.props.draft as WorkspaceDraft), name: 'Keep this project draft' });
    vi.mocked(props.agents.listOperatingProfiles!).mockResolvedValue([baseProfile]);
    page.draw({ profileCatalogRevision: 1, state }); await flush();
    tree = page.draw();
    expect(props.agents.listOperatingProfiles).toHaveBeenCalledTimes(2);
    expect((elements(tree).find(node => node.type === WorkspaceForm)!.props.draft as WorkspaceDraft).name).toBe('Keep this project draft');
    click(button(tree, props.t.common.cancel));
    expect(elements(page.draw()).find(node => node.type === WorkspaceProfilePicker)?.props.profiles).toEqual([baseProfile]);
    expect(props.state.workspaces).toBe(state.workspaces); page.close();
  });
  it('saves individual lead inheritance as a full replacement and refuses edits during active work', async () => {
    const props = fixture();
    const snapshot: SessionOperatingProfile = { id: baseProfile.id, name: baseProfile.name, revision: 1, personality: 'Shared style', lead: { role: 'Lead', soul: 'Own style' } };
    props.agents.getSessionOperatingProfile = vi.fn(async () => snapshot);
    props.agents.saveSessionOperatingProfile = vi.fn(async (_id, value) => ({ ...snapshot, lead: value.lead ?? undefined }));
    const page = mount(SessionPersonaEditor, { t: props.t, agents: props.agents, sessionId: 's_example', running: false });
    page.draw(); await flush(); let tree = page.draw();
    expect(input(tree, '-role').props.type).toBe('text');
    const inherit = elements(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
    (inherit.props.onChange as (event: unknown) => void)({ target: { checked: true } }); submit(page.draw()); await flush();
    expect(props.agents.saveSessionOperatingProfile).toHaveBeenCalledWith('s_example', { lead: { role: 'Lead' } });
    tree = page.draw({ running: true });
    expect(button(tree, props.t.common.save).props.disabled).toBe(true);
    submit(tree); await flush(); expect(props.agents.saveSessionOperatingProfile).toHaveBeenCalledTimes(1); page.close();
  });
});
