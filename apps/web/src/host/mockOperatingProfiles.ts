import { OPERATING_PROFILE_LIMITS, resolveOperatingProfile, type OperatingProfile, type SessionOperatingProfile, type Workspace } from '@extalia/core';
import { normalizeOperatingProfileInput, normalizeSessionOperatingProfileInput, normalizeWorkspaceOperatingProfile,
  type AgentHostApi, type HostState, type SessionOptions, type SessionSummary, type WorkspaceInput } from '@extalia/platform';

/** Development-only profiles use the same validated schema and snapshot boundaries. */
export function createMockOperatingProfiles(options: { state: HostState; snapshot(): HostState; latency(): Promise<void> }) {
  const profiles = new Map<string, OperatingProfile>();
  const sessions = new Map<string, SessionOperatingProfile>();
  const base = new Map<string, { connectionId?: string; team?: Workspace['team'] }>();
  let counter = 0;
  const workspace = (id: string) => {
    const result = options.state.workspaces.find(item => item.id === id);
    if (!result || result.mode === 'observe' || result.runtimeId === 'hermes') throw new Error('Choose a managed Extalia Native project.');
    return result;
  };
  const source = (item: Workspace) => item.operatingProfileId ? profiles.get(item.operatingProfileId) : undefined;
  const validate = (profile: OperatingProfile) => {
    const ids = [profile.defaults.connectionId, ...(profile.defaults.team?.connections ?? []).map(item => item.connectionId)].filter(Boolean);
    if (ids.some(id => !options.state.connections.some(item => item.id === id))) throw new Error('Choose a saved model connection.');
  };
  function apply(item: Workspace) {
    const defaults = resolveOperatingProfile(source(item), item.operatingProfileOverrides).defaults;
    const original = base.get(item.id);
    item.providerProfileId = defaults.connectionId ?? original?.connectionId ?? item.providerProfileId;
    const team = defaults.team === undefined ? original?.team : defaults.team;
    if (team) item.team = structuredClone(team); else delete item.team;
  }
  const api: Pick<Required<AgentHostApi>, 'listOperatingProfiles' | 'saveOperatingProfile' | 'deleteOperatingProfile' | 'setWorkspaceOperatingProfile' | 'getSessionOperatingProfile' | 'saveSessionOperatingProfile'> = {
    async listOperatingProfiles() { await options.latency(); return structuredClone([...profiles.values()]); },
    async saveOperatingProfile(raw) {
      await options.latency();
      const input = normalizeOperatingProfileInput(raw), previous = input.id ? profiles.get(input.id) : undefined;
      const created = input.createRequestId ? profiles.get(`op_${input.createRequestId}`) : undefined;
      if (created) {
        const payload = (value: Pick<OperatingProfile, 'name' | 'purpose' | 'personality' | 'defaults'>) => JSON.stringify({ name: value.name,
          ...(value.purpose !== undefined ? { purpose: value.purpose } : {}), ...(value.personality !== undefined ? { personality: value.personality } : {}), defaults: value.defaults });
        if (payload(created) !== payload(input)) throw new Error('The saved profile differs from this draft. Refresh before editing it.');
        return structuredClone(created);
      }
      if (input.id && (!previous || previous.revision !== input.expectedRevision)) throw new Error('Profile changed. Refresh before saving.');
      if (!previous && profiles.size >= OPERATING_PROFILE_LIMITS.profiles) throw new Error('Close an existing profile before adding another.');
      const stamp = new Date().toISOString();
      const saved: OperatingProfile = { id: previous?.id ?? (input.createRequestId ? `op_${input.createRequestId}` : `op_mock_${++counter}`), name: input.name, revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? stamp, updatedAt: stamp, defaults: input.defaults,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), ...(input.personality !== undefined ? { personality: input.personality } : {}) };
      validate(saved); profiles.set(saved.id, structuredClone(saved));
      for (const item of options.state.workspaces) if (item.operatingProfileId === saved.id) apply(item);
      return structuredClone(saved);
    },
    async deleteOperatingProfile(id, expectedRevision) {
      await options.latency();
      if (profiles.get(id)?.revision !== expectedRevision) throw new Error('Profile changed. Refresh before deleting.');
      if (options.state.workspaces.some(item => item.operatingProfileId === id)) throw new Error('Remove project assignments before deleting this profile.');
      profiles.delete(id);
    },
    async setWorkspaceOperatingProfile(id, raw) {
      await options.latency();
      const selected = normalizeWorkspaceOperatingProfile(raw), item = workspace(id);
      if (selected.profileId && !profiles.has(selected.profileId)) throw new Error('That agent profile no longer exists.');
      if (!base.has(id)) base.set(id, { connectionId: item.providerProfileId, ...(item.team ? { team: structuredClone(item.team) } : {}) });
      if (selected.profileId) {
        validate(profiles.get(selected.profileId)!); item.operatingProfileId = selected.profileId;
        item.operatingProfileOverrides = selected.overrides ?? {};
      } else { delete item.operatingProfileId; delete item.operatingProfileOverrides; }
      apply(item); item.updatedAt = new Date().toISOString();
      return options.snapshot();
    },
    async getSessionOperatingProfile(id) {
      await options.latency();
      const item = options.state.sessions.find(session => session.id === id);
      if (!item || item.control !== 'managed' || item.runtime) throw new Error('Choose a managed Extalia Native session.');
      return sessions.has(id) ? structuredClone(sessions.get(id)!) : undefined;
    },
    async saveSessionOperatingProfile(id, raw) {
      await options.latency();
      const input = normalizeSessionOperatingProfileInput(raw), item = options.state.sessions.find(session => session.id === id);
      if (!item || item.control !== 'managed' || item.runtime) throw new Error('Choose a managed Extalia Native session.');
      if (item.running) throw new Error('Finish the current work before editing this agent.');
      const value = structuredClone(sessions.get(id) ?? {});
      if (input.lead === null) delete value.lead;
      else if (input.lead !== undefined) value.lead = structuredClone(input.lead);
      sessions.set(id, value); return structuredClone(value);
    },
  };
  return {
    api,
    prepareSession(item: SessionSummary, project: Workspace, requested: SessionOptions) {
      if (!project.operatingProfileId && requested.operatingProfile === undefined) return;
      const resolved = resolveOperatingProfile(source(project), project.operatingProfileOverrides);
      const snapshot = resolved.snapshot;
      if (requested.operatingProfile?.lead === null) delete snapshot.lead;
      else if (requested.operatingProfile?.lead) snapshot.lead = { ...snapshot.lead, ...requested.operatingProfile.lead };
      sessions.set(item.id, snapshot);
      item.operatingProfile = snapshot.id ? { id: snapshot.id, name: snapshot.name, revision: snapshot.revision } : {};
      const { operatingProfile: _profile, ...options } = item.options ?? {};
      item.options = { ...(resolved.defaults.model ? { model: resolved.defaults.model } : {}), ...(resolved.defaults.effort ? { effort: resolved.defaults.effort } : {}), ...options };
    },
    beforeWorkspaceSave(item: Workspace | undefined, input: WorkspaceInput) {
      if (!item?.operatingProfileId) return;
      if (input.mode === 'observe' || input.runtimeId === 'hermes') throw new Error('Remove the agent profile before changing runtime.');
      if (input.connectionId !== undefined && input.connectionId !== item.providerProfileId) item.operatingProfileOverrides = { ...item.operatingProfileOverrides, connectionId: input.connectionId };
    },
    afterWorkspaceSave(item: Workspace) { if (item.operatingProfileId) apply(item); },
    savedWorkspaceTeam(item: Workspace, team: Workspace['team'] | null) {
      if (!item.operatingProfileId) return;
      item.operatingProfileOverrides = { ...item.operatingProfileOverrides, team: team ?? null }; apply(item);
    },
  };
}
