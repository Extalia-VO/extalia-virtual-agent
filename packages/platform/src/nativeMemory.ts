/** Human-facing access to this profile's workspace Native memory, separate from Knowledge copies. */
export interface NativeMemoryNote {
  name: string;
  summary: string;
  updatedAt: string;
  revision: string;
}
export interface NativeMemoryCatalog {
  workspaceId: string;
  notes: NativeMemoryNote[];
  omitted: number;
  incomplete: boolean;
  nextOffset?: number;
}
export interface NativeMemoryPage {
  workspaceId: string;
  name: string;
  revision: string;
  offset: number;
  nextOffset?: number;
  totalCharacters: number;
  text: string;
  truncated: boolean;
  offsetUnit: 'unicode-code-points';
}
export interface NativeMemoryReadOptions { offset?: number; limit?: number; expectedRevision?: string }
export type NativeMemoryReadResult = { status: 'found'; note: NativeMemoryPage } | { status: 'missing' | 'conflict' };
export interface NativeMemoryWriteInput { name: string; content: string; expectedRevision: string | null }
export type NativeMemoryWriteResult = { status: 'saved'; revision: string; masked: number } | { status: 'conflict' };
export interface NativeMemoryDeleteInput { name: string; expectedRevision: string }
export type NativeMemoryDeleteResult = { status: 'deleted' | 'conflict' };

export const NATIVE_MEMORY_METHODS = ['nativeMemoryList', 'nativeMemoryRead', 'nativeMemoryWrite', 'nativeMemoryDelete'] as const;
export const NATIVE_MEMORY_LIMITS = { name: 64, content: 20_000, page: 8_000, offset: 80_000, list: 50, candidates: 4096 } as const;
const REVISION = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory request.');
  return value as Record<string, unknown>;
};
export function normalizeMemoryName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Error('Invalid memory note name.');
  return value;
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION.test(value)) throw new Error('Read the current memory revision before changing or continuing it.');
  return value;
}
function integer(value: unknown, maximum: number, minimum = 0): number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid memory page.');
  return value;
}
export function normalizeMemoryListOptions(value: unknown = {}): { offset?: number; limit?: number } {
  const data = record(value);
  const offset = integer(data.offset, NATIVE_MEMORY_LIMITS.candidates);
  const limit = integer(data.limit, NATIVE_MEMORY_LIMITS.list, 1);
  return { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
}
export function normalizeMemoryReadOptions(value: unknown = {}): NativeMemoryReadOptions {
  const data = record(value);
  const offset = integer(data.offset, NATIVE_MEMORY_LIMITS.offset);
  const limit = integer(data.limit, NATIVE_MEMORY_LIMITS.page, 1);
  return {
    ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }),
    ...(data.expectedRevision === undefined ? {} : { expectedRevision: revision(data.expectedRevision) }),
  };
}
export function normalizeMemoryWrite(value: unknown): NativeMemoryWriteInput {
  const data = record(value);
  if (typeof data.content !== 'string' || !data.content.trim() || data.content.length > NATIVE_MEMORY_LIMITS.content) throw new Error('Memory notes need 1–20,000 characters.');
  return { name: normalizeMemoryName(data.name), content: data.content, expectedRevision: data.expectedRevision === null ? null : revision(data.expectedRevision) };
}
export function normalizeMemoryDelete(value: unknown): NativeMemoryDeleteInput {
  const data = record(value);
  return { name: normalizeMemoryName(data.name), expectedRevision: revision(data.expectedRevision) };
}
