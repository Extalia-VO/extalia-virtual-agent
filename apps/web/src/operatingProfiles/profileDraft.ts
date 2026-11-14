import type { AgentTeam, Effort, OperatingProfile, Workspace } from '@extalia/core';
import { normalizeOperatingProfileInput, type OperatingProfileInput, type WorkspaceInput } from '@extalia/platform';

export interface ProfileDraft {
  id?: string; expectedRevision?: number; createRequestId?: string;
  name: string; purpose: string; personality: string; connectionId: string; model: string; effort: Effort | '';
  leadRole: string; leadTask: string; leadSoul: string; inheritPersonality: boolean;
  team: AgentTeam | null | undefined;
}
export function profileDraft(profile?: OperatingProfile): ProfileDraft {
  const lead = profile?.defaults.lead;
  return {
    ...(profile ? { id: profile.id, expectedRevision: profile.revision } : { createRequestId: crypto.randomUUID() }),
    name: profile?.name ?? '', purpose: profile?.purpose ?? '', personality: profile?.personality ?? '',
    connectionId: profile?.defaults.connectionId ?? '', model: profile?.defaults.model ?? '', effort: profile?.defaults.effort ?? '',
    leadRole: lead?.role ?? '', leadTask: lead?.task ?? '', leadSoul: lead?.soul ?? '', inheritPersonality: lead?.soul === undefined,
    team: profile?.defaults.team === undefined ? undefined : structuredClone(profile.defaults.team),
  };
}
export function profileInput(draft: ProfileDraft): OperatingProfileInput {
  return normalizeOperatingProfileInput({
    ...(draft.id ? { id: draft.id, expectedRevision: draft.expectedRevision } : { createRequestId: draft.createRequestId }),
    name: draft.name, purpose: draft.purpose, personality: draft.personality,
    defaults: {
      ...(draft.connectionId ? { connectionId: draft.connectionId } : {}),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}), ...(draft.effort ? { effort: draft.effort } : {}),
      lead: { role: draft.leadRole, task: draft.leadTask, ...(!draft.inheritPersonality ? { soul: draft.leadSoul } : {}) },
      ...(draft.team !== undefined ? { team: draft.team } : {}),
    },
  });
}

/** An unrelated project draft must not pin a profile default that changed while it was open. */
export function workspaceProfileInput(input: WorkspaceInput, workspace: Workspace | undefined, connectionEdited: boolean): WorkspaceInput {
  return workspace?.operatingProfileId && !connectionEdited && workspace.providerProfileId
    ? { ...input, connectionId: workspace.providerProfileId } : input;
}
