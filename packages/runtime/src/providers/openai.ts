import type { Usage } from '@extalia/protocol';
import {
  ProviderError, isQuotaMessage, isRetryableStatus, type FetchLike, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResult, type StopReason, type ToolCall,
} from '../model.js';
import { readSse } from './sse.js';

/**
 * OpenAI-compatible Chat Completions with streaming tool calls. Covers OpenAI,
 * OpenRouter, Ollama and local routers such as 9Router and OmniRoute.
 */
export interface OpenAIChatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toChatMessages(system: string, messages: readonly ModelMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      // Chat Completions takes images as data URLs in content parts; the text part follows them.
      result.push(message.images?.length
        ? { role: 'user', content: [...message.images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } })), { type: 'text' as const, text: message.text || 'Attached image.' }] }
        : { role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length ? {
          tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input) } })),
        } : {}),
      });
    } else {
      for (const entry of message.results) result.push({ role: 'tool', tool_call_id: entry.toolCallId, content: entry.isError ? `Error: ${entry.content}` : entry.content });
    }
  }
  return result;
}

function stopReason(finish: string | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop' || finish === undefined) return 'end';
  return 'other';
}

function parseArguments(raw: string): { input: Record<string, unknown>; inputError?: string } {
  if (!raw.trim()) return { input: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { input: value as Record<string, unknown> };
    return { input: {}, inputError: 'Tool arguments must be a JSON object.' };
  } catch {
    return { input: {}, inputError: 'Tool arguments were not valid JSON.' };
  }
}

/**
 * Endpoints that rejected `stream_options` with a 400, keyed by base URL. Kept in
 * memory only: after a plain retry succeeds, later requests omit the option.
 */
const streamOptionsRejected = new Set<string>();

/** A 400 naming `stream_options` (or an unknown/unrecognized parameter) is the only failure retried without it. */
const STREAM_OPTIONS_REJECTED = /stream_options|(?:unknown|unrecognized|unsupported)\s+(?:request\s+)?(?:parameter|argument|field)/i;

async function readText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    return typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '';
  } catch { return text.slice(0, 300); }
}

async function errorFrom(response: Response, text?: string): Promise<ProviderError> {
  const detail = errorDetail(text ?? await readText(response));
  const retryable = response.status !== 401 && isRetryableStatus(response.status, detail);
  const prefix = response.status === 401 || response.status === 403 ? 'The endpoint rejected the credentials' : `The endpoint returned ${response.status}`;
  return new ProviderError(detail ? `${prefix}: ${detail}` : `${prefix}.`, response.status, retryable);
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]; usage?: unknown }; finish_reason?: string | null; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; usage?: unknown }[];
  /** Final chunk with `stream_options.include_usage`; earlier chunks carry `usage: null`. */
  usage?: unknown;
  model?: string;
  error?: { message?: string };
}

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Reads token counts in the shapes compatible servers send (`prompt_tokens` or
 * `input_tokens`, `completion_tokens` or `output_tokens`). Missing or malformed
 * counts stay absent, never zero.
 */
function toUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null };
  const inputTokens = count(usage.prompt_tokens) ?? count(usage.input_tokens);
  const outputTokens = count(usage.completion_tokens) ?? count(usage.output_tokens);
  const cachedInputTokens = count(usage.prompt_tokens_details?.cached_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/** Later reports refine earlier ones field by field; a chunk without usage keeps what was reported. */
function mergeUsage(previous: Usage | undefined, next: Usage | undefined): Usage | undefined {
  return next ? { ...previous, ...next } : previous;
}

export function createOpenAIChatProvider(options: OpenAIChatOptions): ModelProvider {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.headers,
  });

  return {
    api: 'openai-chat',
    images: true,
    async listModels(signal) {
      const response = await fetchImpl(`${base}/models`, { headers: headers(false), ...(signal ? { signal } : {}) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { data?: { id?: unknown }[] };
      return (body.data ?? []).map(item => item.id).filter((id): id is string => typeof id === 'string').sort();
    },

    async complete(request: ModelRequest): Promise<ModelResult> {
      const messages = toChatMessages(request.system, request.messages);
      const tools = request.tools.length ? {
        tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      } : {};
      const send = (includeUsage: boolean) => fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: true,
          // Ask for the final usage chunk; servers that reject the option get one plain retry.
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...tools,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const requestsUsage = !streamOptionsRejected.has(base);
      let response = await send(requestsUsage);
      let failureText: string | undefined;
      if (!response.ok && requestsUsage && response.status === 400) {
        failureText = await readText(response);
        if (STREAM_OPTIONS_REJECTED.test(errorDetail(failureText))) {
          // No tokens were produced for a 400, so the retry cannot double-count usage.
          response = await send(false);
          if (response.ok) streamOptionsRejected.add(base);
          failureText = undefined;
        }
      }
      if (!response.ok) throw await errorFrom(response, failureText);

      let text = '';
      let finish: string | undefined;
      let usage: Usage | undefined;
      let model: string | undefined;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const absorb = (chunk: StreamChunk) => {
        if (chunk.error?.message) throw new ProviderError(chunk.error.message, undefined, isQuotaMessage(chunk.error.message));
        if (chunk.model) model = chunk.model;
        usage = mergeUsage(usage, toUsage(chunk.usage));
        for (const choice of chunk.choices ?? []) {
          usage = mergeUsage(mergeUsage(usage, toUsage(choice.usage)), toUsage(choice.delta?.usage));
          if (choice.finish_reason) finish = choice.finish_reason;
          // Some servers answer a streaming request with a single complete message.
          if (choice.message) {
            if (choice.message.content) { text += choice.message.content; request.onText?.(choice.message.content); }
            choice.message.tool_calls?.forEach((call, index) => calls.set(index, { id: call.id, name: call.function.name, args: call.function.arguments }));
          }
          const delta = choice.delta;
          if (delta?.content) { text += delta.content; request.onText?.(delta.content); }
          for (const part of delta?.tool_calls ?? []) {
            const index = part.index ?? calls.size;
            const current = calls.get(index) ?? { id: '', name: '', args: '' };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) current.args += part.function.arguments;
            calls.set(index, current);
          }
        }
      };

      if ((response.headers.get('content-type') ?? '').includes('application/json')) absorb(await response.json() as StreamChunk);
      else if (response.body) {
        for await (const message of readSse(response.body, request.signal)) {
          if (message.data === '[DONE]') break;
          let chunk: StreamChunk;
          try { chunk = JSON.parse(message.data) as StreamChunk; } catch { continue; }
          absorb(chunk);
        }
      }

      const toolCalls: ToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
        const parsed = parseArguments(call.args);
        return { id: call.id || `call_${index}`, name: call.name, ...parsed };
      });
      return {
        text,
        toolCalls,
        stop: stopReason(finish, toolCalls.length > 0),
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        // `prompt_tokens` already includes cached tokens (OpenAI-compatible servers).
        ...(usage?.inputTokens !== undefined ? { promptTokens: usage.inputTokens } : {}),
        ...(finish === 'content_filter' ? { refusal: 'The provider filtered this response.' } : {}),
      };
    },
  };
}
