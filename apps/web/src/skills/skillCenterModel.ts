import type {
  AgentHostApi, SkillActionResult, SkillApprovalInput, SkillImportSource, SkillRegistryReport, SkillReviewInput, SkillRevisionState, SkillRevisionSummary,
} from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';

/**
 * Skill Security Center model (W3): feature detection, grouping and the actions each lifecycle state offers.
 * The UI only displays the Rust core's decisions and sends the user's choices with the digests it showed
 * (ADR 0026 decision 7); the daemon re-checks every one of them.
 */

export type SkillCenterHost = Pick<AgentHostApi,
  'skillRegistry' | 'inspectSkill' | 'importSkill' | 'reviewSkill' | 'approveSkill' | 'activateSkill' | 'deactivateSkill' | 'rollbackSkill' | 'revokeSkill'>;
const METHODS = ['skillRegistry', 'inspectSkill', 'importSkill', 'reviewSkill', 'approveSkill', 'activateSkill', 'deactivateSkill', 'rollbackSkill', 'revokeSkill'] as const;

export function skillCenterSupported(agents: AgentHostApi): boolean {
  const host = agents as Partial<SkillCenterHost>;
  return METHODS.every(method => typeof host[method] === 'function');
}

/**
 * The registry mode of a host, asked once per host object (the native core flag is fixed while a host runs).
 * An older host that refuses the method counts as `legacy`, so W0 project-skill consent stays visible.
 */
const modes = new WeakMap<AgentHostApi, Promise<SkillRegistryReport['mode']>>();
export function skillRegistryMode(agents: AgentHostApi): Promise<SkillRegistryReport['mode']> {
  let mode = modes.get(agents);
  if (!mode) {
    mode = skillCenterSupported(agents) ? agents.skillRegistry().then(report => report.mode, () => 'legacy' as const) : Promise.resolve('legacy' as const);
    modes.set(agents, mode);
  }
  return mode;
}

/** `null` while unknown. W0 panels hide themselves only once the host says `registry`. */
export function useSkillRegistryMode(agents: AgentHostApi): SkillRegistryReport['mode'] | null {
  const [mode, setMode] = useState<{ agents: AgentHostApi; mode: SkillRegistryReport['mode'] } | null>(null);
  useEffect(() => {
    let live = true;
    void skillRegistryMode(agents).then(next => { if (live) setMode({ agents, mode: next }); });
    return () => { live = false; };
  }, [agents]);
  return mode?.agents === agents ? mode.mode : null;
}

/** The first 12 hex characters; the full value goes in the tooltip. */
export const shortDigest = (hex: string) => hex.slice(0, 12);

export interface SkillPackageGroup {
  packageId: string;
  origin: SkillRevisionSummary['origin'];
  /** The revision the package's activation pointer names. */
  active?: SkillRevisionSummary;
  /** Newest first. */
  revisions: SkillRevisionSummary[];
}

/** Revisions grouped by package (packages by id), newest revision first. */
export function groupSkillPackages(revisions: readonly SkillRevisionSummary[]): SkillPackageGroup[] {
  const groups = new Map<string, SkillPackageGroup>();
  for (const revision of revisions) {
    const group = groups.get(revision.packageId) ?? { packageId: revision.packageId, origin: revision.origin, revisions: [] };
    group.revisions.push(revision);
    if (revision.active) group.active = revision;
    groups.set(revision.packageId, group);
  }
  for (const group of groups.values()) {
    group.revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.revisionId < b.revisionId ? -1 : 1));
    group.origin = group.revisions[0]!.origin;
  }
  return [...groups.values()].sort((a, b) => (a.packageId < b.packageId ? -1 : 1));
}

export type SkillRevisionAction = 'review' | 'approve' | 'activate' | 'deactivate' | 'rollback' | 'revoke';

/**
 * What the user may ask for in each state. Offering an action is not deciding it: the daemon refuses anything the
 * lifecycle, the attestation or the digests do not allow.
 */
export function revisionActions(revision: SkillRevisionSummary): SkillRevisionAction[] {
  const state: SkillRevisionState = revision.state;
  if (state === 'blocked' || state === 'revoked') return [];
  const actions: SkillRevisionAction[] = [];
  if (state === 'review_required') actions.push('review');
  if (state === 'awaiting_approval' || state === 'auto_eligible') actions.push('approve');
  if (state === 'approved' && !revision.active) actions.push('activate');
  if (revision.active) actions.push('deactivate');
  if (state === 'superseded' && !revision.active) actions.push('rollback');
  actions.push('revoke');
  return actions;
}

/** A revision that waits for the user: a review (`review_required`) or an approval (`awaiting_approval`, `auto_eligible`). */
export function needsUserDecision(revision: Pick<SkillRevisionSummary, 'state'>): boolean {
  return revision.state === 'review_required' || revision.state === 'awaiting_approval' || revision.state === 'auto_eligible';
}

/** Lifecycle states shown as warnings, errors or success. */
export function stateTone(state: SkillRevisionState): 'ok' | 'warn' | 'error' | '' {
  if (state === 'active' || state === 'approved') return 'ok';
  if (state === 'blocked' || state === 'revoked') return 'error';
  if (state === 'quarantined' || state === 'review_required' || state === 'awaiting_approval' || state === 'inspecting' || state === 'discovered') return 'warn';
  return '';
}

export type SkillCenterAction =
  | { kind: 'import'; source: SkillImportSource }
  | { kind: 'review'; input: SkillReviewInput }
  | { kind: 'approve'; input: SkillApprovalInput }
  | { kind: 'activate'; revisionId: string }
  | { kind: 'deactivate'; packageId: string }
  | { kind: 'rollback'; packageId: string; revisionId: string }
  | { kind: 'revoke'; revisionId: string };

/** Approve exactly the digests the user was shown, nothing else from the revision. */
export function approvalFor(revision: Pick<SkillRevisionSummary, 'revisionId' | 'treeSha256' | 'permissionDigest'>): SkillApprovalInput {
  return { revisionId: revision.revisionId, treeSha256: revision.treeSha256, permissionDigest: revision.permissionDigest };
}

/**
 * Run one action, returning the host's fresh report. On failure (for example a stale digest or an expired approval)
 * the host's message is returned with a reloaded report, so the user sees the current state.
 */
export async function applySkillCenterAction(agents: SkillCenterHost, action: SkillCenterAction): Promise<{ report: SkillRegistryReport | null; result?: SkillActionResult; error?: string }> {
  try {
    const result = await (
      action.kind === 'import' ? agents.importSkill(action.source)
        : action.kind === 'review' ? agents.reviewSkill(action.input)
          : action.kind === 'approve' ? agents.approveSkill(action.input)
            : action.kind === 'activate' ? agents.activateSkill(action.revisionId)
              : action.kind === 'deactivate' ? agents.deactivateSkill(action.packageId)
                : action.kind === 'rollback' ? agents.rollbackSkill(action.packageId, action.revisionId)
                  : agents.revokeSkill(action.revisionId));
    return { report: result.report, result };
  } catch (failure) {
    const report = await agents.skillRegistry().catch(() => null);
    return { report, error: errorMessage(failure) };
  }
}
