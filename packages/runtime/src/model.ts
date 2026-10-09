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
export type ModelMessage =
  | { role: 'user'; text: string }
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
  /** Provider content to replay on the next request to the same API. */
  native?: { api: ProviderApi; content: unknown };
  /** Readable reason when the model declined. */
  refusal?: string;
}

export interface ModelProvider {
  readonly api: ProviderApi;
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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
