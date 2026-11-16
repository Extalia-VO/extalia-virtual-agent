/** Transport selected before submission; a submitted receipt does not prove model consumption. */
export type ObservedUserInputDeliveryRoute = 'native-answer' | 'native-steer' | 'native-start' | 'queue';

/** Source-bound input questions shared by Chat, Observe and Office. */
export interface ObservedUserInputQuestion {
  id: string;
  title: string;
  options: string[];
  /** Optional explanatory copy aligned with options, preserved from native questions. */
  optionDescriptions?: string[];
  allowOther: boolean;
  isSecret: boolean;
}
export interface ObservedUserInputRequest {
  id: string;
  revision: string;
  origin: 'codex-async' | 'codex-native';
  state: 'pending' | 'queued' | 'submitted' | 'unknown';
  deliveryRoute?: ObservedUserInputDeliveryRoute;
  questions: ObservedUserInputQuestion[];
  canAnswer: boolean;
  /** False for idless/history-only metadata; these cards never raise pending-input alerts. */
  identityVerified?: boolean;
  askedAt?: string;
}
export interface ObservedUserInputStatus {
  sessionId: string;
  state: 'ready' | 'unavailable' | 'private';
  requests: ObservedUserInputRequest[];
}
export interface ObservedUserInputAnswer {
  requestId: string;
  revision: string;
  answers: Record<string, string>;
}
