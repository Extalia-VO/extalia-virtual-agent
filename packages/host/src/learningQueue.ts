import type { ToolResultEntry } from '@extalia/runtime';
import type { LearningRecoveryRecord, ObservedMemoryScope, RustLearningInputs, RustLearningPort } from './rustLearning.js';
import { LEARNING_EVIDENCE_CHUNK_UNITS } from './automaticLearning.js';

export type NativeLearningQueueInput = Omit<RustLearningInputs['queue.capture'], 'evidence' | 'intakeId'> & {
  evidence: readonly ToolResultEntry[];
};

/** Durable capture admission only. Rust owns evidence selection, redaction and queued state. */
export class LearningQueueAdmissions {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly backend: RustLearningPort) {}
  get isBusy(): boolean { return this.pending.size > 0; }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Learning capture is closing.'));
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  native(input: NativeLearningQueueInput, assertCurrent: () => void | Promise<void>): Promise<LearningRecoveryRecord> {
    return this.track(async () => {
      await assertCurrent();
      let intakeId: string | undefined;
      try {
        intakeId = (await this.backend.process('evidence.begin', {})).intakeId;
        evidence: for (const entry of input.evidence) {
          let offset = 0;
          do {
            await assertCurrent();
            let end = Math.min(entry.content.length, offset + LEARNING_EVIDENCE_CHUNK_UNITS);
            if (end < entry.content.length && /[\uD800-\uDBFF]/u.test(entry.content[end - 1]!) && /[\uDC00-\uDFFF]/u.test(entry.content[end]!)) end--;
            const reply = await this.backend.process('evidence.append', { intakeId, toolCallId: entry.toolCallId, name: entry.name,
              isError: entry.isError, chunk: entry.content.slice(offset, end), final: end === entry.content.length });
            if (reply.complete) break evidence;
            offset = end;
          } while (offset < entry.content.length);
        }
        await assertCurrent();
        const { evidence: _evidence, ...binding } = input;
        const captured = await this.backend.process('queue.capture', { ...binding, intakeId });
        intakeId = undefined;
        return captured.record;
      } finally {
        if (intakeId) await this.backend.process('evidence.release', { intakeId }).catch(() => undefined);
      }
    });
  }

  observed(input: RustLearningInputs['observed.queueCapture'], assertCurrent: () => void | Promise<void>): Promise<LearningRecoveryRecord> {
    return this.track(async () => {
      await assertCurrent();
      return (await this.backend.process('observed.queueCapture', input)).record;
    });
  }

  /** No capture outlives profile/daemon ownership, even after the foreground shutdown grace. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}

/** Explicit wire projection prevents response-only metadata from becoming authority input. */
export function learningQueueBinding(record: LearningRecoveryRecord) {
  if (record.state !== 'queued' || !record.queue) throw new Error('The learning source is no longer queued.');
  const { jobId, profileId, workspaceId, sessionId, runId, promptSha256, destinationRevision, routeFingerprint, policy, observedSource } = record;
  return { jobId, profileId, workspaceId, sessionId, runId, promptSha256, destinationRevision, routeFingerprint, policy,
    ...(observedSource ? { observedSource } : {}), queueRevision: record.queue.revision };
}

/** JSON key order differs across Rust and JavaScript; scope equality is field equality. */
export function sameLearningObservedScope(left: ObservedMemoryScope, right: ObservedMemoryScope): boolean {
  return left.profileId === right.profileId && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
    && left.sourceId === right.sourceId && left.nativeSessionId === right.nativeSessionId && left.boundary === right.boundary;
}
