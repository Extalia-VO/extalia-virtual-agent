/** IPC channels between the preload script and the main process. Keep this list short and audited. */
export const IPC = {
  hostInfo: 'extalia:host-info',
  selectDirectory: 'extalia:select-directory',
  /** invoke(method, args): one agent host call. */
  agents: 'extalia:agents',
  /** main → renderer: live Extalia Protocol events. */
  agentEvent: 'extalia:agent-event',
  /** invoke(action): status | check | install | postpone. */
  update: 'extalia:update',
  /** main → renderer: update status changes. */
  updateStatus: 'extalia:update-status',
} as const;

/**
 * Reply of invoke channels whose errors the user may see. Electron prefixes
 * errors thrown by handlers with internal text, so failures travel as data and
 * the preload rethrows them as plain `Error`s.
 */
export type IpcReply<T> = { ok: true; value: T } | { ok: false; error: string };

/** A short message that is safe to show: no stack, no internal prefixes. */
export function safeMessage(error: unknown, fallback = 'Something went wrong.'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  return firstLine ? firstLine.slice(0, 300) : fallback;
}

export async function reply<T>(work: () => T | Promise<T>): Promise<IpcReply<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }
}

export function unwrap<T>(response: IpcReply<T>): T {
  if (response.ok) return response.value;
  throw new Error(response.error);
}
