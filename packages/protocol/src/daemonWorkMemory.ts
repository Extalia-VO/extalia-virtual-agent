/** Durable operational evidence. These records never attest task success or grant access. */
export interface WorkMemoryScope { profileId: string; workspaceId: string; boundary: string }
export type WorkMemorySourceKind = 'native' | 'observed' | 'knowledge' | 'skill';
export interface WorkMemorySource {
  kind: WorkMemorySourceKind; sourceId: string; sessionId: string; episodeId: string; revision: string;
  /** Required for observed records; the host must revalidate this source boundary on every read. */
  accessKey?: string;
}
export interface WorkMemoryEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'file' | 'status' | 'knowledge' | 'skill'; text: string; at?: string }
export interface WorkMemoryCoverage { mode: 'partial' | 'unknown'; omittedEntries: number; truncated: boolean; limits: string[] }
export interface WorkMemoryRecord {
  id: string; revision: string; scope: WorkMemoryScope; source: WorkMemorySource;
  outcome: 'completed' | 'failed' | 'cancelled'; title: string; summary: string;
  capturedAt: string; entries: number; trust: 'attributed-evidence'; coverage: WorkMemoryCoverage;
}
export interface WorkMemoryPage { record: WorkMemoryRecord; entries: WorkMemoryEntry[]; offset: number; total: number; nextOffset?: number }
export interface WorkMemoryActions {
  'memory.capture': {
    input: { scope: WorkMemoryScope; source: WorkMemorySource; outcome: WorkMemoryRecord['outcome']; title: string; summary: string; entries: WorkMemoryEntry[]; coverage: WorkMemoryCoverage };
    result: { record: WorkMemoryRecord; created: boolean };
  };
  'memory.search': {
    input: { scope: WorkMemoryScope; query: string; limit?: number; observedSourceKeys?: string[] };
    result: { hits: { record: WorkMemoryRecord; excerpt: string }[]; omitted: number };
  };
  'memory.read': {
    input: { scope: WorkMemoryScope; id: string; revision: string; offset?: number; limit?: number; observedSourceKeys?: string[] };
    result: WorkMemoryPage;
  };
  'memory.revoke': {
    input: { scope: WorkMemoryScope; sourceKind?: WorkMemorySourceKind; sourceId?: string; sessionId?: string; episodeId?: string; accessKey?: string };
    result: { removed: number };
  };
}
