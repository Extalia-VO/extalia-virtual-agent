export type PromptQueueItemState = 'pending' | 'sending' | 'sent' | 'unknown';

export interface PromptQueueItem {
  id: string;
  text: string;
  state: PromptQueueItemState;
  createdAt: string;
}

/** Extalia owns pending items; handed-off prompts are receipts, not editable source queues. */
export interface PromptQueueStatus {
  sessionId: string;
  revision: string;
  supported: boolean;
  paused: boolean;
  maxTextLength: number;
  items: PromptQueueItem[];
  problem?: string;
}

export type PromptQueueChange = { revision: string } & (
  | { action: 'add'; text: string }
  | { action: 'edit'; itemId: string; text: string }
  | { action: 'delete'; itemId: string }
  | { action: 'reorder'; itemIds: string[] }
  | { action: 'pause'; paused: boolean }
  /** Acknowledges a local receipt after inspecting the source; never retracts a source prompt. */
  | { action: 'acknowledge'; itemId: string }
);
