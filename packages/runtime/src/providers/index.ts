import { providerHeaders, type Connection } from '@extalia/core';
import type { FetchLike, ModelProvider } from '../model.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIChatProvider } from './openai.js';

export { createAnthropicProvider, replayableContent, toAnthropicMessages } from './anthropic.js';
export { createOpenAIChatProvider, toChatMessages } from './openai.js';
export { readSse } from './sse.js';

type ProviderConnection = Pick<Connection, 'preset' | 'api' | 'baseUrl' | 'model' | 'features' | 'effort'>;

function isAnthropicCloud(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === 'api.anthropic.com'; } catch { return false; }
}

/** Build the model provider for a connection. The secret is passed in and never stored here. */
export function createProvider(connection: ProviderConnection, secret: string | undefined, fetchImpl?: FetchLike): ModelProvider {
  const headers = providerHeaders(connection);
  const common = { baseUrl: connection.baseUrl, model: connection.model, ...(secret ? { apiKey: secret } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  if (connection.api === 'anthropic-messages') {
    return createAnthropicProvider({
      ...common,
      direct: connection.preset === 'anthropic' && isAnthropicCloud(connection.baseUrl),
      ...(connection.effort ? { effort: connection.effort } : {}),
    });
  }
  return createOpenAIChatProvider(common);
}
