/** Cooperative tool return in a manually paired, already open conversation. */
export interface ObservedReplyStatus {
  sessionId: string;
  state: 'disconnected' | 'waitingForAgent' | 'waitingForReply' | 'answered' | 'expired' | 'unavailable';
  channelId?: string;
  url?: string;
  token?: string;
  question?: string;
  problem?: string;
}
export interface ObservedReplyAnswer { channelId: string; text: string }
