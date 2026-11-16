import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, PromptSuggestionsStatus, SessionSummary } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { MessagesContext } from '../src/ui/messages';
import { PromptSuggestionsContent } from '../src/chat/PromptSuggestions';
import { composerDraftKey, composerDraftStore } from '../src/chat/composerDrafts';
import { createPromptSuggestionsControl, fillPromptSuggestion, promptSuggestionsKey } from '../src/chat/promptSuggestionsModel';

const session = { id: 'session', control: 'managed', workspaceId: 'workspace', connectionId: 'connection', running: false } as SessionSummary;
const status = (patch: Partial<PromptSuggestionsStatus> = {}): PromptSuggestionsStatus => ({ sessionId: session.id,
  anchor: 'completed-turn', state: 'ready', prompts: ['Inspect the diff', 'Explain the tradeoffs'], origin: 'native', canRequest: false, ...patch });
const stops: Array<() => void> = [];
const settle = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup(initial = status()) {
  const api = { promptSuggestions: vi.fn(async () => initial), requestPromptSuggestions: vi.fn(async (_id: string, anchor: string) => status({ anchor, origin: 'harness' })) };
  const agents = api as unknown as AgentHostApi;
  const control = createPromptSuggestionsControl(agents, session.id, promptSuggestionsKey(session));
  control.setEnabled(true); stops.push(control.start());
  return { api, agents, control };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('does not request generation without an advertised capability', async () => {
  const { api, control } = setup(status({ state: 'unavailable', prompts: [], canRequest: false })); await settle();
  expect(control.getSnapshot().status?.prompts).toEqual([]);
  expect(api.requestPromptSuggestions).not.toHaveBeenCalled();
});

it('requests one native generation when its exact completed anchor advertises canRequest', async () => {
  const { api, control } = setup(status({ origin: 'native', canRequest: true, state: 'unavailable', prompts: [] }));
  api.requestPromptSuggestions.mockResolvedValueOnce(status({ origin: 'native' })); await settle();
  expect(control.getSnapshot().status).toMatchObject({ origin: 'native', prompts: ['Inspect the diff', 'Explain the tradeoffs'] });
  await control.refresh(); await control.refresh();
  expect(api.requestPromptSuggestions).toHaveBeenCalledExactlyOnceWith(session.id, 'completed-turn');
});

it('requests one supported harness snapshot per completed anchor, including across remounts', async () => {
  const { api, agents, control } = setup(status({ origin: 'harness', canRequest: true, prompts: [], state: 'unavailable' }));
  await settle(); await control.refresh();
  const remounted = createPromptSuggestionsControl(agents, session.id, promptSuggestionsKey(session));
  remounted.setEnabled(true); stops.push(remounted.start()); await settle();
  expect(api.requestPromptSuggestions).toHaveBeenCalledExactlyOnceWith(session.id, 'completed-turn');
  api.promptSuggestions.mockResolvedValue(status({ origin: 'harness', canRequest: true, anchor: 'next-turn', prompts: [], state: 'unavailable' }));
  await control.refresh(); expect(api.requestPromptSuggestions).toHaveBeenCalledTimes(2);
  expect(api.requestPromptSuggestions).toHaveBeenLastCalledWith(session.id, 'next-turn');
});

it('does not infer capability or request for pending, private, unsupported or missing anchors', async () => {
  const { api, control } = setup(status({ origin: 'harness', prompts: [], canRequest: false })); await settle();
  for (const patch of [{ canRequest: true, anchor: undefined }, { canRequest: true, state: 'pending' as const },
    { canRequest: true, state: 'private' as const }, { canRequest: true, state: 'unsupported' as const }]) {
    api.promptSuggestions.mockResolvedValue(status({ origin: 'harness', prompts: [], ...patch })); await control.refresh();
  }
  expect(api.requestPromptSuggestions).not.toHaveBeenCalled();
});

it('never retries a failed generation request for the same anchor', async () => {
  const { api, control } = setup(status({ origin: 'harness', canRequest: true, state: 'unavailable', prompts: [] }));
  api.requestPromptSuggestions.mockRejectedValueOnce(new Error('private diagnostic')); await settle();
  await control.refresh(); await control.refresh();
  expect(api.requestPromptSuggestions).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(control.getSnapshot())).not.toContain('private diagnostic');
});

it('clears old results immediately while working and ignores late read and request receipts', async () => {
  const { api, control } = setup(); await settle();
  const reading = deferred<PromptSuggestionsStatus>(); api.promptSuggestions.mockReturnValueOnce(reading.promise);
  const pending = control.refresh(); control.setEnabled(false);
  expect(control.getSnapshot().status).toBeUndefined();
  reading.resolve(status()); await pending; expect(control.getSnapshot().status).toBeUndefined();
  const requesting = deferred<PromptSuggestionsStatus>(); api.requestPromptSuggestions.mockReturnValueOnce(requesting.promise);
  api.promptSuggestions.mockResolvedValue(status({ origin: 'harness', canRequest: true, prompts: [], state: 'unavailable' }));
  control.setEnabled(true); await settle(); control.setEnabled(false);
  requesting.resolve(status({ origin: 'harness' })); await settle(); expect(control.getSnapshot().status).toBeUndefined();
});

it('a working-to-idle wakeup waits for an old read, then reads the new anchor', async () => {
  const { api, control } = setup(); await settle();
  const reading = deferred<PromptSuggestionsStatus>(); api.promptSuggestions.mockReturnValueOnce(reading.promise);
  const pending = control.refresh(); control.setEnabled(false); control.setEnabled(true);
  api.promptSuggestions.mockResolvedValue(status({ anchor: 'new-turn', prompts: ['New suggestion'] }));
  reading.resolve(status()); await pending; await settle();
  expect(control.getSnapshot().status).toMatchObject({ anchor: 'new-turn', prompts: ['New suggestion'] });
});

