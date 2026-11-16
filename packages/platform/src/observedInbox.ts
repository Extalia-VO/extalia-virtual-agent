/** Memory-only cooperative inbox; pairing grants no native application authority. */
export interface ObservedInboxReceipt {
  messageId: string;
  operationId?: string;
  /** delivered means an HTTP tool result was written, never proof of agent consumption. */
  state: 'queued' | 'delivered' | 'acknowledged' | 'unknown' | 'cancelled';
  createdAt: number;
}
export interface ObservedInboxStatus {
  sessionId: string;
  label?: string;
  state: 'disconnected' | 'connected' | 'expired' | 'unavailable';
  channelId?: string;
  url?: string;
  token?: string;
  expiresAt?: number;
  polling?: boolean;
  queued?: number;
  receipts?: ObservedInboxReceipt[];
  problem?: string;
}
export interface ObservedInboxSend { channelId: string; text: string; operationId?: string }
