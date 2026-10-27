import type { ProviderApi } from '@extalia/core';
import type { Usage } from '@extalia/protocol';
import type { JsonSchemaObject } from './tools.js';

/** A tool call requested by the model. `input` is parsed JSON; `inputError` is set when it was not valid JSON. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputError?: string;
}

export interface ToolResultEntry {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * Provider-neutral conversation history. Assistant turns may carry the
 * provider's own content (`native`) so the same provider can replay it
 * unchanged, which some APIs require (for example reasoning blocks).
 */
export type ModelImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** An image a user attached to a turn: its type and base64 data (no data URL prefix). */
export interface ModelImage {
  mimeType: ModelImageType;
  data: string;
}

export type ModelMessage =
  | { role: 'user'; text: string; /** Sent with the turn that attached them; never kept in the stored history. */ images?: ModelImage[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; native?: { api: ProviderApi; content: unknown } }
  | { role: 'tool'; results: ToolResultEntry[] };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolSpec[];
  signal?: AbortSignal;
  /** Streamed assistant text. */
  onText?(delta: string): void;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  model?: string;
  usage?: Usage;
  /**
   * The size of this request's prompt in tokens, cache included (v0.0.48: the conversation's context in use).
   * Absent when the provider reports no usage.
   */
  promptTokens?: number;
  /** Provider content to replay on the next request to the same API. */
  native?: { api: ProviderApi; content: unknown };
  /** Readable reason when the model declined. */
  refusal?: string;
}

export interface ModelProvider {
  readonly api: ProviderApi;
  /** Whether user messages may carry images. Absent or true for the built-in adapters; false sends a text note instead. */
  readonly images?: boolean;
  complete(request: ModelRequest): Promise<ModelResult>;
  /** Models the endpoint offers, when it can list them. */
  listModels(signal?: AbortSignal): Promise<string[]>;
}

/** An error from a model endpoint, with a message safe to show to the user. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Messages of quota, credit and rate-limit failures that some endpoints and
 * routers send with an unusual status (400, 402, 403) or inside a stream.
 * Context-length errors are not quota errors and never match.
 */
const QUOTA_MESSAGE = /insufficient[_ ]quota|quota|credit|billing|payment required|rate[_ -]?limit|too many requests|usage limit|limit (?:exceeded|reached)|exceeded your|out of tokens|tokens? (?:limit|budget) (?:exceeded|reached)/i;

export function isQuotaMessage(message: string): boolean {
  return QUOTA_MESSAGE.test(message) && !/context|prompt is too long|maximum.*length/i.test(message);
}

/** Whether a failed request may succeed later or on another model: rate limits, quota, credit, overload. */
export function isRetryableStatus(status: number | undefined, message = ''): boolean {
  if (status === undefined) return true;
  return status === 402 || status === 408 || status === 429 || status >= 500 || isQuotaMessage(message);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
