export interface OfficeAttentionRequest {
  key: string;
  kind: 'input' | 'approval';
  sessionId: string;
  requestId: string;
  agentId?: string;
  requestedAt?: string;
}

const seenHistoryLimit = 2048;

function requestedTime(request: OfficeAttentionRequest): number {
  const time = request.requestedAt ? Date.parse(request.requestedAt) : Number.NaN;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** Memory-only popup coordination; callers supply the complete current pending list. */
export function createOfficeAttentionQueue() {
  const seen = new Set<string>();

  function prune(pending: ReadonlySet<string>): void {
    for (const key of seen) {
      if (seen.size <= seenHistoryLimit) break;
      if (!pending.has(key)) seen.delete(key);
    }
  }

  return {
    /** Retry a claimed request that could not be presented; never release a dismissed popup. */
    release(key: string): void {
      seen.delete(key);
    },

    take(
      requests: readonly OfficeAttentionRequest[],
      gate: { active: boolean; blocked: boolean },
    ): OfficeAttentionRequest | undefined {
      const pending = new Map<string, OfficeAttentionRequest>();
      for (const request of requests) {
        if (!pending.has(request.key)) pending.set(request.key, request);
      }
      const pendingKeys = new Set(pending.keys());
      prune(pendingKeys);
      if (!gate.active || gate.blocked) return undefined;

      let next: OfficeAttentionRequest | undefined;
      let nextTime = Number.POSITIVE_INFINITY;
      for (const request of pending.values()) {
        if (seen.has(request.key)) continue;
        const time = requestedTime(request);
        if (!next || time < nextTime || (time === nextTime && request.key < next.key)) {
          next = request;
          nextTime = time;
        }
      }

      if (next) {
        seen.add(next.key);
        // Pending requests stay pinned even if their count exceeds the history limit.
        prune(pendingKeys);
      }
      return next;
    },
  };
}