it('rejects foreign sessions, stale request anchors and malformed untrusted prompt lists', async () => {
  const { api, control } = setup(); await settle();
  for (const patch of [{ sessionId: 'another-session' }, { prompts: ['same', ' same '] }, { prompts: ['Line\nBreak'] },
    { prompts: ['x'.repeat(241)] }, { prompts: ['a', 'b', 'c', 'd'] }, { prompts: ['hidden\u0000text'] }]) {
    api.promptSuggestions.mockResolvedValue(status(patch)); await control.refresh(); expect(control.getSnapshot().status).toBeUndefined();
  }
  api.promptSuggestions.mockResolvedValue(status({ origin: 'harness', canRequest: true, state: 'unavailable', prompts: [] }));
  api.requestPromptSuggestions.mockResolvedValueOnce(status({ origin: 'harness', anchor: 'older-turn' }));
  await control.refresh(); expect(control.getSnapshot().status).toBeUndefined();
});

it('clears private results and uses bounded one-second pending / two-second idle polling', async () => {
  vi.useFakeTimers(); const { api, control } = setup(status({ state: 'pending', prompts: [] })); await settle();
  await vi.advanceTimersByTimeAsync(1000); expect(api.promptSuggestions).toHaveBeenCalledTimes(2);
  api.promptSuggestions.mockResolvedValue(status({ state: 'private' })); await vi.advanceTimersByTimeAsync(1000);
  expect(control.getSnapshot().status?.prompts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000); expect(api.promptSuggestions).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(200000); expect(api.promptSuggestions).toHaveBeenCalledTimes(60);
});

it('keeps API/source/native identity and model changes out of the previous view', async () => {
  const { api, agents, control } = setup(); await settle();
  for (const next of [{ ...session, connectionId: 'other-connection' }, { ...session, options: { model: 'other-model' } },
    { ...session, control: 'observed' as const, observation: { sourceId: 'codex', nativeSessionId: 'other-native', watching: true, status: 'watching' as const } }]) {
    expect(promptSuggestionsKey(next)).not.toBe(promptSuggestionsKey(session));
    expect(createPromptSuggestionsControl(agents, next.id, promptSuggestionsKey(next)).getSnapshot().status).toBeUndefined();
  }
  expect(createPromptSuggestionsControl({ ...api } as unknown as AgentHostApi, session.id, promptSuggestionsKey(session)).getSnapshot().status).toBeUndefined();
  expect(control.getSnapshot().status?.prompts.length).toBe(2);
});

it('fills an empty shared draft only and preserves whitespace, newer typing and uncertain delivery', () => {
  const agents = {} as AgentHostApi, entry = composerDraftStore(agents).entry(composerDraftKey(session));
  expect(fillPromptSuggestion(agents, session, 'Review the changes')).toBe(true);
  expect(entry.getSnapshot()).toMatchObject({ text: 'Review the changes', sending: false });
  entry.setText('   '); expect(fillPromptSuggestion(agents, session, 'Overwrite')).toBe(false); expect(entry.getSnapshot().text).toBe('   ');
  entry.setText('newer typing'); expect(fillPromptSuggestion(agents, session, 'Overwrite')).toBe(false);
  entry.setText(''); const lease = entry.beginSend()!; expect(fillPromptSuggestion(agents, session, 'While sending')).toBe(false);
  lease.finish('unknown'); expect(fillPromptSuggestion(agents, session, 'Retry')).toBe(false);
});

it('renders translated attribution and escaped plain text, with no sending actions or empty-state noise', () => {
  for (const language of ['en', 'id'] as const) {
    const t = MESSAGES[language];
    const markup = renderToStaticMarkup(createElement(PromptSuggestionsContent, { t, status: status({ origin: 'harness', prompts: ['<script>unsafe</script>'] }), locked: true, onChoose: vi.fn() }));
    expect(markup).toContain(t.promptSuggestions.harness); expect(markup).toContain(t.promptSuggestions.keepDraft);
    expect(markup).toContain('disabled=""'); expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('type="submit"');
    expect(renderToStaticMarkup(createElement(PromptSuggestionsContent, { t, status: status({ state: 'private' }), locked: false, onChoose: vi.fn() }))).toBe('');
    expect(renderToStaticMarkup(createElement(PromptSuggestionsContent, { t, status: status({ state: 'pending', prompts: [] }), locked: false, onChoose: vi.fn() }))).toContain(t.promptSuggestions.pending);
  }
});

it('shows copy-only plain-text suggestions using the shared translated copy control, regardless of draft lock', () => {
  for (const language of ['en', 'id'] as const) {
    const t = MESSAGES[language], onChoose = vi.fn();
    const markup = renderToStaticMarkup(createElement(MessagesContext, { value: t }, createElement(PromptSuggestionsContent, {
      t, status: status({ origin: 'harness', prompts: ['<script>example</script>'] }), locked: true, copyOnly: true, onChoose,
    })));
    expect(markup).toContain(t.promptSuggestions.copyHint); expect(markup).toContain(t.common.copy);
    expect(markup).toContain('copy-button'); expect(markup).toContain('&lt;script&gt;example&lt;/script&gt;');
    expect(markup).not.toContain('<script>'); expect(markup).not.toContain('type="submit"'); expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain(t.promptSuggestions.keepDraft); expect(onChoose).not.toHaveBeenCalled();
  }
});
