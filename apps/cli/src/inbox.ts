import { isObservedInboxRequest, pollObservedInbox } from '@extalia/host';
import type { CliHost } from './cli';

/** Pairing secrets are never included in parse errors or diagnostics. */
export function parseInboxArgs(args: readonly string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equal = arg.indexOf('='), flag = equal > 0 ? arg.slice(0, equal) : arg;
    if (!['--url', '--token', '--ack', '--wait-ms'].includes(flag) || flag in values) return undefined;
    const value = equal > 0 ? arg.slice(equal + 1) : args[++index];
    if (value === undefined) return undefined;
    values[flag] = value;
  }
  if (values['--wait-ms'] !== undefined && !/^\d{1,5}$/.test(values['--wait-ms'])) return undefined;
  const request = { url: values['--url'], token: values['--token'],
    ...(values['--ack'] !== undefined ? { ack: values['--ack'] } : {}),
    ...(values['--wait-ms'] !== undefined ? { waitMs: Number(values['--wait-ms']) } : {}) };
  return isObservedInboxRequest(request) ? request : undefined;
}

export async function runInbox(host: CliHost, args: readonly string[]): Promise<number> {
  const request = parseInboxArgs(args);
  if (!request) {
    host.err('inbox: Usage: extalia inbox --url <paired loopback URL> --token <secret> [--ack <message ID>] [--wait-ms <0..25000>]');
    return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await pollObservedInbox(request, { signal: controller.signal });
    host.out(JSON.stringify(result));
    return result.status === 'message' || result.status === 'empty' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
