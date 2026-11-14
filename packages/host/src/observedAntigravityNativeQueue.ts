import { redact } from '@extalia/core';
import type { ObservedCodexNativeQueueItem, ObservedCodexNativeQueueStatus, ObservedInboxStatus } from '@extalia/platform';

const MAX_ITEMS = 50;
const MAX_TEXT_CHARS = 16_000;
const MAX_TOTAL_BYTES = 256 * 1024;
const QUEUED_STEP_STATUSES = new Set([
  'CORTEX_STEP_STATUS_QUEUED',
  'CORTEX_STEP_STATUS_PENDING',
  'CORTEX_STEP_STATUS_WAITING',
]);
const FINISHED_STEP_STATUSES = new Set([
  'CORTEX_STEP_STATUS_DONE',
  'CORTEX_STEP_STATUS_COMPLETED',
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_CANCELLED',
]);

export interface AntigravityDaemonRef {
  lsAddress: string;
  csrfToken: string;
}

function clipText(raw: string, remainingBytes: number): { text: string; truncated: boolean; bytes: number } {
  let text = redact(raw);
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    truncated = true;
  }
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength > remainingBytes) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (encoder.encode(text.slice(0, mid)).byteLength <= remainingBytes) low = mid;
      else high = mid - 1;
    }
    text = text.slice(0, low);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    truncated = true;
  }
  return { text, truncated, bytes: encoder.encode(text).byteLength };
}

function extractUserInputText(userInput: unknown): string {
  if (!userInput || typeof userInput !== 'object') return '';
  const obj = userInput as { items?: unknown; userResponse?: unknown; text?: unknown };
  if (Array.isArray(obj.items)) {
    const joined = obj.items
      .map(item => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  if (typeof obj.userResponse === 'string' && obj.userResponse.trim()) return obj.userResponse;
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
  return '';
}

function collectRawQueuedEntries(trajectoryPayload: unknown): Array<{ id: string; text: string }> {
  if (!trajectoryPayload || typeof trajectoryPayload !== 'object') return [];
  const root = trajectoryPayload as {
    status?: unknown;
    trajectory?: {
      steps?: Array<{ type?: unknown; status?: unknown; userInput?: unknown }>;
      queuedMessages?: unknown;
      queuedUserInputs?: unknown;
    };
  };
  const entries: Array<{ id: string; text: string }> = [];
  const seenIds = new Set<string>();
  const addEntry = (id: string, text: string) => {
    const clean = text.trim();
    if (!clean || seenIds.has(id)) return;
    seenIds.add(id);
    entries.push({ id, text: clean });
  };

  for (const list of [root.trajectory?.queuedMessages, root.trajectory?.queuedUserInputs]) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, index) => {
      if (typeof entry === 'string') addEntry(`queued-${index}`, entry);
      else if (entry && typeof entry === 'object') {
        const obj = entry as { id?: unknown; messageId?: unknown; clientMessageId?: unknown };
        const id = typeof obj.clientMessageId === 'string' && obj.clientMessageId
          ? obj.clientMessageId
          : typeof obj.messageId === 'string' && obj.messageId
            ? obj.messageId
            : typeof obj.id === 'string' && obj.id
              ? obj.id
              : `queued-${index}`;
        addEntry(id, extractUserInputText(obj));
      }
    });
  }

  const steps = Array.isArray(root.trajectory?.steps) ? root.trajectory!.steps : [];
  const running = root.status === 'CASCADE_RUN_STATUS_RUNNING';
  const lastActiveIdx = steps.reduce((last, step, idx) => {
    if (step?.status === 'CORTEX_STEP_STATUS_RUNNING' || (step?.type && step.type !== 'CORTEX_STEP_TYPE_USER_INPUT' && !FINISHED_STEP_STATUSES.has(String(step.status ?? '')))) {
      return idx;
    }
    return last;
  }, -1);

  steps.forEach((step, index) => {
    if (!step || step.type !== 'CORTEX_STEP_TYPE_USER_INPUT') return;
    const status = typeof step.status === 'string' ? step.status : '';
    const explicitQueued = QUEUED_STEP_STATUSES.has(status);
    const trailingQueuedWhileRunning = running && lastActiveIdx >= 0 && index > lastActiveIdx && !FINISHED_STEP_STATUSES.has(status);
    if (!explicitQueued && !trailingQueuedWhileRunning) return;
    const userInput = step.userInput as { clientMessageId?: unknown } | undefined;
    const id = typeof userInput?.clientMessageId === 'string' && userInput.clientMessageId
      ? userInput.clientMessageId
      : `step-${index}`;
    addEntry(id, extractUserInputText(userInput));
  });

  return entries;
}

/** Read Antigravity's native queued prompts (cascade queue + pending cooperative inbox receipts). */
export async function readAntigravityNativeQueue(options: {
  sessionId: string;
  nativeSessionId: string;
  watching: boolean;
  labelsOnly: boolean;
  daemons: readonly AntigravityDaemonRef[];
  inbox?: ObservedInboxStatus;
  fetchFn: typeof fetch;
}): Promise<ObservedCodexNativeQueueStatus> {
  if (options.labelsOnly) return { sessionId: options.sessionId, state: 'private', items: [] };
  if (!options.watching) return { sessionId: options.sessionId, state: 'unavailable', items: [] };

  let daemonReachable = false;
  let trajectoryPayload: unknown;
  for (const daemon of options.daemons) {
    try {
      const response = await options.fetchFn(
        `http://${daemon.lsAddress}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': daemon.csrfToken,
          },
          body: JSON.stringify({ cascadeId: options.nativeSessionId }),
          signal: AbortSignal.timeout(1500),
        },
      );
      if (!response.ok) continue;
      daemonReachable = true;
      trajectoryPayload = await response.json();
      break;
    } catch {
      // Try next discovered daemon.
    }
  }

  const rawEntries = collectRawQueuedEntries(trajectoryPayload);
  const inboxReceipts = options.inbox?.receipts?.filter(item => item.state === 'queued' || item.state === 'delivered') ?? [];
  for (const receipt of inboxReceipts) {
    if (!rawEntries.some(existing => existing.id === receipt.messageId)) {
      rawEntries.push({ id: receipt.messageId, text: receipt.operationId ? `${receipt.state} (${receipt.operationId})` : receipt.state });
    }
  }

  const hasActiveInbox = options.inbox?.state === 'connected';
  if (!daemonReachable && !hasActiveInbox) {
    return { sessionId: options.sessionId, state: 'unavailable', items: [] };
  }

  let remainingBytes = MAX_TOTAL_BYTES;
  let truncated = false;
  const items: ObservedCodexNativeQueueItem[] = [];
  for (const entry of rawEntries.slice(0, MAX_ITEMS)) {
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }
    const clipped = clipText(entry.text, remainingBytes);
    remainingBytes -= clipped.bytes;
    if (clipped.truncated) truncated = true;
    items.push({
      id: entry.id,
      text: clipped.text,
      nonTextItems: 0,
      ...(clipped.truncated ? { truncated: true } : {}),
    });
  }
  if (rawEntries.length > items.length) truncated = true;

  return {
    sessionId: options.sessionId,
    threadId: options.nativeSessionId,
    state: 'ready',
    items,
    observedAt: new Date().toISOString(),
    ...(truncated ? { truncated: true } : {}),
  };
}
