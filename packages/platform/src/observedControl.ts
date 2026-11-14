/** Actions target an existing outside conversation; observation alone grants none. */
export type ObservedControlAction = 'start' | 'steer' | 'queue' | 'reply-tool' | 'inbox-send';
export type ObservedControlRoute = 'codex-native' | 'codex-queue' | 'hermes-native' | 'cooperative-tool' | 'cooperative-inbox' | 'official-cli-resume' | 'antigravity-native';
export type ObservedControlEvidence = 'native-attachment' | 'official-queue' | 'paired-tool' | 'paired-inbox' | 'official-cli';
export type ObservedControlDelivery = 'rejected' | 'queued' | 'submitted' | 'resolved' | 'unknown';

/** Transport catalog, not a claim that an installed provider supports control. */
export const OBSERVED_CONTROL_ROUTES: readonly {
  route: ObservedControlRoute;
  actions: readonly ObservedControlAction[];
  evidence: ObservedControlEvidence;
  limit: 'existing-native-owner' | 'queue-receipt-only' | 'waiting-tool-only' | 'paired-consumer-only' | 'reviewed-cli-owner';
}[] = [
  { route: 'codex-native', actions: ['start', 'steer'], evidence: 'native-attachment', limit: 'existing-native-owner' },
  { route: 'codex-queue', actions: ['queue'], evidence: 'official-queue', limit: 'queue-receipt-only' },
  { route: 'hermes-native', actions: ['start', 'steer'], evidence: 'native-attachment', limit: 'existing-native-owner' },
  { route: 'cooperative-tool', actions: ['reply-tool'], evidence: 'paired-tool', limit: 'waiting-tool-only' },
  { route: 'cooperative-inbox', actions: ['inbox-send'], evidence: 'paired-inbox', limit: 'paired-consumer-only' },
  { route: 'antigravity-native', actions: ['start'], evidence: 'native-attachment', limit: 'existing-native-owner' },
  { route: 'official-cli-resume', actions: ['start'], evidence: 'official-cli', limit: 'reviewed-cli-owner' },
];

export interface ObservedControlCapability {
  action: ObservedControlAction;
  available: boolean;
  /** Opaque host authority for this exact source, attachment and generation. */
  capabilityId?: string;
}
export interface ObservedControlRelatedControl {
  kind: 'questions' | 'approvals';
  available: boolean;
}
export interface ObservedControlRouteStatus {
  route: ObservedControlRoute;
  state: 'ready' | 'unavailable' | 'busy' | 'uncertain';
  evidence: ObservedControlEvidence;
  limit: typeof OBSERVED_CONTROL_ROUTES[number]['limit'];
  capabilities: ObservedControlCapability[];
  /** Native questions and approvals retain their existing dedicated response panels. */
  relatedControls: ObservedControlRelatedControl[];
  problem?: string;
}
export interface ObservedControlStatus {
  sessionId: string;
  state: 'ready' | 'unavailable';
  /** This binding never exposes source paths, credentials or transport tokens. */
  bindingId?: string;
  sourceId?: string;
  nativeSessionId?: string;
  routes: ObservedControlRouteStatus[];
}
export interface ObservedControlDispatchInput {
  operationId: string;
  capabilityId: string;
  text: string;
}
export interface ObservedControlReceipt {
  sessionId: string;
  operationId: string;
  route?: ObservedControlRoute;
  action?: ObservedControlAction;
  state: ObservedControlDelivery;
  /** Receipt identity does not prove that an agent consumed the message. */
  messageId?: string;
  problem?: string;
  /** An uncertain operation is never retried automatically. */
  retryable: false;
}
