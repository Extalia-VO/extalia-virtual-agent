/** Host discovery and actual adapter capabilities are distinct from model providers. */
export interface HandoverHarnessDestination {
  id: string;
  sourceIds: string[];
  evidence: Array<'builtin' | 'executable' | 'application' | 'observed-session' | 'native-connection'>;
  existing: 'ready' | 'setup-required' | 'unsupported';
  create: 'ready' | 'unavailable' | 'unsupported';
  sessionIds: string[];
  /** Stable reason code for localized presentation; never a credential or endpoint. */
  reason?: 'no-connection' | 'setup-required' | 'adapter-unavailable' | 'runtime-unavailable';
}
export interface HandoverHarnessInventory {
  sourceSessionId: string;
  revision: string;
  harnesses: HandoverHarnessDestination[];
  pendingCreation?: { harnessId: string; operationId: string; nativeSessionId: string; state: 'created' | 'unknown' };
}
export interface HandoverDestinationCreateInput { harnessId: string; revision: string; operationId: string }
export interface HandoverDestinationCreateReceipt {
  operationId: string;
  harnessId: string;
  state: 'created' | 'unknown' | 'rejected';
  /** Verified Extalia observation ID, never a renderer-supplied native ID. */
  sessionId?: string;
  problem?: string;
  retryable: false;
}
