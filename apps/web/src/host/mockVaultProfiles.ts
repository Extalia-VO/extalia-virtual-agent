import { normalizeAutomaticLearningPolicy, normalizeKnowledgeVaultRoot, normalizeSaveVaultProfile, type AgentHostApi, type HostState, type VaultProfile, type VaultProfilesCatalog } from '@extalia/platform';

/** In-memory counterpart of workspace vault grouping; never touches the filesystem. */
export function createMockVaultProfiles(state: HostState, knowledge: Pick<Required<AgentHostApi>, 'knowledgeSettings'>, busy: () => boolean, latency: () => Promise<void>): Pick<Required<AgentHostApi>, 'listVaultProfiles' | 'saveVaultProfile'> {
  const saved = new Map<string, VaultProfile & { approvedRoot?: string; learningRoot?: string }>();
  let generation = 0;
  let previous = '';
  const list = async (): Promise<VaultProfilesCatalog> => {
    const setting = await knowledge.knowledgeSettings();
    const root = setting.path ?? `${state.dataDirectory}/vaults/default`;
    const base = saved.get(state.profile.id);
    const effectiveLearning = (profile: typeof base, selected: string) => {
      const policy = normalizeAutomaticLearningPolicy(profile?.automaticLearning);
      return { enabled: policy.enabled, skills: policy.enabled && policy.skills,
        notes: policy.enabled && policy.notes && profile?.learningRoot === selected };
    };
    const profiles: VaultProfile[] = [{ id: state.profile.id, name: base?.name ?? state.profile.name, kind: 'indexed', root,
      minutesEnabled: base?.minutesEnabled === false ? false : base?.approvedRoot === root || setting.kind === 'default', automaticLearning: effectiveLearning(base, root), workspaceIds: [] },
      ...[...saved.values()].filter(profile => profile.id !== state.profile.id).map(profile => ({ ...profile, automaticLearning: effectiveLearning(profile, profile.root) }))];
    for (const profile of profiles) profile.workspaceIds = state.workspaces.filter(workspace => workspace.profileId === profile.id).map(workspace => workspace.id);
    const stamp = JSON.stringify({ profiles, workspaces: state.workspaces.map(workspace => [workspace.id, workspace.profileId]) });
    if (stamp !== previous) { previous = stamp; generation++; }
    return { revision: `mock-vaults-${generation}`, defaultProfileId: state.profile.id, profiles,
      workspaces: state.workspaces.map(({ id, name, profileId }) => ({ id, name, profileId })) };
  };
  return {
    async listVaultProfiles() { await latency(); return structuredClone(await list()); },
    async saveVaultProfile(raw) {
      await latency();
      const input = normalizeSaveVaultProfile(raw);
      if (busy()) throw new Error('Agent work is active. Finish it before changing vault profiles.');
      const catalog = await list();
      if (input.expectedRevision !== catalog.revision) throw new Error('Vault profiles changed. Refresh before saving.');
      if (input.workspaceIds.some(id => !state.workspaces.some(workspace => workspace.id === id))) throw new Error('That workspace no longer exists.');
      const existing = input.id ? catalog.profiles.find(profile => profile.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('That vault profile no longer exists.');
      const id = existing?.id ?? `vp-${crypto.randomUUID()}`;
      const indexed = id === state.profile.id;
      if (indexed && input.vaultRoot !== null) throw new Error('Change the indexed vault with the Knowledge vault setting.');
      const chosen = indexed ? existing!.root : input.vaultRoot === null ? `${state.dataDirectory}/vaults/${id}` : normalizeKnowledgeVaultRoot(input.vaultRoot)!;
      if (catalog.profiles.some(profile => profile.id !== id && (profile.root === chosen || profile.root.startsWith(`${chosen}/`) || chosen.startsWith(`${profile.root}/`)))) throw new Error('Vault folders cannot overlap.');
      if (catalog.profiles.some(profile => profile.id !== id && profile.name.toLowerCase() === input.name.toLowerCase())) throw new Error('Choose a distinct profile name.');
      const previous = saved.get(id);
      const automaticLearning = input.automaticLearning ?? normalizeAutomaticLearningPolicy(previous?.automaticLearning);
      const learningRoot = input.automaticLearning === undefined ? previous?.learningRoot : automaticLearning.enabled && automaticLearning.notes ? chosen : undefined;
      saved.set(id, { id, name: input.name, root: chosen, kind: indexed ? 'indexed' : input.vaultRoot ? 'custom' : 'managed', minutesEnabled: input.minutesEnabled, automaticLearning,
        ...(learningRoot !== undefined ? { learningRoot } : {}),
        ...(indexed && input.minutesEnabled ? { approvedRoot: chosen } : {}), workspaceIds: input.workspaceIds });
      for (const workspace of state.workspaces) {
        if (input.workspaceIds.includes(workspace.id)) workspace.profileId = id;
        else if (workspace.profileId === id && !indexed) workspace.profileId = state.profile.id;
      }
      return structuredClone(await list());
    },
  };
}
