import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { ComposerDraftStore, composerDraftKey, composerDraftStore } from '../src/chat/composerDrafts';

const observed = (patch: Partial<SessionSummary> = {}): SessionSummary => ({ id: 'observed-one', control: 'observed', workspaceId: 'workspace-one',
  observation: { sourceId: 'codex', nativeSessionId: '11111111-1111-4111-8111-111111111111', watching: true, status: 'watching' }, ...patch } as SessionSummary);

describe('retained prompt text', () => {
  it('restores exact per-session text after close, hooks, metadata hydration and other-view navigation', () => {
    const store = new ComposerDraftStore(), session = observed(), key = composerDraftKey(session);
    const entry = store.entry(key); entry.setText('Unsent exact prompt\n  preserve spacing');
    const next = { ...session, running: true, workspaceId: 'workspace-hydrated', observation: { ...session.observation!, projectPath: '/workspace/project', status: 'watching' as const } };
    expect(composerDraftKey(next)).toBe(key);
    store.entry(composerDraftKey({ ...session, id: 'another-session' })).setText('A different draft');
    expect(store.entry(composerDraftKey(next)).getSnapshot().text).toBe('Unsent exact prompt\n  preserve spacing');
  });
  it('separates actual hosts, source rebindings, native sessions and new-workspace inputs', () => {
    const api = {} as AgentHostApi, other = {} as AgentHostApi, session = observed();
    composerDraftStore(api).entry(composerDraftKey(session)).setText('Original host draft');
    expect(composerDraftStore(other).entry(composerDraftKey(session)).getSnapshot().text).toBe('');
    expect(composerDraftKey({ ...session, observation: { ...session.observation!, nativeSessionId: '22222222-2222-4222-8222-222222222222' } })).not.toBe(composerDraftKey(session));
    expect(composerDraftKey({ ...session, observation: { ...session.observation!, sourceId: 'claude-code' } })).not.toBe(composerDraftKey(session));
    expect(composerDraftKey(undefined, 'one')).not.toBe(composerDraftKey(undefined, 'two'));
  });
  it('settles the captured draft after unmount without clearing newer typing or a different session', () => {
    const store = new ComposerDraftStore(), one = store.entry('one'), two = store.entry('two');
    one.setText('First'); const lease = one.beginSend()!;
    expect(store.entry('one').getSnapshot().sending).toBe(true);
    expect(store.entry('one').beginSend()).toBeUndefined();
    two.setText('Second session'); one.setText('New typing'); lease.finish('accepted');
    expect(one.getSnapshot()).toEqual({ text: 'New typing', sending: false, delivery: 'accepted' });
    expect(two.getSnapshot().text).toBe('Second session');
  });
  it('uses revisions rather than text equality, preserves failed/unknown text and prevents ambiguous retries', () => {
    const entry = new ComposerDraftStore().entry('one'); entry.setText('A');
    const lease = entry.beginSend()!; entry.setText('B'); entry.setText('A'); lease.finish('accepted');
    expect(entry.getSnapshot().text).toBe('A');
    entry.beginSend()!.finish('failed'); expect(entry.getSnapshot().text).toBe('A');
    entry.beginSend()!.finish('unknown'); expect(entry.beginSend()).toBeUndefined();
    entry.setText('Edited while uncertain'); expect(entry.beginSend()).toBeUndefined();
    entry.allowRetry(); const retry = entry.beginSend()!; retry.finish('accepted');
    expect(entry.getSnapshot()).toEqual({ text: '', sending: false, delivery: 'accepted' });
    retry.finish('failed'); expect(entry.getSnapshot().delivery).toBe('accepted');
  });
  it('protects retained drafts from restart while their composer is closed', () => {
    const store = new ComposerDraftStore();
    const entry = store.entry('one'); entry.setText('Pending'); expect(store.hasDrafts()).toBe(true);
    const lease = entry.beginSend()!; lease.finish('accepted'); expect(store.hasDrafts()).toBe(false);
  });
  it('moves text and its pending lease into its own created session, retaining failures for retry there', () => {
    const store = new ComposerDraftStore(), from = composerDraftKey(undefined, 'workspace');
    const entry = store.entry(from); entry.setText('First prompt'); const lease = entry.beginSend()!;
    expect(store.bindSession('workspace', 'created')).toBe(true);
    const target = store.entry(composerDraftKey({ id: 'created', control: 'managed' } as SessionSummary));
    expect(target.getSnapshot()).toMatchObject({ text: 'First prompt', sending: true });
    expect(store.entry(from).getSnapshot().text).toBe('');
    lease.finish('failed'); expect(target.getSnapshot()).toMatchObject({ text: 'First prompt', sending: false });
    target.beginSend()!.finish('accepted'); expect(target.getSnapshot().text).toBe('');
  });
});
