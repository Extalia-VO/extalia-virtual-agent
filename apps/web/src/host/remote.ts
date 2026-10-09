import { AGENT_HOST_METHODS, type AgentHostApi, type AgentHostMethod } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';

export type RemoteCall = (method: AgentHostMethod, args: unknown[]) => Promise<unknown>;

/**
 * Build an AgentHostApi from a method forwarder and an event source. Desktop
 * (IPC) and the Bridge (HTTP + SSE) differ only in these two functions.
 */
export function createRemoteHost(call: RemoteCall, subscribe: (listener: (event: ExtaliaEvent) => void) => () => void): AgentHostApi {
  const methods = Object.fromEntries(AGENT_HOST_METHODS.map(method => [method, (...args: unknown[]) => {
    // Trailing undefined arguments would arrive as null after serialization.
    while (args.length && args[args.length - 1] === undefined) args.pop();
    return call(method, args);
  }]));
  return { ...methods, subscribe } as unknown as AgentHostApi;
}

/** A user-presentable message for anything a host call throws. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Electron prefixes IPC errors with the channel name; the host's own message follows.
  return raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^(?:[A-Z]\w*)?Error: /, '').trim() || 'Unknown error.';
}

/** Fan-out helper for transports that own one upstream event connection. */
export function listenerSet<T>(onFirst: () => void, onLast: () => void) {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) onFirst();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) onLast();
      };
    },
    emit(value: T) {
      for (const listener of [...listeners]) {
        try { listener(value); } catch (error) { console.error(error); }
      }
    },
  };
}
