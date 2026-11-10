/** Read-only projection of Codex's persisted queue, separate from Extalia's outbox. */
export interface ObservedCodexNativeQueueItem {
  id: string;
  text: string;
  nonTextItems: number;
  truncated?: boolean;
}
export interface ObservedCodexNativeQueueStatus {
  sessionId: string;
  threadId?: string;
  state: 'ready' | 'unavailable' | 'unsupported' | 'private';
  items: ObservedCodexNativeQueueItem[];
  observedAt?: string;
  truncated?: boolean;
}
