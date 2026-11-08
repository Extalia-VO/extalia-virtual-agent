import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { awaitObservedReply } from '../src/observedReplyClient.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

describe('observed cooperative reply host integration', () => {
  it('manually pairs a tool without inventing an observed or managed session', async () => {
    const root = await temp('extalia-manual-reply-');
    const homeDirectory = path.join(root, 'home'), dataDirectory = path.join(root, 'data');
    await mkdir(homeDirectory);
    const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory, homeDirectory, importHome: homeDirectory,
      env: { HOME: homeDirectory, EXTALIA_HOME: dataDirectory, EXTALIA_SECRET_STORE: 'memory' } });
    try {
      const [channel, parallel] = await Promise.all([runtime.host.createManualReply!(), runtime.host.createManualReply!()]);
      expect(channel.state).toBe('waitingForAgent'); expect(parallel.state).toBe('waitingForAgent');
      expect(channel.channelId).not.toBe(parallel.channelId);
      await runtime.host.closeObservedReply!(parallel.sessionId);
      const call = awaitObservedReply({ url: channel.url!, token: channel.token!, question: 'Same Chat tool?' });
      await vi.waitFor(async () => expect(await runtime.host.observedReplyStatus!(channel.sessionId)).toMatchObject({ state: 'waitingForReply' }));
      await runtime.host.answerObservedReply!(channel.sessionId, { channelId: channel.channelId!, text: 'Continue this conversation' });
      expect(await call).toEqual({ status: 'answered', text: 'Continue this conversation' });
      await runtime.host.closeObservedReply!(channel.sessionId);
      expect(await runtime.host.createObservedReply!(channel.sessionId)).toMatchObject({ state: 'waitingForAgent' });
      expect((await runtime.host.getState()).sessions).toHaveLength(0);
    } finally { await runtime.close(); }
  });
  it('returns a real client reply for the watched source and revokes a waiting call on pause without a managed engine', async () => {
    const root = await temp('extalia-reply-integration-');
    const homeDirectory = path.join(root, 'home');
    const dataDirectory = path.join(root, 'data');
    await mkdir(homeDirectory);
    const runtime = await createAgentHost({
      kind: 'bridge', version: '0.0.0-test', dataDirectory, homeDirectory, importHome: homeDirectory,
      env: { HOME: homeDirectory, EXTALIA_HOME: dataDirectory, EXTALIA_SECRET_STORE: 'memory' },
    });
    try {
      const ingest = await runtime.host.hookIngest();
      const token = (await readFile(ingest.tokenPath, 'utf8')).trim();
      const listener = await runtime.hooks!.listen();
      const response = await fetch(`http://127.0.0.1:${listener.port}/api/hooks/claude`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'original-native-session', hook_event_name: 'UserPromptSubmit', prompt: 'Original prompt', cwd: homeDirectory }),
      });
      expect(response.status).toBe(204);
      let sessionId = '';
      await vi.waitFor(async () => {
        const state = await runtime.host.getState();
        const session = state.sessions.find(item => item.observation?.nativeSessionId === 'original-native-session');
        expect(session?.control).toBe('observed');
        sessionId = session!.id;
      });

      const channel = await runtime.host.createObservedReply!(sessionId);
      const originalCall = awaitObservedReply({ url: channel.url!, token: channel.token!, question: 'Which color?' });
      await vi.waitFor(async () => expect(await runtime.host.observedReplyStatus!(sessionId)).toMatchObject({ state: 'waitingForReply', question: 'Which color?' }));
      expect(await runtime.host.answerObservedReply!(sessionId, { channelId: channel.channelId!, text: 'Green' })).toMatchObject({ state: 'answered' });
      expect(await originalCall).toEqual({ status: 'answered', text: 'Green' });
      expect(await awaitObservedReply({ url: channel.url!, token: channel.token! })).toEqual({ status: 'unavailable' });

      const second = await runtime.host.createObservedReply!(sessionId);
      const pending = awaitObservedReply({ url: second.url!, token: second.token!, question: 'Continue?' });
      await vi.waitFor(async () => expect(await runtime.host.observedReplyStatus!(sessionId)).toMatchObject({ state: 'waitingForReply' }));
      const pausing = runtime.host.setObservation(sessionId, false);
      // Admission is revoked before the serialized observation preference settles.
      expect(await runtime.host.createObservedReply!(sessionId)).toMatchObject({ state: 'unavailable' });
      await pausing;
      expect(await pending).toEqual({ status: 'unavailable' });
      expect(await runtime.host.createObservedReply!(sessionId)).toMatchObject({ state: 'unavailable' });
      const state = await runtime.host.getState();
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0]).toMatchObject({ control: 'observed', observation: { nativeSessionId: 'original-native-session', watching: false } });
      await runtime.host.setObservation(sessionId, true);
      expect(await runtime.host.createObservedReply!(sessionId)).toMatchObject({ state: 'waitingForAgent' });
    } finally {
      await runtime.close();
    }
  });
});
