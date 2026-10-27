import type { Messages } from '../i18n';

export type ConnectionFailure = keyof Messages['connection']['failures'];

/**
 * Classify what a host or provider call threw. Raw messages (validation
 * paths, HTTP status lines, network error codes) are never shown to the user.
 */
export function connectionFailure(raw: string): ConnectionFailure {
  const text = raw.toLowerCase();
  if (/(^|\b)(name|model|baseurl|base url|api|credential|features|orchestration)\b[^.]*: (expected|must|invalid|required)|expected a (string|number|boolean|object)/.test(text)) return 'invalid';
  if (/rejected the credentials|\b40[13]\b|unauthori[sz]ed|invalid api key|incorrect api key/.test(text)) return 'credentials';
  if (/returned 404|\bnot found\b/.test(text)) return 'notFound';
  if (/returned 429|rate limit/.test(text)) return 'rateLimited';
  if (/returned 5\d\d/.test(text)) return 'serverError';
  if (/timeout|timed out|aborted/.test(text)) return 'timeout';
  if (/fetch failed|econn|enotfound|eai_again|ehostunreach|enetunreach|network|could not be reached|socket|certificate/.test(text)) return 'unreachable';
  return 'generic';
}

/** Friendly, translated text for a failed connection test or save. */
export const friendlyConnectionError = (t: Messages, raw: string): string => t.connection.failures[connectionFailure(raw)];
