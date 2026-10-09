/**
 * Credential detection and masking for imported, exported and displayed text.
 * Pattern-based detection is a safety net, not a guarantee; credentials must
 * still never be imported or exported deliberately.
 */

const SECRET_PATTERNS: readonly [RegExp, boolean][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, false],
  [/\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}/g, false],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, false],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, false],
  [/\bAKIA[0-9A-Z]{16}\b/g, false],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, false],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, false],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, false],
  // Assignments keep their key so the text stays readable: `api_key=[redacted]`.
  [/(?<![A-Za-z0-9])((?:api[_-]?key|secret|token|passwd|password|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}{]{6,}/gi, true],
];
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

export const REDACTED = '[redacted]';

/** Mask common credentials while keeping the surrounding text readable. */
export function redact(input: string): string {
  let value = input.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const [pattern, keepPrefix] of SECRET_PATTERNS) value = value.replace(pattern, keepPrefix ? `$1${REDACTED}` : REDACTED);
  return value;
}

/** Number of likely credentials in a text, for import previews and diagnostics. */
export function countSecrets(input: string): number {
  let count = input.match(URL_CREDENTIALS)?.length ?? 0;
  for (const [pattern] of SECRET_PATTERNS) count += input.match(pattern)?.length ?? 0;
  return count;
}

export function clip(input: string, limit: number): string {
  const value = input.replace(/\0/g, '');
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

/** Single-line, redacted, bounded text for labels. */
export function safeLabel(input: unknown, limit = 60): string {
  // eslint-disable-next-line no-control-regex
  const value = String(input ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clip(redact(value), limit);
}

/** Multi-line, redacted, bounded text for transcripts. */
export function safeText(input: unknown, limit = 20_000): string {
  return clip(redact(String(input ?? '').replace(/\r\n/g, '\n')), limit);
}

const CREDENTIAL_KEYS = new Set(['apikey', 'secret', 'password', 'token', 'credentials', 'authorization', 'bearer', 'privatekey', 'accesstoken', 'refreshtoken', 'clientsecret']);

/** True for object keys that conventionally hold credentials (`api_key`, `accessToken`, …). */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

/**
 * Reject structured credential fields anywhere in a value. Imports and exports
 * refuse such data outright instead of trying to clean it.
 */
export function assertNoCredentialFields(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, nested] of Object.entries(item)) {
      if (isCredentialKey(key)) throw new Error('Structured credentials are not accepted.');
      pending.push(nested);
    }
  }
}
