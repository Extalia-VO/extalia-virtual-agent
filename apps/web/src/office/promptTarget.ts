import type { HostState, ModelChoices, SessionOptions, SessionSummary } from '@extalia/platform';
import type { ComboOption } from '../ui/ComboBox';
import type { OfficeAgent } from './presence';

export type PromptOptions = SessionOptions;
export type PromptModelChoices = ModelChoices;

/** Sessions the dock can continue: managed sessions of one workspace, newest first. Observed sessions are read-only. */
export function latestWorkspaceSession(sessions: readonly SessionSummary[], workspaceId: string | undefined): SessionSummary | undefined {
  if (!workspaceId) return undefined;
  let latest: SessionSummary | undefined;
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId || session.control !== 'managed') continue;
    if (!latest || session.lastActiveAt.localeCompare(latest.lastActiveAt) > 0) latest = session;
  }
  return latest;
}

export type DockTarget = { kind: 'new'; workspaceId: string } | { kind: 'continue'; session: SessionSummary };

/** Resolves the dock's target choice; "continue" falls back to a new session when the workspace has none. */
export function resolveDockTarget(mode: 'new' | 'continue', sessions: readonly SessionSummary[], workspaceId: string): DockTarget {
  const session = mode === 'continue' ? latestWorkspaceSession(sessions, workspaceId) : undefined;
  return session ? { kind: 'continue', session } : { kind: 'new', workspaceId };
}

/** Empty fields mean "the default"; trims the model id. */
export function normalizeOptions(options: PromptOptions | undefined): PromptOptions {
  const model = options?.model?.trim();
  return { ...(model ? { model } : {}), ...(options?.effort ? { effort: options.effort } : {}) };
}

/** The options to send with `setSessionOptions`, or `undefined` when the session already uses them. */
export function optionsChange(current: PromptOptions | undefined, wanted: PromptOptions): PromptOptions | undefined {
  const a = normalizeOptions(current);
  const b = normalizeOptions(wanted);
  return a.model === b.model && a.effort === b.effort ? undefined : b;
}

/** Whether a prompt can go into this session now; managed sessions refuse a second prompt while a turn runs. */
export function promptAvailability(session: SessionSummary | undefined): 'ready' | 'busy' | 'read-only' | 'missing' {
  if (!session) return 'missing';
  if (session.control !== 'managed') return 'read-only';
  return session.running ? 'busy' : 'ready';
}

/** Model suggestions like the Hermes model field: "Default (x)" first (empty value), then models grouped by provider prefix. */
export function modelComboOptions(choices: PromptModelChoices | undefined, labels: { useDefault(model?: string): string; defaultBadge: string; otherGroup: string }): ComboOption[] {
  if (!choices) return [];
  // One heading per provider: groups keep the order in which they first appear.
  const groups = new Map<string, ComboOption[]>();
  for (const model of new Set(choices.models)) {
    const group = model.includes('/') ? model.split('/')[0]! : labels.otherGroup;
    const list = groups.get(group) ?? [];
    list.push({ value: model, label: model, group, ...(model === choices.defaultModel ? { badge: labels.defaultBadge } : {}) });
    groups.set(group, list);
  }
  return [
    { value: '', label: labels.useDefault(choices.defaultModel), ...(choices.defaultModel ? { description: choices.defaultModel, badge: labels.defaultBadge } : {}) },
    ...[...groups.values()].flat(),
  ];
}

/** Managed sessions of a workspace the dock can continue, newest first. */
export function workspaceTargets(sessions: readonly SessionSummary[], workspaceId: string | undefined, limit = 8): SessionSummary[] {
  return sessions.filter(session => session.workspaceId === workspaceId && session.control === 'managed')
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, limit);
}

/** Where a prompt to a selected character goes: its session's lead agent. Observed characters are never prompt targets. */
export function promptTargetFor(agent: Pick<OfficeAgent, 'sessionId' | 'control' | 'parentId' | 'displayName'>, sessions: readonly SessionSummary[]):
  { sessionId: string; viaWorker?: string } | undefined {
  const session = sessions.find(item => item.id === agent.sessionId);
  if (!session || session.control !== 'managed') return undefined;
  return { sessionId: session.id, ...(agent.parentId ? { viaWorker: agent.displayName } : {}) };
}

/** The model a session's next turn uses: its override, else the workspace's Hermes model or the connection's model. */
export function sessionModel(state: Pick<HostState, 'workspaces' | 'connections'>, session: SessionSummary | undefined): string | undefined {
  if (!session || session.control !== 'managed') return undefined;
  if (session.options?.model) return session.options.model;
  if (session.runtime?.id === 'hermes') return state.workspaces.find(item => item.id === session.workspaceId)?.runtimeModel || undefined;
  return state.connections.find(item => item.id === session.connectionId)?.model || undefined;
}
