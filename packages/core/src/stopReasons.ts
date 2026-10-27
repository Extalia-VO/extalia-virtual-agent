import type { StopReason } from '@extalia/protocol';

export type { StopReason } from '@extalia/protocol';

/**
 * v0.0.43: why an agent stopped, read from the error text and the error code
 * an agent app reports (a transcript error row, a failure hook, a rollout error
 * event). The wording of provider and app error messages is matched loosely;
 * text that matches nothing (and an unknown code) gives `undefined`, a generic
 * failure. Nothing here is shown to the user: UI text comes from the catalog.
 */
export function stopReasonOf(text?: unknown, code?: unknown): StopReason | undefined {
  const message = typeof text === 'string' ? text.slice(0, 4_000) : '';
  // Plan and credit exhaustion first: some apps report a used-up plan as a rate limit (HTTP 429).
  if (QUOTA.test(message)) return 'quota';
  if (CONTEXT.test(message)) return 'context';
  if (AUTH.test(message)) return 'auth';
  if (RATE.test(message)) return 'rate-limit';
  if (INTERRUPTED.test(message)) return 'interrupted';
  if (OVERLOADED.test(message)) return 'overloaded';
  if (CRASH.test(message)) return 'crash';
  return codeReason(code);
}

const QUOTA = /\b(?:usage|session|weekly|daily|monthly|plan|spend(?:ing)?|token) limit\b|\bhit your (?:\w+ )?limit\b|\bquota\b|credit balance|\b(?:insufficient|out of|no (?:more|remaining)) (?:credits?|balance|funds|tokens|quota)\b|\bbilling\b|exhausted your|resource[_ ]exhausted|\bout of tokens\b|limit (?:reached|exceeded)[^.]*\b(?:upgrade|resets?|try again (?:at|after|in))|\bupgrade (?:to|your plan)\b/i;
const CONTEXT = /prompt is too long|context(?:[ _]window|[ _]length)(?:[ _]exceeded| is full)?|maximum context|too many tokens|input is too long/i;
const AUTH = /(?:^|\s)\/login\b|please (?:log|sign) ?in|not (?:logged|signed) in|log ?in again|sign ?in again|unauthori[sz]ed|authentication(?:[ _]failed| error)|invalid (?:api[ _]?key|x-api-key|credentials)|(?:api[ _]?key|oauth token|access token|token) (?:has )?(?:expired|was revoked|is invalid)|\b401\b/i;
const RATE = /rate[ _-]?limit|too many requests|\b429\b|requests? per (?:minute|min|second)/i;
const INTERRUPTED = /request interrupted|interrupted by (?:the )?user|aborted by (?:the )?user|cancell?ed by (?:the )?user|\binterrupted\b/i;
const OVERLOADED = /overload|\b5(?:00|02|03|04|29)\b|service unavailable|internal server error|server error|bad gateway|temporarily unavailable|capacity/i;
const CRASH = /connection (?:lost|reset|closed|refused|error)|stream (?:disconnected|error|closed)|disconnected|network error|socket hang up|econnreset|etimedout|timed? ?out|crash|exited unexpectedly|\bkilled\b|sigkill|sigterm|sigsegv/i;

/** Error codes of the apps' own failure reports (Claude Code `error`, Codex `codex_error_info`, provider error types). */
function codeReason(code: unknown): StopReason | undefined {
  const keys = typeof code === 'string' ? [code]
    : code && typeof code === 'object' && !Array.isArray(code) ? Object.keys(code) : [];
  for (const raw of keys) {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!key) continue;
    if (/billing|quota|usage_limit|credit|insufficient/.test(key)) return 'quota';
    if (/context_window|context_length|prompt_too_long/.test(key)) return 'context';
    if (/auth|unauthori[sz]ed|api_key|permission_denied|forbidden|login/.test(key)) return 'auth';
    if (/rate_limit|too_many_requests/.test(key)) return 'rate-limit';
    if (/interrupt|abort|cancel/.test(key)) return 'interrupted';
    if (/overload|server_error|internal_server|unavailable/.test(key)) return 'overloaded';
    if (/connection|stream|disconnect|network|timeout|crash/.test(key)) return 'crash';
  }
  return undefined;
}

/** English fallback text for a failed turn of each reason, for event bodies (`turn.failed.error`). */
export const STOP_REASON_TEXT: Readonly<Record<StopReason, string>> = {
  quota: 'Out of tokens or quota',
  'rate-limit': 'Rate limited',
  overloaded: 'The service is overloaded or unavailable',
  auth: 'Sign-in needed',
  context: 'The context window is full',
  crash: 'Stopped unexpectedly',
  interrupted: 'Interrupted',
};
