import type { Effort } from '@extalia/core';

/** A destination is a model connection or an existing outside conversation, never an invented runtime thread. */
export type HandoverTarget =
  | { kind: 'native'; connectionId: string; model?: string; effort?: Effort }
  | { kind: 'observed'; sessionId: string; capabilityId: string }
  | { kind: 'manual'; label: string; sessionId?: string };

/** User-reviewed working notes. These are claims, not execution or permission evidence. */
export interface ContinuityNotes {
  goal: string;
  decisions: string;
  completed: string;
  pending: string;
  verification: string;
  risks: string;
}
export interface ContinuityCoverage {
  /** Full means all entries visible to Extalia in this source snapshot, never the harness's hidden context. */
  mode: 'full' | 'partial' | 'unknown';
  observedThrough?: string;
  observedEntries: number;
  omittedEntries: number;
  limits: string[];
}
export interface ContinuitySnapshotSummary {
  id: string;
  sessionId: string;
  sourceId: string;
  nativeSessionId?: string;
  model?: string;
  effort?: Effort;
  connectionId?: string;
  /** Additional reviewed workspace references retain their original profile and access boundary. */
  workspaceContext?: { workspaceId: string; profileId: string; boundary: string;
    contributors?: { sessionId: string; sourceId: string; nativeSessionId: string; boundary: string }[] };
  title: string;
  capturedAt: string;
  revision: string;
  coverage: ContinuityCoverage;
  context?: { usedTokens: number; windowTokens?: number; estimated: boolean; compactions: number; updatedAt: string };
  entries: number;
}
export type HandoverDeliveryState = 'native-ready' | 'manual-ready' | 'queued' | 'submitted' | 'unknown' | 'inspected' | 'rejected';
export interface HandoverReceipt {
  canonicalId: string;
  operationId: string;
  reviewId: string;
  sourceSessionId: string;
  target: HandoverTarget;
  targetLabel?: string;
  targetSessionId?: string;
  state: HandoverDeliveryState;
  at: string;
  packetDigest: string;
  /** Exact whole-packet identity after transcript redaction/whitespace normalization; excludes known imported echoes only. */
  sanitizedPacketDigest?: string;
  problem?: string;
  messageId?: string;
  /** Explicit user inspection only; this is neither a transport acknowledgement nor proof of model consumption. */
  resolution?: { kind: 'user-inspected'; outcome: 'accepted' | 'not-delivered'; at: string };
  /** Transport acceptance never proves the receiving model read or retained the packet. */
  retryable: false;
}
export interface ContinuityView {
  canonicalId: string;
  revision: number;
  workspaceId: string;
  persistent: boolean;
  notes: ContinuityNotes;
  notesOrigin: 'user-reviewed' | 'source-excerpt';
  snapshots: ContinuitySnapshotSummary[];
  handovers: HandoverReceipt[];
}
export interface HandoverPreviewInput { target: HandoverTarget; notes?: ContinuityNotes }
export interface HandoverPreview {
  canonicalId: string;
  sourceSessionId: string;
  reviewId: string;
  expiresAt: string;
  target: HandoverTarget;
  targetLabel: string;
  targetSessionId?: string;
  notes: ContinuityNotes;
  notesOrigin: ContinuityView['notesOrigin'];
  packet: string;
  packetDigest: string;
  coverage: ContinuitySnapshotSummary[];
  packetOmittedEntries: number;
  persistent: boolean;
  handoverCount: number;
}
export interface HandoverApplyInput { reviewId: string; operationId: string }
export interface HandoverReconcileInput { operationId: string; packetDigest: string; outcome: 'accepted' | 'not-delivered' }
export interface ContinuityEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'file' | 'status'; text: string; at?: string }
export interface ContinuityReadInput { snapshotId: string; offset?: number; limit?: number }
export interface ContinuityReadPage {
  canonicalId: string;
  snapshot: ContinuitySnapshotSummary;
  entries: ContinuityEntry[];
  offset: number;
  total: number;
  nextOffset?: number;
}
