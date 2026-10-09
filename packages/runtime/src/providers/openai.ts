import type { Usage } from '@extalia/protocol';
import {
  ProviderError, type FetchLike, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResult, type StopReason, type ToolCall,
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
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toChatMessages(system: string, messages: readonly ModelMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') result.push({ role: 'user', content: message.text });
    else if (message.role === 'assistant') {
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

async function errorFrom(response: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '';
    } catch { detail = text.slice(0, 300); }
  } catch { /* body unavailable */ }
  const retryable = response.status === 429 || response.status >= 500;
  const prefix = response.status === 401 || response.status === 403 ? 'The endpoint rejected the credentials' : `The endpoint returned ${response.status}`;
  return new ProviderError(detail ? `${prefix}: ${detail}` : `${prefix}.`, response.status, retryable);
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  model?: string;
  error?: { message?: string };
}

function toUsage(usage: StreamChunk['usage']): Usage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
  };
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
    async listModels(signal) {
      const response = await fetchImpl(`${base}/models`, { headers: headers(false), ...(signal ? { signal } : {}) });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as { data?: { id?: unknown }[] };
      return (body.data ?? []).map(item => item.id).filter((id): id is string => typeof id === 'string').sort();
    },

    async complete(request: ModelRequest): Promise<ModelResult> {
      const body = {
        model: options.model,
        messages: toChatMessages(request.system, request.messages),
        stream: true,
        ...(request.tools.length ? {
          tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        } : {}),
      };
      const response = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers: headers(true), body: JSON.stringify(body), ...(request.signal ? { signal: request.signal } : {}) });
      if (!response.ok) throw await errorFrom(response);

      let text = '';
      let finish: string | undefined;
      let usage: Usage | undefined;
      let model: string | undefined;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const absorb = (chunk: StreamChunk) => {
        if (chunk.error?.message) throw new ProviderError(chunk.error.message);
        if (chunk.model) model = chunk.model;
        usage = toUsage(chunk.usage) ?? usage;
        for (const choice of chunk.choices ?? []) {
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
        ...(finish === 'content_filter' ? { refusal: 'The provider filtered this response.' } : {}),
      };
    },
  };
}
