export type OfficeAttentionOutcome = 'shown' | 'canceled' | 'retry';

/** One scope-bound Office navigation request; it never authorizes an answer. */
export interface OfficeInputFocus {
  sessionId: string;
  requestId?: string;
  kind?: 'input' | 'approval';
  agentId?: string;
  automatic?: boolean;
  attentionKey?: string;
  onSettled?: (outcome: OfficeAttentionOutcome) => void;
  token: number;
  scope?: string;
}
