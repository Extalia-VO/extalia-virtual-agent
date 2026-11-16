import { normalizeKnowledgeMemoryImportRequest, normalizeKnowledgeVaultRoot, normalizeWorkspaceKnowledgeRequest,
  type AgentHostApi, type HostState, type KnowledgeStatus, type KnowledgeVaultSettings } from '@extalia/platform';
import { createMockKnowledge } from './mockKnowledge';

type Index = ReturnType<typeof createMockKnowledge>;
type Settings = Pick<Required<AgentHostApi>, 'knowledgeSettings' | 'setKnowledgeVaultRoot'>;
type Profiles = Pick<Required<AgentHostApi>, 'listVaultProfiles' | 'saveVaultProfile'>;

/** Development-only vaults stay separate in memory, just as the real host scopes its indexes. */
export function createMockWorkspaceKnowledge(options: {
  state: HostState; initial: Index; settings: Settings; profiles: Profiles; latency(): Promise<void>; busy(): boolean;
}): Pick<Required<AgentHostApi>, 'workspaceKnowledge'> {
  const defaultRoot = `${options.state.dataDirectory}/vaults/default`;
  const key = (profileId: string, root: string) => JSON.stringify([profileId, root]);
  const indexes = new Map<string, Index>([[key(options.state.profile.id, defaultRoot), options.initial]]);
  const label = (root: string, managed: boolean, profileId: string) => managed
    ? `vaults/${profileId === options.state.profile.id ? 'default' : profileId}`
    : `custom:${root.split(/[\\/]+/).filter(Boolean).at(-1) ?? ''}`;
  return {
    async workspaceKnowledge(workspaceId, method, args, expectedBinding) {
      const request = normalizeWorkspaceKnowledgeRequest(workspaceId, method, args, expectedBinding);
      const catalog = await options.profiles.listVaultProfiles();
      const workspace = catalog.workspaces.find(item => item.id === request.workspaceId);
      const profile = catalog.profiles.find(item => item.id === workspace?.profileId);
      if (!profile) throw new Error('That workspace vault profile no longer exists.');
      if (request.expectedBinding && (request.expectedBinding.profileId !== profile.id || request.expectedBinding.root !== profile.root))
        throw new Error('The workspace Knowledge vault changed. Refresh it before continuing.');
      const currentLabel = label(profile.root, profile.kind !== 'custom' && profile.root.startsWith(`${options.state.dataDirectory}/vaults/`), profile.id);
      if (request.method === 'knowledgeSettings') return {
        kind: currentLabel.startsWith('vaults/') ? 'default' : 'custom', label: currentLabel,
        ...(!currentLabel.startsWith('vaults/') ? { path: profile.root } : {}), available: true,
        obsidian: /obsidian/i.test(profile.root), watch: profile.id === catalog.defaultProfileId ? 'watching' : 'off',
      } satisfies KnowledgeVaultSettings;
      if (request.method === 'setKnowledgeVaultRoot') {
        if (options.busy()) throw new Error('Agent work is active. Finish it before changing vault folders.');
        const root = normalizeKnowledgeVaultRoot(request.args[0]);
        if (profile.id === catalog.defaultProfileId) {
          const selected = root ?? defaultRoot;
          if (catalog.profiles.some(item => item.id !== profile.id && (item.root === selected || item.root.startsWith(`${selected}/`) || selected.startsWith(`${item.root}/`))))
            throw new Error('Vault folders cannot overlap.');
          return options.settings.setKnowledgeVaultRoot(root);
        }
        const next = await options.profiles.saveVaultProfile({ id: profile.id, name: profile.name, vaultRoot: root,
          workspaceIds: profile.workspaceIds, minutesEnabled: profile.minutesEnabled, automaticLearning: profile.automaticLearning,
          expectedRevision: catalog.revision });
        const saved = next.profiles.find(item => item.id === profile.id)!;
        return { kind: saved.kind === 'custom' ? 'custom' : 'default', label: label(saved.root, saved.kind !== 'custom', saved.id),
          ...(saved.kind === 'custom' ? { path: saved.root } : {}), available: true, obsidian: /obsidian/i.test(saved.root), watch: 'off' } satisfies KnowledgeVaultSettings;
      }
      if (request.method === 'importMemoryNotes') {
        const input = normalizeKnowledgeMemoryImportRequest(request.args[0]);
        if (!profile.workspaceIds.includes(input.workspaceId)) throw new Error('Choose a workspace assigned to this vault profile.');
      }
      const identity = key(profile.id, profile.root);
      let index = indexes.get(identity);
      if (!index) { index = createMockKnowledge('empty', options.latency); indexes.set(identity, index); }
      const action = (index as Partial<AgentHostApi>)[request.method];
      if (typeof action !== 'function') throw new Error('Unsupported workspace Knowledge action.');
      const result = await (action as (...input: unknown[]) => Promise<unknown>)(...request.args);
      if (request.method === 'knowledgeStatus') return { ...(result as KnowledgeStatus), vaultRoot: currentLabel };
      if (request.method === 'syncKnowledge') {
        const sync = result as Awaited<ReturnType<Required<AgentHostApi>['syncKnowledge']>>;
        return { ...sync, status: { ...sync.status, vaultRoot: currentLabel } };
      }
      return result;
    },
  };
}
