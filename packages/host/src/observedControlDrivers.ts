import { randomUUID } from 'node:crypto';
import type { ObservedCliResumeService } from './observedCliResumeService.js';
import type { ObservedCodexService } from './observedCodexService.js';
import type { ObservedCodexQueueService } from './observedCodexQueueService.js';
import type { ObservedHermesService } from './observedHermesService.js';
import type { ObservedReplyChannels } from './observedReplyChannel.js';
import type { ObservedInboxChannels } from './observedInboxChannel.js';
import { ObservedControlRefusal, type ObservedControlDriver, type ObservedControlDriverSnapshot } from './observedControlService.js';

interface Options {
  antigravity?: Pick<ObservedControlDriver, 'status' | 'dispatch'>;
  cliResume?: Pick<ObservedCliResumeService, 'driverStatus' | 'dispatch'>;
  sourceId(id: string): string | undefined;
  codex: Pick<ObservedCodexService, 'status' | 'send'>;
  codexQueue: Pick<ObservedCodexQueueService, 'status' | 'send'>;
  hermes: Pick<ObservedHermesService, 'status' | 'send'>;
  replies: Pick<ObservedReplyChannels, 'status' | 'answer'>;
  inboxes: Pick<ObservedInboxChannels, 'status' | 'send'>;
}
const assertCurrent = (expected: ObservedControlDriverSnapshot, actual: ObservedControlDriverSnapshot | undefined, action: string) => {
  if (!actual || expected.bindingId !== actual.bindingId || expected.generation !== actual.generation || !actual.actions.some(value => value === action)) throw new ObservedControlRefusal('The original attachment or action changed.');
};
const boundedToolMessage = (text: string) => {
  if (!text.trim() || text.length > 16_000 || Buffer.byteLength(text) > 16 * 1024) throw new ObservedControlRefusal('The cooperative message exceeds the tool limit.');
};

/** Adapts existing transports only. Inspection never connects, enables or launches them. */
export function createObservedControlDrivers(options: Options): ObservedControlDriver[] {
  const codex: ObservedControlDriver = {
    route: 'codex-native',
    async status(id) {
      if (options.sourceId(id) !== 'codex') return undefined;
      const status = await options.codex.status(id);
      if (status.state !== 'connected' || !status.connectionId) return undefined;
      return { bindingId: status.connectionId, generation: status.activeTurnId ?? 'idle',
        actions: status.canSend ? [status.activeTurnId ? 'steer' : 'start'] : [],
        relatedControls: [{ kind: 'questions', available: status.canAnswer }, { kind: 'approvals', available: status.canApprove === true }] };
    },
    async dispatch(id, input, snapshot) {
      assertCurrent(snapshot, await codex.status(id), input.action);
      if (input.action !== 'start' && input.action !== 'steer') throw new ObservedControlRefusal('Unsupported native action.');
      const result = await options.codex.send(id, { connectionId: snapshot.bindingId, text: input.text,
        ...(input.action === 'steer' ? { activeTurnId: String(snapshot.generation) } : {}) });
      return { state: result.delivery === 'submitted' ? 'submitted' : 'unknown' };
    },
  };
  const queue: ObservedControlDriver = {
    route: 'codex-queue',
    async status(id) {
      if (options.sourceId(id) !== 'codex') return undefined;
      const status = await options.codexQueue.status(id);
      return status.enabled && status.canQueue && status.threadId ? { bindingId: status.threadId, actions: ['queue'] } : undefined;
    },
    async dispatch(id, input, snapshot) {
      assertCurrent(snapshot, await queue.status(id), input.action);
      if (input.action !== 'queue') throw new ObservedControlRefusal('Unsupported queue action.');
      const result = await options.codexQueue.send(id, { text: input.text });
      return { state: result.delivery === 'queued' ? 'queued' : 'unknown', ...(result.delivery === 'queued' && result.messageId ? { messageId: result.messageId } : {}) };
    },
  };
  const hermes: ObservedControlDriver = {
    route: 'hermes-native',
    status(id) {
      if (options.sourceId(id) !== 'hermes') return undefined;
      const status = options.hermes.status(id);
      if (status.state !== 'connected' || !status.connectionId || !Number.isSafeInteger(status.executionGeneration)) return undefined;
      return { bindingId: status.connectionId, generation: status.executionGeneration,
        actions: status.canSend ? [status.running ? 'steer' : 'start'] : [],
        relatedControls: [{ kind: 'questions', available: status.canAnswer && status.requests.some(request => request.kind === 'clarify') },
          { kind: 'approvals', available: status.canAnswer && status.requests.some(request => request.kind === 'approval') }] };
    },
    async dispatch(id, input, snapshot) {
      assertCurrent(snapshot, await hermes.status(id), input.action);
      if (input.action !== 'start' && input.action !== 'steer' || typeof snapshot.generation !== 'number') throw new ObservedControlRefusal('Unsupported Hermes action.');
      const result = await options.hermes.send(id, { connectionId: snapshot.bindingId, executionGeneration: snapshot.generation, text: input.text, intent: input.action });
      return { state: result.delivery === 'submitted' ? 'submitted' : 'unknown' };
    },
  };
  const replies: ObservedControlDriver = {
    route: 'cooperative-tool',
    status(id) {
      const status = options.replies.status(id);
      return status.state === 'waitingForReply' && status.channelId ? { bindingId: status.channelId, actions: ['reply-tool'] } : undefined;
    },
    async dispatch(id, input, snapshot) {
      boundedToolMessage(input.text);
      assertCurrent(snapshot, await replies.status(id), input.action);
      if (input.action !== 'reply-tool') throw new ObservedControlRefusal('Unsupported cooperative action.');
      const result = options.replies.answer(id, { channelId: snapshot.bindingId, text: input.text });
      return { state: result.state === 'answered' ? 'submitted' : 'unknown' };
    },
  };
  const inboxes: ObservedControlDriver = {
    route: 'cooperative-inbox',
    status(id) {
      const status = options.inboxes.status(id);
      return status.state === 'connected' && status.channelId ? { bindingId: status.channelId, generation: status.expiresAt, actions: ['inbox-send'] } : undefined;
    },
    async dispatch(id, input, snapshot) {
      boundedToolMessage(input.text);
      assertCurrent(snapshot, await inboxes.status(id), input.action);
      if (input.action !== 'inbox-send') throw new ObservedControlRefusal('Unsupported inbox action.');
      const operationId = randomUUID();
      const result = options.inboxes.send(id, { channelId: snapshot.bindingId, text: input.text, operationId });
      if (result.problem || result.state !== 'connected') {
        throw new ObservedControlRefusal(result.problem ?? 'This inbox channel is no longer active.');
      }
      const receipt = result.receipts?.find(receipt => receipt.operationId === operationId);
      return { state: receipt && ['queued', 'delivered', 'acknowledged'].includes(receipt.state) ? 'queued' : 'unknown', ...(receipt ? { messageId: receipt.messageId } : {}) };
    },
  };
  return [codex, queue, hermes, replies, inboxes, ...(options.antigravity ? [{ route: 'antigravity-native' as const, ...options.antigravity }] : []), ...(options.cliResume ? [{ route: 'official-cli-resume' as const, status: (id: string) => options.cliResume!.driverStatus(id), dispatch: (id, input, snapshot) => options.cliResume!.dispatch(id, input, snapshot) } satisfies ObservedControlDriver] : [])];
}
