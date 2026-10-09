import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '@extalia/core';
import type { Usage } from '@extalia/protocol';
import {
  ProviderError, type FetchLike, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResult, type StopReason, type ToolCall,
} from '../model.js';

/**
 * Anthropic Messages API through the official SDK. Used for api.anthropic.com
 * and for routers that speak the same format. Assistant turns are replayed with
 * their original content blocks so reasoning blocks stay valid.
 */
export interface AnthropicOptions {
  /** Base URL without `/v1` (the SDK adds it). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  effort?: Effort;
  /**
   * Talking to Anthropic directly (not through a router): enables server-side
   * refusal fallbacks and eager tool-input streaming, which proxies may reject.
   */
  direct: boolean;
  maxTokens?: number;
  fetch?: FetchLike;
}

type Block = Anthropic.Beta.BetaContentBlock;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;

const HIDDEN_BEFORE_FALLBACK = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

/**
 * After a mid-output fallback, blocks of the declined attempt that precede the
 * last `fallback` marker must not be replayed (except text, which is kept).
 */
export function replayableContent(content: readonly Block[]): BlockParam[] {
  const boundary = content.map(block => block.type).lastIndexOf('fallback');
  return content.filter((block, index) => index > boundary || !HIDDEN_BEFORE_FALLBACK.has(block.type)) as unknown as BlockParam[];
}

export function toAnthropicMessages(messages: readonly ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const result: Anthropic.Beta.BetaMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'user') result.push({ role: 'user', content: message.text });
    else if (message.role === 'assistant') {
      if (message.native?.api === 'anthropic-messages' && Array.isArray(message.native.content)) {
        result.push({ role: 'assistant', content: replayableContent(message.native.content as Block[]) });
        continue;
      }
      const content: BlockParam[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      if (content.length) result.push({ role: 'assistant', content });
    } else {
      result.push({
        role: 'user',
        content: message.results.map(entry => ({ type: 'tool_result' as const, tool_use_id: entry.toolCallId, content: entry.content, ...(entry.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return result;
}

function stopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence': return 'end';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'refusal': return 'refusal';
    default: return 'other';
  }
}

function toProviderError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    const prefix = status === 401 || status === 403 ? 'The endpoint rejected the credentials' : status ? `The endpoint returned ${status}` : 'The endpoint could not be reached';
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? '';
    return new ProviderError(detail ? `${prefix}: ${detail}` : `${prefix}.`, status, status === undefined || status === 429 || status >= 500);
  }
  return error;
}

export function createAnthropicProvider(options: AnthropicOptions): ModelProvider {
  const client = new Anthropic({
    // Always pass the key explicitly so the SDK never falls back to the user's
    // environment or profile credentials for an endpoint they did not choose.
    apiKey: options.apiKey ?? 'not-required',
    authToken: null,
    baseURL: options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
    maxRetries: 2,
    timeout: 10 * 60_000,
    ...(options.headers ? { defaultHeaders: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch as unknown as typeof fetch } : {}),
  });

  return {
    api: 'anthropic-messages',
    async listModels() {
      const ids: string[] = [];
      try {
        for await (const model of client.models.list()) ids.push(model.id);
      } catch (error) {
        throw toProviderError(error);
      }
      return ids;
    },

    async complete(request: ModelRequest): Promise<ModelResult> {
      const tools: Anthropic.Beta.BetaTool[] = request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as unknown as Anthropic.Beta.BetaTool.InputSchema,
        // Large tool inputs (file contents) stream as they are generated; inputs are validated before running.
        ...(options.direct ? { eager_input_streaming: true } : {}),
      }));
      const params = {
        model: options.model,
        max_tokens: options.maxTokens ?? 64_000,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...(tools.length ? { tools } : {}),
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      };

      let message: Anthropic.Beta.BetaMessage | undefined;
      for (let attempt = 0; !message; attempt++) {
        const requestOptions = request.signal ? { signal: request.signal } : undefined;
        const onText = (delta: string) => request.onText?.(delta);
        let stream: { finalMessage(): Promise<unknown> };
        if (options.direct) {
          // Server-side fallbacks re-run a declined request on Anthropic's recommended model.
          const beta = client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, requestOptions);
          beta.on('text', onText);
          stream = beta;
        } else {
          const standard = client.messages.stream(params as unknown as Anthropic.MessageStreamParams, requestOptions);
          standard.on('text', onText);
          stream = standard;
        }
        try {
          message = await stream.finalMessage() as unknown as Anthropic.Beta.BetaMessage;
        } catch (error) {
          // Only an unparseable streamed tool input is retried; API and abort errors are not.
          if (error instanceof Anthropic.APIError || error instanceof Anthropic.APIUserAbortError || request.signal?.aborted || attempt >= 2) throw toProviderError(error);
        }
      }

      const content = message.content;
      const boundary = content.map(block => block.type).lastIndexOf('fallback');
      let text = '';
      const toolCalls: ToolCall[] = [];
      content.forEach((block, index) => {
        if (block.type === 'text') text += block.text;
        if (block.type === 'tool_use' && index > boundary) {
          const input = block.input;
          const valid = Boolean(input) && typeof input === 'object' && !Array.isArray(input);
          toolCalls.push({ id: block.id, name: block.name, input: valid ? input as Record<string, unknown> : {}, ...(valid ? {} : { inputError: 'Tool arguments must be a JSON object.' }) });
        }
      });
      const usage: Usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        ...(message.usage.cache_read_input_tokens ? { cachedInputTokens: message.usage.cache_read_input_tokens } : {}),
      };
      const stop = stopReason(message.stop_reason);
      const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
      return {
        text,
        toolCalls,
        stop,
        model: message.model,
        usage,
        native: { api: 'anthropic-messages', content },
        ...(stop === 'refusal' ? { refusal: details?.explanation || `The model declined this request${details?.category ? ` (${details.category})` : ''}.` } : {}),
      };
    },
  };
}
