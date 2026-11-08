/** Native controls for an explicit attachment to the original Hermes gateway and session. */
export interface HermesObservedQuestion {
  id: string;
  kind: 'approval' | 'clarify';
  executionGeneration: number;
  question: string;
  choices: string[];
  command?: string;
  description?: string;
  multiSelect?: boolean;
}
export interface HermesObservedStatus {
  sessionId: string;
  nativeSessionId: string;
  state: 'disconnected' | 'connected' | 'unavailable';
  connectionId?: string;
  executionGeneration?: number;
  running: boolean;
  canSend: boolean;
  canAnswer: boolean;
  requests: HermesObservedQuestion[];
  problem?: string;
  delivery?: 'submitted' | 'resolved' | 'unknown';
}
export interface HermesObservedMessageInput { connectionId: string; text: string; executionGeneration?: number }
export interface HermesObservedAnswerInput {
  connectionId: string;
  requestId: string;
  executionGeneration: number;
  answer?: string;
  choice?: string;
}
