/** An official CLI queue receipt is not native delivery, steering or approval authority. */
export interface ObservedCodexQueueStatus {
  sessionId: string;
  threadId?: string;
  enabled: boolean;
  canQueue: boolean;
  busy?: boolean;
  delivery?: 'queued' | 'unknown';
  /** Receipt identity only; this does not establish delivery to an agent. */
  messageId?: string;
  problem?: string;
}

/** Native identity and profile paths are resolved exclusively by the host. */
export interface ObservedCodexQueueMessageInput {
  text: string;
  connectionId?: string;
}
