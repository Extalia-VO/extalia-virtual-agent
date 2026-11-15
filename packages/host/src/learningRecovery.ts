import { createHash, randomUUID } from 'node:crypto';
import type { Connection } from '@extalia/core';
import type { LearningScheduleAction, LearningScheduleJob, LearningScheduleSnapshot } from '@extalia/platform';
import type { LearningRecoveryRecord } from './rustLearning.js';
import type { LearningSchedule, ScheduledLearningInput } from './learningSchedule.js';

/** Only routing and authority metadata enter the digest; never a credential value. */
export function learningRouteFingerprint(connection: Connection, source: unknown): string {
  return createHash('sha256').update(JSON.stringify(['learning-route-v1', {
    id: connection.id, api: connection.api, preset: connection.preset, baseUrl: connection.baseUrl,
    model: connection.model, effort: connection.effort ?? null, features: connection.features,
    inputTokenLimit: connection.inputTokenLimit ?? null,
    contextOptimization: connection.contextOptimization ?? { mode: 'local' },
  }, source])).digest('hex');
}

export interface LearningRecoveryCandidate {
  record: LearningRecoveryRecord;
  profileName: string;
  workspaceName?: string;
  sessionName?: string;
}

/** Presentation/admission only. Rust owns durable state, source contents and replay decisions. */
export class LearningRecovery {
  private changing = false;
  private readonly pending = new Map<string, string>();

  constructor(private readonly options: {
    queue: LearningSchedule;
    /** Return only current, independently authorized source/destination bindings. */
    list(): Promise<LearningRecoveryCandidate[]>;
    /** Reauthorize before constructing fresh provider, readers and writer pins. */
    prepare(record: LearningRecoveryRecord, scheduleId: string): Promise<ScheduledLearningInput>;
  }) {}

  private async load(): Promise<{ snapshot: LearningScheduleSnapshot; records: Map<string, LearningRecoveryRecord> }> {
    let candidates: LearningRecoveryCandidate[] = [], unavailable = false;
    try { candidates = await this.options.list(); }
    catch { unavailable = true; }
    const base = this.options.queue.snapshot();
    const records = new Map<string, LearningRecoveryRecord>();
    const recovered: LearningScheduleJob[] = [];
    for (const candidate of candidates.slice(0, 64)) {
      const { record } = candidate;
      if (record.active || record.state === 'terminal') continue;
      const pending = this.pending.get(record.jobId);
      if (pending && base.jobs.some(job => job.id === pending && (job.state === 'scheduled' || job.state === 'running'))) continue;
      if (pending) this.pending.delete(record.jobId);
      const id = `recovery:${record.jobId}`;
      if (records.has(id)) continue;
      records.set(id, structuredClone(record));
      const stamp = new Date(record.updatedAt).toISOString();
      recovered.push({ id, workspaceId: record.workspaceId, profileId: record.profileId,
        profileName: candidate.profileName, sessionId: record.sessionId,
        ...(candidate.workspaceName ? { workspaceName: candidate.workspaceName } : {}),
        ...(candidate.sessionName ? { sessionName: candidate.sessionName } : {}),
        kind: 'learning', state: 'cancelled', reason: 'shutdown', createdAt: stamp, dueAt: stamp,
        recovery: { state: record.state, modelRequests: record.modelRequests, reads: record.reads, skillReviewRequired: record.skillReviewRequired },
      });
    }
    const revision = recovered.length || unavailable
      ? createHash('sha256').update(JSON.stringify([base.revision, recovered, [...records.values()], unavailable])).digest('hex') : base.revision;
    return { snapshot: { ...base, revision, jobs: [...base.jobs, ...recovered], ...(unavailable ? { recoveryUnavailable: true } : {}) }, records };
  }

  async snapshot(): Promise<LearningScheduleSnapshot> { return (await this.load()).snapshot; }

  async act(input: LearningScheduleAction): Promise<LearningScheduleSnapshot> {
    if (this.changing) throw new Error('Another learning action is being applied. Refresh before trying again.');
    this.changing = true;
    try {
      const current = await this.load();
      if (input.revision !== current.snapshot.revision) throw new Error('Learning checkpoints changed. Refresh before trying again.');
      if (input.action !== 'resume') {
        this.options.queue.act({ ...input, revision: this.options.queue.snapshot().revision });
      } else {
        const record = current.records.get(input.id);
        if (!record || record.active || !['resumable', 'publication'].includes(record.state)) {
          throw new Error('This checkpoint cannot be safely resumed. Inspect the session and saved receipts.');
        }
        const id = `recovered-${randomUUID()}`;
        const prepared = await this.options.prepare(record, id);
        if (prepared.id !== id || prepared.profileId !== record.profileId || prepared.workspaceId !== record.workspaceId || prepared.sessionId !== record.sessionId) {
          throw new Error('The learning recovery source changed.');
        }
        if (!this.options.queue.schedule(prepared)) throw new Error('The learning queue could not admit this recovery. Try again after current work finishes.');
        this.pending.set(record.jobId, id);
        this.options.queue.act({ id, revision: this.options.queue.snapshot().revision, action: 'run-now' });
      }
      return (await this.load()).snapshot;
    } finally { this.changing = false; }
  }
}
