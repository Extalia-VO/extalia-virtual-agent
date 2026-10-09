import type { ToolOutcome } from '@extalia/runtime';
import { errorCode } from '../jsonStore.js';
import { WorkspacePathError } from '../workspaceFs.js';

/** Upper bound for text a tool returns to the model. */
export const OUTPUT_LIMIT = 30_000;

export function bound(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… output truncated (${text.length - limit} more characters).`;
}

/** Model-supplied integers: defaulted and clamped, since providers do not always honor the schema. */
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

export const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export const failure = (output: string): ToolOutcome => ({ ok: false, output });

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : /(s|x|z|ch|sh)$/.test(word) ? 'es' : 's'}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Git and most editors treat a NUL byte near the start as the mark of a binary file. */
export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** Readable messages for path refusals and common file-system errors; anything else is rethrown. */
export async function guard(label: string, run: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try { return await run(); }
  catch (error) {
    if (error instanceof WorkspacePathError) return failure(error.message);
    switch (errorCode(error)) {
      case 'ENOENT': return failure(`"${label}" does not exist.`);
      case 'EACCES': case 'EPERM': return failure(`Permission denied for "${label}".`);
      case 'EISDIR': return failure(`"${label}" is a directory.`);
      case 'ENOTDIR': return failure(`Part of "${label}" is a file, not a directory.`);
      case 'ENOSPC': return failure('The disk is full.');
      default: throw error;
    }
  }
}
