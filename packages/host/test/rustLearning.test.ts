import { generatedSkillMetadata, completeSkillInstructions } from './generatedSkillFixtures.js';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../src/daemon/index.js';
import { RustLearningBackend } from '../src/rustLearning.js';

function client(reply: (action: string) => Record<string, unknown>, capabilities: string[] = ['learning.process']) {
  return { usable: true, capabilities, request: vi.fn(async (_op: string, params: { action: string }) => ({ action: params.action, ...reply(params.action) })) };
}
const pin = { root: '/synthetic-vault', profileId: 'default', revision: 'revision-one', workspaceId: 'workspace_one', sessionId: 'session_one', purpose: 'learning' as const };

describe('connection-bound Rust learning client', () => {
  it('refuses missing capability before sending any operation', async () => {
    const peer = client(() => ({}), []), connect = vi.fn(async () => peer as unknown as DaemonClient);
    await expect(new RustLearningBackend(connect).process('note.pin', pin)).rejects.toMatchObject({ code: 'missing_capability' });
    expect(peer.request).not.toHaveBeenCalled();
  });

  it('never reconnects a pinned destination after its sidecar is lost', async () => {
    const original = client(() => ({ pinId: 'pin-one' })), replacement = client(() => ({ draftId: 'draft-one', path: 'Learning/workspace_one/run-one.md' }));
    const connect = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement);
    const backend = new RustLearningBackend(connect);
    await backend.process('note.pin', pin);
    original.usable = false;
    await expect(backend.process('note.prepare', { pinId: 'pin-one', record: {} })).rejects.toMatchObject({ code: 'missing_capability' });
    expect(connect).toHaveBeenCalledOnce(); expect(replacement.request).not.toHaveBeenCalled();
  });

  it('keeps drafts and staging tied to the issuing connection and retires consumed handles', async () => {
    const original = client(action => action === 'note.pin' ? { pinId: 'pin-one' } : action === 'note.prepare' ? { draftId: 'draft-one', path: 'Learning/workspace_one/run-one.md' } : { path: 'Learning/workspace_one/run-one.md' });
    const connect = vi.fn(async () => original as unknown as DaemonClient), backend = new RustLearningBackend(connect);
    await backend.process('note.pin', pin);
    await backend.process('note.prepare', { pinId: 'pin-one', record: {} });
    await backend.process('note.commit', { draftId: 'draft-one' });
    expect(connect).toHaveBeenCalledOnce();
    await expect(backend.process('note.commit', { draftId: 'draft-one' })).rejects.toMatchObject({ code: 'missing_capability' });
    expect(original.request).toHaveBeenCalledTimes(3);
  });

  it('refuses mismatched action acknowledgements', async () => {
    const peer = client(() => ({ action: 'note.release', pinId: 'pin-one' }));
    const backend = new RustLearningBackend(async () => peer as unknown as DaemonClient);
    await expect(backend.process('note.pin', pin)).rejects.toMatchObject({ code: 'malformed_reply' });
  });

  it('releasing one concurrent job preserves the other run connection for receipts and staging', async () => {
    let jobIndex = 0;
    const original = client(action => action === 'job.begin' ? { job: { jobId: `job-${++jobIndex}` } } : { released: true });
    const replacement = client(() => ({ claimed: true, stageId: 'replacement-stage', path: 'replacement' }));
    const connect = vi.fn(async () => original as unknown as DaemonClient), backend = new RustLearningBackend(connect);
    const begin = { ...pin, runId: 'run-one', promptSha256: 'a'.repeat(64), policy: { enabled: true, skills: true, notes: false }, evidence: [], tools: [] };
    await backend.process('job.begin', begin);
    await backend.process('job.begin', { ...begin, runId: 'run-two' });
    await backend.process('job.release', { jobId: 'job-1' });
    original.usable = false;
    connect.mockResolvedValue(replacement as unknown as DaemonClient);
    await expect(backend.process('receipt.claim', { profileId: 'default', contentSha256: 'b'.repeat(64), runId: 'run-two' })).rejects.toMatchObject({ code: 'missing_capability' });
    await expect(backend.process('skill.stage', { proposal: { name: 'example-skill', description: 'Example', ...generatedSkillMetadata(), instructions: completeSkillInstructions('Read the relevant note.') }, provenance: { sessionId: pin.sessionId, workspaceId: pin.workspaceId, promptSha256: 'a'.repeat(64), runId: 'run-two' } })).rejects.toMatchObject({ code: 'missing_capability' });
    expect(connect).toHaveBeenCalledTimes(2); expect(replacement.request).not.toHaveBeenCalled();
  });

  it('pins evidence intake and transfers its connection binding to the admitted job', async () => {
    const original = client(action => action === 'evidence.begin' ? { intakeId: 'intake-one' } : action === 'evidence.append' ? { complete: false } : { job: { jobId: 'job-one' } });
    const replacement = client(() => ({ claimed: true }));
    const connect = vi.fn(async () => original as unknown as DaemonClient), backend = new RustLearningBackend(connect);
    await backend.process('evidence.begin', {});
    await backend.process('evidence.append', { intakeId: 'intake-one', toolCallId: 'read-one', name: 'read_file', isError: false, chunk: 'Evidence', final: true });
    await backend.process('job.begin', { intakeId: 'intake-one', profileId: 'default', revision: 'revision-one', sessionId: 'session_one', workspaceId: 'workspace_one', runId: 'run-one', promptSha256: 'a'.repeat(64), policy: { enabled: true, skills: true, notes: false }, tools: [] });
    original.usable = false;
    connect.mockResolvedValue(replacement as unknown as DaemonClient);
    await expect(backend.process('receipt.claim', { profileId: 'default', contentSha256: 'b'.repeat(64), runId: 'run-one' })).rejects.toMatchObject({ code: 'missing_capability' });
    await expect(backend.process('evidence.release', { intakeId: 'intake-one' })).rejects.toMatchObject({ code: 'missing_capability' });
    expect(connect).toHaveBeenCalledOnce(); expect(replacement.request).not.toHaveBeenCalled();
  });

  it('captures on its intake owner, then binds queued admission to the fresh daemon', async () => {
    const jobId = 'c'.repeat(64);
    const original = client(action => action === 'evidence.begin' ? { intakeId: 'intake-one' } : { record: { jobId }, created: true });
    const replacement = client(action => action === 'queue.admit' || action === 'job.enter' ? { job: { jobId } } : { claimed: true });
    const connect = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement), backend = new RustLearningBackend(connect);
    const binding = { profileId: 'default', workspaceId: 'workspace', sessionId: 'session', runId: 'run', promptSha256: 'a'.repeat(64),
      destinationRevision: 'vault-r1', routeFingerprint: 'b'.repeat(64), policy: { enabled: true, skills: true, notes: true } };
    await backend.process('evidence.begin', {});
    await backend.process('queue.capture', { ...binding, revision: binding.destinationRevision, intakeId: 'intake-one' });
    expect(connect).toHaveBeenCalledOnce();
    original.usable = false;
    await expect(backend.process('evidence.release', { intakeId: 'intake-one' })).rejects.toMatchObject({ code: 'missing_capability' });
    await backend.process('queue.admit', { ...binding, jobId, queueRevision: 'd'.repeat(64), tools: [] });
    await backend.process('job.enter', { jobId, effectId: `${jobId}-1` });
    await backend.process('receipt.claim', { profileId: binding.profileId, runId: binding.runId, contentSha256: 'e'.repeat(64) });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(replacement.request.mock.calls.map(call => call[1].action)).toEqual(['queue.admit', 'job.enter', 'receipt.claim']);
  });

  it('requires explicit recovery to bind a saved job and its receipts to a replacement daemon', async () => {
    const jobId = 'c'.repeat(64);
    const original = client(() => ({ job: { jobId } }));
    const replacement = client(action => action === 'job.recover' || action === 'job.enter' ? { job: { jobId } } : { claimed: true });
    const connect = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement);
    const backend = new RustLearningBackend(connect);
    const binding = { profileId: 'default', workspaceId: 'workspace', sessionId: 'session', runId: 'run', promptSha256: 'a'.repeat(64),
      destinationRevision: 'vault-r1', routeFingerprint: 'b'.repeat(64), policy: { enabled: true, skills: true, notes: true }, tools: [] };
    await backend.process('job.begin', { ...binding, revision: binding.destinationRevision, evidence: [] });
    original.usable = false;
    await expect(backend.process('job.enter', { jobId, effectId: `${jobId}-1` })).rejects.toMatchObject({ code: 'missing_capability' });
    expect(connect).toHaveBeenCalledOnce();
    await backend.process('job.recover', { ...binding, jobId });
    await backend.process('job.enter', { jobId, effectId: `${jobId}-1` });
    await backend.process('receipt.claim', { profileId: binding.profileId, runId: binding.runId, contentSha256: 'd'.repeat(64) });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(replacement.request.mock.calls.map(call => call[1].action)).toEqual(['job.recover', 'job.enter', 'receipt.claim']);
  });
});
