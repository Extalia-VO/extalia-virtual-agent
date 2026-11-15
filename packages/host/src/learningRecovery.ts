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
export interface LearningRecoveryCatalog {
  candidates: LearningRecoveryCandidate[];
  /** Some records could not be inspected or exceeded the bounded listing. */
  incomplete?: boolean;
}
const catalog = (value: LearningRecoveryCandidate[] | LearningRecoveryCatalog): LearningRecoveryCatalog =>
  Array.isArray(value) ? { candidates: value } : value;

/** Presentation/admission only. Rust owns durable state, source contents and replay decisions. */
export class LearningRecovery {
  private changing = false;
  private readonly pending = new Map<string, string>();
  private restoration?: Promise<void>;
  private restoring = false;

  constructor(private readonly options: {
    queue: LearningSchedule;
    /** Return only current, independently authorized source/destination bindings. */
    list(): Promise<LearningRecoveryCandidate[] | LearningRecoveryCatalog>;
    /** Reauthorize before constructing fresh provider, readers and writer pins. */
    prepare(record: LearningRecoveryRecord, scheduleId: string): Promise<ScheduledLearningInput>;
  }) {}

  /** Called once after source discovery. Only never-started work returns to its full quiet interval. */
  restoreQueued(): Promise<void> {
    if (this.restoration) return this.restoration;
    if (this.changing) return Promise.reject(new Error('A learning action is already being applied.'));
    this.restoring = true;
    this.restoration = (async () => {
      try {
        let candidates: LearningRecoveryCandidate[];
        try { candidates = catalog(await this.options.list()).candidates; }
        catch { return; } // Backend recovery must not prevent the rest of Extalia from opening.
        for (const { record } of candidates.slice(0, 64)) {
          if (record.active || record.state !== 'queued' || !record.queue) continue;
          const existing = this.options.queue.snapshot().jobs;
          if (existing.some(job => job.id === record.runId && (job.state === 'scheduled' || job.state === 'running'))) continue;
          try {
            const prepared = await this.options.prepare(record, record.runId);
            this.assertPrepared(record, prepared, record.runId);
            if (!await prepared.validate()) continue;
            if (this.options.queue.schedule({ ...prepared, delaySeconds: record.queue.delaySeconds })) this.pending.set(record.jobId, record.runId);
          } catch { /* Changed authority or a full local queue leaves the retained record available for inspection. */ }
        }
      } finally { this.restoring = false; }
    })();
    return this.restoration;
  }

  private assertPrepared(record: LearningRecoveryRecord, prepared: ScheduledLearningInput, id: string): void {
    if (prepared.id !== id || prepared.profileId !== record.profileId || prepared.workspaceId !== record.workspaceId || prepared.sessionId !== record.sessionId) {
      throw new Error('The learning recovery source changed.');
    }
  }

  private async load(): Promise<{ snapshot: LearningScheduleSnapshot; records: Map<string, LearningRecoveryRecord> }> {
    let candidates: LearningRecoveryCandidate[] = [], unavailable = false, incomplete = false;
    try { const listed = catalog(await this.options.list()); candidates = listed.candidates; incomplete = listed.incomplete === true; }
    catch { unavailable = true; }
    const base = this.options.queue.snapshot();
    const records = new Map<string, LearningRecoveryRecord>();
    const recovered: LearningScheduleJob[] = [];
    for (const candidate of candidates.slice(0, 64)) {
      const { record } = candidate;
      if (record.active || record.state === 'terminal') continue;
      if (record.state === 'queued' && base.jobs.some(job => job.id === record.runId && (job.state === 'scheduled' || job.state === 'running'))) continue;
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
        ...(record.queue ? { delaySeconds: record.queue.delaySeconds } : {}),
        recovery: { state: record.state, modelRequests: record.modelRequests, reads: record.reads, skillReviewRequired: record.skillReviewRequired },
      });
    }
    const revision = recovered.length || unavailable || incomplete
      ? createHash('sha256').update(JSON.stringify([base.revision, recovered, [...records.values()], unavailable, incomplete])).digest('hex') : base.revision;
    return { snapshot: { ...base, revision, jobs: [...base.jobs, ...recovered], ...(unavailable ? { recoveryUnavailable: true } : {}),
      ...(incomplete ? { recoveryIncomplete: true } : {}) }, records };
  }

  async snapshot(): Promise<LearningScheduleSnapshot> { return (await this.load()).snapshot; }

  async act(input: LearningScheduleAction): Promise<LearningScheduleSnapshot> {
    if (this.changing || this.restoring) throw new Error('Another learning action is being applied. Refresh before trying again.');
    this.changing = true;
    try {
      const current = await this.load();
      if (input.revision !== current.snapshot.revision) throw new Error('Learning checkpoints changed. Refresh before trying again.');
      if (input.action !== 'resume') {
        await this.options.queue.act({ ...input, revision: this.options.queue.snapshot().revision });
      } else {
        const record = current.records.get(input.id);
        if (!record || record.active || !['queued', 'resumable', 'publication'].includes(record.state) || record.state === 'queued' && !record.queue) {
          throw new Error('This checkpoint cannot be safely resumed. Inspect the session and saved receipts.');
        }
        const id = `recovered-${randomUUID()}`;
        const prepared = await this.options.prepare(record, id);
        this.assertPrepared(record, prepared, id);
        if (!this.options.queue.schedule(prepared)) throw new Error('The learning queue could not admit this recovery. Try again after current work finishes.');
        this.pending.set(record.jobId, id);
        await this.options.queue.act({ id, revision: this.options.queue.snapshot().revision, action: 'run-now' });
      }
      return (await this.load()).snapshot;
    } finally { this.changing = false; }
  }
}
