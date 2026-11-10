import type { AgentHostOptions } from '../src/service.js';
import type { ModelDiscoveryPort } from '../src/daemon/modelDiscovery.js';

type FetchLike = NonNullable<AgentHostOptions['fetch']>;

/** Explicit test-only model catalog adapter backed by the suite's scripted fetch. */
export function mockModelDiscovery(fetch: FetchLike): ModelDiscoveryPort {
  return async (request, signal) => {
    const baseUrl = request.baseUrl.replace(/\/+$/, '');
    const headers = { ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}), ...request.headers };
    const response = await fetch(`${baseUrl}/models`, { headers, signal });
    if (!response.ok) throw new Error(`Synthetic model catalog returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new Error('Synthetic model catalog fixture is invalid');
    }
    const models = payload.data.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? [item.id] : []);
    return models.sort();
  };
}
