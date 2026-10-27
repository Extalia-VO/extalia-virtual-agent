import type { HostState, RestartKind } from '@extalia/platform';

/**
 * Agent work Extalia itself runs: a turn in progress or an approval waiting for an
 * answer. Observed transcripts are read-only and are not stopped by a restart.
 */
export function activeAgentWork(state: Pick<HostState, 'sessions'> | null | undefined): number {
  return state?.sessions.filter(session => session.control === 'managed' && (session.running || Boolean(session.pendingApprovalId))).length ?? 0;
}

export type RestartConfirmReason = 'activeWork' | 'unsavedDraft';

export interface RestartPlan {
  /** `relaunch` (Desktop) or `reload` (Web page). */
  kind: RestartKind;
  /** Button label key: "Restart now" on Desktop, "Reload page" on the web. */
  label: 'restartNow' | 'reloadPage';
  /** The user must confirm before the restart starts. */
  confirm: boolean;
  /** Why confirmation is needed, in the order the dialog lists them. */
  reasons: RestartConfirmReason[];
  /** Passed to the platform restart; set only when the user has seen the active-work warning. */
  options: { acknowledgeActiveWork: boolean };
}

/** Confirm first whenever a restart could lose running work or unsaved text. Nothing restarts on its own. */
export function restartPlan(kind: RestartKind, state: { activeWork: number; unsavedDraft: boolean }): RestartPlan {
  const reasons: RestartConfirmReason[] = [];
  if (state.activeWork > 0) reasons.push('activeWork');
  if (state.unsavedDraft) reasons.push('unsavedDraft');
  return {
    kind,
    label: kind === 'relaunch' ? 'restartNow' : 'reloadPage',
    confirm: reasons.length > 0,
    reasons,
    options: { acknowledgeActiveWork: state.activeWork > 0 },
  };
}
