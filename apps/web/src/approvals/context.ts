import { createContext, useContext } from 'react';
import type { ApprovalChoice, PendingApproval } from './model';

/** What the inbox, the Office cards and the notifications share. Outside a provider nothing is pending. */
export interface ApprovalsValue {
  /** Open approvals across managed sessions, oldest first. */
  pending: readonly PendingApproval[];
  /** One answer is being sent for this approval. */
  busy(approval: PendingApproval): boolean;
  /** Answer in the approval's own session; the host decides what the answer allows. */
  decide(approval: PendingApproval, choice: ApprovalChoice): Promise<void>;
  /** Why the last answer failed, safe to show. */
  error: string | undefined;
  inboxOpen: boolean;
  openInbox(): void;
  closeInbox(): void;
}

const NOTHING: ApprovalsValue = {
  pending: [],
  busy: () => false,
  decide: async () => undefined,
  error: undefined,
  inboxOpen: false,
  openInbox: () => undefined,
  closeInbox: () => undefined,
};

export const ApprovalsContext = createContext<ApprovalsValue>(NOTHING);

export function useApprovals(): ApprovalsValue {
  return useContext(ApprovalsContext);
}
