import type { ObservedMemoryEpisode, ObservedMemoryPage } from '@extalia/protocol';

export type { ObservedMemoryEpisode, ObservedMemoryPage } from '@extalia/protocol';
/** Attributed observed reports; neither a verified task outcome nor additional workspace authority. */
export interface ObservedMemorySearchResult {
  hits: { sessionId: string; episode: ObservedMemoryEpisode; excerpt: string }[];
  omitted: number;
  incomplete: boolean;
}
export interface ObservedMemoryReadInput { sessionId: string; episodeId: string; revision: string; offset?: number; limit?: number }
export interface ObservedMemoryApi {
  observedMemorySearch?(workspaceId: string, input: { query: string; limit?: number }): Promise<ObservedMemorySearchResult>;
  observedMemoryRead?(workspaceId: string, input: ObservedMemoryReadInput): Promise<ObservedMemoryPage>;
}
