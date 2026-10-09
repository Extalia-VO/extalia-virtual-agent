import { isUtcTimestamp } from '@extalia/protocol';

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Run a throwing reader and turn its first error into a DecodeResult. */
export function decode<T>(read: () => T): DecodeResult<T> {
  try { return { ok: true, value: read() }; }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : 'Invalid data.'] }; }
}

export function object(value: unknown, field = 'value'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: expected an object.`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, options: { allowEmpty?: boolean; max?: number; singleLine?: boolean } = {}): string {
  const { allowEmpty = false, max = 200_000, singleLine = false } = options;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${field}: expected a string${allowEmpty ? '' : ' with content'}.`);
  if (value.length > max) throw new Error(`${field}: longer than ${max} characters.`);
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${field}: must be a single line.`);
  return value;
}

export function optionalText(value: unknown, field: string, options?: Parameters<typeof text>[2]): string | undefined {
  return value === undefined ? undefined : text(value, field, options);
}

export function timestamp(value: unknown, field: string): string {
  if (!isUtcTimestamp(value)) throw new Error(`${field}: expected a UTC timestamp such as 2026-01-31T12:00:00.000Z.`);
  return value;
}

/** Lowercase, URL-safe identifiers used for slugs and source ids. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slug(value: unknown, field: string): string {
  const result = text(value, field, { singleLine: true });
  if (!SLUG_PATTERN.test(result)) throw new Error(`${field}: use lowercase letters, numbers and hyphens.`);
  return result;
}

/** Entity ids: single line, bounded, no surrounding whitespace. */
export function entityId(value: unknown, field: string): string {
  const result = text(value, field, { singleLine: true, max: 200 });
  if (result.trim() !== result) throw new Error(`${field}: must not start or end with whitespace.`);
  return result;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new Error(`${field}: expected one of ${values.join(', ')}.`);
  return value as T;
}
