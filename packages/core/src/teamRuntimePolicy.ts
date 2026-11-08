import type { AgentTeam } from './teams.js';
import { MAX_TEAM_MEMBERS } from './teams.js';

/** Upstream default when the selected profile omits delegation.oneshot_max_children. */
export const MAX_HERMES_ONESHOT_TEAM_MEMBERS = 2;
/** Extalia's roster ceiling, separate from Hermes' configurable total and batch budgets. */
export const MAX_HERMES_TEAM_MEMBERS = MAX_TEAM_MEMBERS;

export interface HermesTeamLimits {
  maxTeamMembers: number;
  maxConcurrentChildren: number;
  /** Total children in one --oneshot run; 0 means Hermes imposes no total cap. */
  oneshotMaxChildren: number;
}

export function assertHermesTeamCapacity(team: AgentTeam | null | undefined, limits: Pick<HermesTeamLimits, 'maxTeamMembers'> = { maxTeamMembers: MAX_HERMES_ONESHOT_TEAM_MEMBERS }): void {
  const maximum = Math.min(MAX_HERMES_TEAM_MEMBERS, limits.maxTeamMembers);
  if (team?.enabled && team.members.length > maximum) {
    throw new Error(`The active Hermes profile supports at most ${maximum} team members per one-shot turn in Extalia. Reduce the team or review the profile's delegation.oneshot_max_children setting.`);
  }
}
