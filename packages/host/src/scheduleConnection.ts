/** A readiness probe never submits model instructions or decides that accepted work is retryable. */
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
export type ScheduleConnectionAvailability = 'ready' | 'connection-unavailable';

function knownUnreachable(error: unknown, seen = new Set<Error>()): boolean {
  if (!(error instanceof Error) || seen.has(error) || seen.size >= 16) return false;
  seen.add(error);
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(child => knownUnreachable(child, seen));
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  return error.cause !== undefined && knownUnreachable(error.cause, seen);
}

/**
 * Use the same HTTP transport and configured endpoint as the Native provider.
 * Any HTTP response proves reachability, including auth/method/redirect errors.
 * Unknown failures, deadlines and TLS errors cannot establish safe deferral.
 */
export async function checkScheduleConnection(baseUrl: string,
  transport: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<ScheduleConnectionAvailability> {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ready';
    const response = await transport(url.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => undefined);
    return 'ready';
  } catch (error) {
    return knownUnreachable(error) ? 'connection-unavailable' : 'ready';
  }
}
