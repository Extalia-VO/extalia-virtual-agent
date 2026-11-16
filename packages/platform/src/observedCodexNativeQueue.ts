/** Read-only projection of Codex's persisted queue, separate from Extalia's outbox. */
export interface ObservedCodexNativeQueueItem {
  id: string;
  text: string;
  nonTextItems: number;
  /** Bounded display-only metadata; local paths and remote media URLs are never exposed. */
  attachments?: { kind: 'image' | 'audio' | 'skill' | 'file'; name?: string; thumbnail?: string }[];
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
