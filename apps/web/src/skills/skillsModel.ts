import { normalizeBuiltinSkills, type AgentHostApi, type BuiltinSkillInfo, type HostState } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { projectSkillsSupported } from './ProjectSkills';
import { needsUserDecision, skillRegistryMode } from './skillCenterModel';

/**
 * Skills page model: the built-in skill list, and the number of skills waiting for the user (the nav badge).
 * Both reuse the calls the page already makes; nothing polls.
 */

type Workspace = Pick<HostState['workspaces'][number], 'id' | 'projectLocation'>;

/**
 * The host's built-in skills, validated. `null` while loading and when the host does not list them (an older host
 * without the method, or one that refuses it): the section is then hidden.
 */
export function useBuiltinSkills(agents: AgentHostApi): { skills: BuiltinSkillInfo[] | null; loading: boolean } {
  const supported = typeof agents.builtinSkills === 'function';
  const [loaded, setLoaded] = useState<{ agents: AgentHostApi; skills: BuiltinSkillInfo[] | null } | null>(null);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    loadBuiltinSkills(agents).then(skills => { if (live) setLoaded({ agents, skills }); });
    return () => { live = false; };
  }, [agents, supported]);
  const current = loaded?.agents === agents ? loaded : null;
  return { skills: current?.skills ?? null, loading: supported && !current };
}

export async function loadBuiltinSkills(agents: AgentHostApi): Promise<BuiltinSkillInfo[] | null> {
  if (typeof agents.builtinSkills !== 'function') return null;
  try { return normalizeBuiltinSkills(await agents.builtinSkills()); } catch { return null; }
}

/**
 * Skills that wait for the user: with the native core, revisions to review or approve; otherwise pending project
 * skills over every workspace with a folder. Failures count as zero (the badge is a hint, the page is the truth).
 */
export async function skillsWaitingCount(agents: AgentHostApi, workspaces: readonly Workspace[]): Promise<number> {
  if (await skillRegistryMode(agents) === 'registry') {
    const report = await agents.skillRegistry().catch(() => null);
    return report?.mode === 'registry' && report.status === 'ready' ? report.revisions.filter(needsUserDecision).length : 0;
  }
  if (!projectSkillsSupported(agents)) return 0;
  const counts = await Promise.all(workspaces.filter(workspace => workspace.projectLocation)
    .map(workspace => agents.workspaceSkills(workspace.id).then(report => report.pending.length, () => 0)));
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * The nav badge count. Recomputed when the workspaces (ids and folders) change, when `refresh` changes (after an
 * action on the Skills page) and when the Skills page is entered or left (`onPage`); never on a timer.
 */
export function useSkillsWaiting(agents: AgentHostApi | undefined, workspaces: readonly Workspace[] | undefined, refresh: number, onPage: boolean): number {
  const key = (workspaces ?? []).map(workspace => `${workspace.id}\n${workspace.projectLocation ?? ''}`).join('\n\n');
  const [count, setCount] = useState<{ agents: AgentHostApi; key: string; count: number } | null>(null);
  useEffect(() => {
    if (!agents || !workspaces) return;
    let live = true;
    skillsWaitingCount(agents, workspaces).then(next => { if (live) setCount({ agents, key, count: next }); }, () => undefined);
    return () => { live = false; };
    // `workspaces` is read through `key`, so a new state object with the same workspaces does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, key, refresh, onPage]);
  return count && count.agents === agents && count.key === key ? count.count : 0;
}
