import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedControlDispatchInput, ObservedControlReceipt, ObservedControlStatus, ObservedInboxStatus, SessionSummary } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ManualObservedInboxControls, ObservedInboxContent, ObservedSessionControl, ObservedSessionControlContent, ObservedSessionToolsContent } from '../src/observe/ObservedSessionControl';
import { createObservedInboxControl, createObservedSessionControl, observedSessionControlFor, validObservedControlStatus, validObservedInboxStatus } from '../src/observe/observedSessionControlModel';

const id = 'observed-session';
const status = (capabilityId = 'capability-one', bindingId = 'source-one'): ObservedControlStatus => ({ sessionId: id, state: 'ready', bindingId, routes: [{
  route: 'cooperative-inbox', state: 'ready', evidence: 'paired-inbox', limit: 'paired-consumer-only', relatedControls: [],
  capabilities: [{ action: 'inbox-send', available: true, capabilityId }],
}] });
const host = () => ({
  observedControlStatus: vi.fn(async () => status()),
  dispatchObservedControl: vi.fn(async (_id: string, input: ObservedControlDispatchInput): Promise<ObservedControlReceipt> => ({ sessionId: id, operationId: input.operationId, state: 'queued', retryable: false })),
});
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup() {
  const api = host(), model = createObservedSessionControl(api as unknown as AgentHostApi, id);
  stops.push(model.start()); return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('requires explicit action selection and never sends on mount or poll', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle();
  model.setDraft('Keep this draft'); expect(model.canSend()).toBe(false);
  await model.send(); await vi.advanceTimersByTimeAsync(6000);
  expect(model.getSnapshot()).toMatchObject({ draft: 'Keep this draft', selected: '' });
  expect(api.dispatchObservedControl).not.toHaveBeenCalled();
  model.select('capability-one'); expect(model.canSend()).toBe(true);
});
it('refreshes exact source authority before dispatch and never chooses a fallback action', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('Keep'); model.select('capability-one');
  api.observedControlStatus.mockResolvedValue(status('capability-two'));
  await model.send();
  expect(model.getSnapshot()).toMatchObject({ draft: 'Keep', selected: '', notice: 'stale' });
  expect(api.dispatchObservedControl).not.toHaveBeenCalled();
  model.select('capability-two'); api.observedControlStatus.mockResolvedValue(status('capability-two', 'foreign-source'));
  await model.send(); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});
it('ignores a late source read and a preflight after disposal', async () => {
  const { api, model } = setup(); await settle();
  let resolve!: (value: ObservedControlStatus) => void;
  api.observedControlStatus.mockReturnValue(new Promise(done => { resolve = done; }));
  const read = model.refresh(); stops.pop()!(); resolve(status('foreign')); await read;
  expect(model.getSnapshot().status).toEqual(status());
  stops.push(model.start()); resolve(status()); await settle(); model.select('capability-one'); model.setDraft('Keep');
  const send = model.send(); stops.pop()!(); resolve(status()); await send;
  expect(api.dispatchObservedControl).not.toHaveBeenCalled(); expect(model.getSnapshot().draft).toBe('Keep');
});
it('uses one operation ID per explicit send, rejects duplicates while pending, and preserves a newer draft', async () => {
  const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('First');
  let resolve!: (value: ObservedControlReceipt) => void;
  api.dispatchObservedControl.mockReturnValue(new Promise(done => { resolve = done; }));
  const send = model.send(); await settle(); await model.send();
  const input = api.dispatchObservedControl.mock.calls[0]![1];
  expect(input).toMatchObject({ capabilityId: 'capability-one', text: 'First' }); expect(input.operationId).toMatch(/^[a-f0-9-]{36}$/);
  model.setDraft('Next draft'); resolve({ sessionId: id, operationId: input.operationId, state: 'queued', retryable: false }); await send;
  expect(api.dispatchObservedControl).toHaveBeenCalledTimes(1); expect(model.getSnapshot().draft).toBe('Next draft');
});
it.each(['unknown', 'transport-error'] as const)('retains and seals an uncertain action after %s without automatic retry', async outcome => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('Keep');
  if (outcome === 'transport-error') api.dispatchObservedControl.mockRejectedValue(new Error('connection closed'));
  else api.dispatchObservedControl.mockImplementation(async (_id, input) => ({ sessionId: id, operationId: input.operationId, state: 'unknown', retryable: false }));
  await model.send(); await vi.advanceTimersByTimeAsync(6000); await model.send();
  expect(api.dispatchObservedControl).toHaveBeenCalledTimes(1); expect(model.getSnapshot()).toMatchObject({ draft: 'Keep', receipt: { state: 'unknown' } });
  expect(model.canSend()).toBe(false);
});
it('retains a draft after rejection and clears it only after a positive receipt', async () => {
  const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('Keep');
  api.dispatchObservedControl.mockImplementation(async (_id, input) => ({ sessionId: id, operationId: input.operationId, state: 'rejected', retryable: false }));
  await model.send(); expect(model.getSnapshot().draft).toBe('Keep');
  api.dispatchObservedControl.mockImplementation(async (_id, input) => ({ sessionId: id, operationId: input.operationId, state: 'submitted', retryable: false }));
  await model.send(); expect(model.getSnapshot().draft).toBe('');
});
it.each(['queued', 'submitted', 'resolved'] as const)('does not flag the consumed capability as stale after a %s receipt', async state => {
  const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('Send once');
  api.dispatchObservedControl.mockImplementation(async (_id, input) => {
    api.observedControlStatus.mockResolvedValue(status('capability-two'));
    return { sessionId: id, operationId: input.operationId, state, retryable: false };
  });
  await model.send();
  expect(model.getSnapshot()).toMatchObject({ draft: '', selected: '', receipt: { state }, status: status('capability-two') });
  expect(model.getSnapshot().notice).toBeUndefined();
  await model.refresh(); expect(model.getSnapshot().notice).toBeUndefined();
  expect(api.dispatchObservedControl).toHaveBeenCalledTimes(1);
});
it('still marks a foreign capability change as stale while preserving an unsent draft', async () => {
  const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('Unsent draft');
  api.observedControlStatus.mockResolvedValue(status('foreign-capability', 'foreign-source')); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ draft: 'Unsent draft', selected: '', notice: 'stale' });
  expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});
it('retains separate drafts across session navigation and enforces the UTF-8 byte limit', async () => {
  const api = host() as unknown as AgentHostApi;
  const first = observedSessionControlFor(api, id), second = observedSessionControlFor(api, 'another');
  first.setDraft('First source'); second.setDraft('Second source'); expect(observedSessionControlFor(api, id).getSnapshot().draft).toBe('First source');
  stops.push(first.start()); await settle(); first.select('capability-one'); first.setDraft('界'.repeat(6000)); expect(first.canSend()).toBe(false);
});
it('handles missing or null hosts and fails closed on a foreign session status', async () => {
  for (const api of [{}, null]) {
    const model = createObservedSessionControl(api as AgentHostApi, id); stops.push(model.start());
    expect(model.getSnapshot().phase).toBe('unsupported'); await model.send();
  }
  expect(validObservedControlStatus({ ...status(), sessionId: 'foreign' }, id)).toBe(false);
  const { api, model } = setup(); await settle(); model.select('capability-one'); model.setDraft('Keep');
  api.observedControlStatus.mockResolvedValue({ ...status(), sessionId: 'foreign' }); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ phase: 'error', draft: 'Keep', selected: '' }); expect(model.canSend()).toBe(false);
});

const channelId = '11111111-1111-4111-8111-111111111111';
const inbox: ObservedInboxStatus = { sessionId: id, state: 'connected', channelId, url: `http://127.0.0.1:12345/inbox/${channelId}`, token: 'a'.repeat(64), queued: 1, polling: false,
  receipts: [{ messageId: 'message-one', state: 'delivered', createdAt: 1 }] };
it('keeps inbox creation explicit and closes before accepting a late poll', async () => {
  const api = { observedInboxStatus: vi.fn(async (): Promise<ObservedInboxStatus> => ({ sessionId: id, state: 'disconnected' })),
    createObservedInbox: vi.fn(async () => inbox), closeObservedInbox: vi.fn(async (): Promise<ObservedInboxStatus> => ({ sessionId: id, state: 'disconnected' })) };
  const model = createObservedInboxControl(api as unknown as AgentHostApi, id); stops.push(model.start()); await settle();
  expect(api.createObservedInbox).not.toHaveBeenCalled(); await model.create(); expect(model.getSnapshot().revealed).toBe(false); model.reveal(true);
  let resolve!: (value: ObservedInboxStatus) => void;
  api.observedInboxStatus.mockReturnValue(new Promise(done => { resolve = done; }));
  const read = model.refresh(); await model.close(); resolve(inbox); await read;
  expect(model.getSnapshot()).toMatchObject({ revealed: false, status: { state: 'disconnected' } });
});
it('rejects unsafe inbox pairing targets', () => {
  expect(validObservedInboxStatus(inbox, id)).toBe(true);
  for (const url of ['https://example.com/inbox/one', `http://127.0.0.1:12345/inbox/${channelId}?x=y`, `http://localhost:12345/inbox/${channelId}`]) {
    expect(validObservedInboxStatus({ ...inbox, url }, id)).toBe(false);
  }
});
it('conceals pairing secrets when the inbox generation changes and resumes polling after effect remount', async () => {
  const api = { observedInboxStatus: vi.fn(async () => inbox), createObservedInbox: vi.fn(async () => inbox), closeObservedInbox: vi.fn(async () => inbox) };
  const model = createObservedInboxControl(api as unknown as AgentHostApi, id);
  const stop = model.start(); stop(); stops.push(model.start()); await settle();
  expect(model.getSnapshot().status).toEqual(inbox);
  model.reveal(true); expect(model.getSnapshot().revealed).toBe(true);
  const nextId = '22222222-2222-4222-8222-222222222222';
  api.observedInboxStatus.mockResolvedValue({ ...inbox, channelId: nextId, url: `http://127.0.0.1:12345/inbox/${nextId}` });
  await model.refresh(); expect(model.getSnapshot().revealed).toBe(false);
});
it.each(['en', 'id'] as const)('renders host capabilities and explicit secret disclosure in %s', language => {
  const t = MESSAGES[language], model = createObservedSessionControl({} as AgentHostApi, id);
  const html = renderToStaticMarkup(createElement(ObservedSessionControlContent, { t, control: model,
    view: { phase: 'ready', draft: 'Original user draft', selected: '', busy: false, status: status(), receipt: { sessionId: id, operationId: 'operation', state: 'unknown', retryable: false } } }));
  expect(html).not.toContain(t.observedControl.helper); expect(html).not.toContain('role="combobox"'); expect(html).toContain(t.observedControl.receipts.unknown);
  const tools = renderToStaticMarkup(createElement(ObservedSessionToolsContent, { t, control: model, view: { phase: 'ready', draft: '', selected: '', busy: false, status: status() } }));
  expect(tools).toContain(t.observedControl.helper); expect(tools).toContain(t.observedControl.evidence['paired-inbox']); expect(tools).not.toContain('<textarea');
  expect(html).toContain('Original user draft'); expect(html.match(/<textarea/g)).toHaveLength(1); expect(html).toContain('disabled=""');
  const control = createObservedInboxControl({} as AgentHostApi, id);
  const hidden = renderToStaticMarkup(createElement(ObservedInboxContent, { t, control, view: { phase: 'ready', busy: false, revealed: false, status: inbox } }));
  expect(hidden).not.toContain(inbox.token); expect(hidden).not.toContain(inbox.url); expect(hidden).toContain(t.observedControl.inboxReceipts.delivered);
  const visible = renderToStaticMarkup(createElement(ObservedInboxContent, { t, control, view: { phase: 'ready', busy: false, revealed: true, status: inbox } }));
  expect(visible).toContain(inbox.token); expect(visible).toContain('extalia inbox'); expect(visible).toContain('poll_inbox');
});
it('renders a manual pairing registry without creating a session or a character', () => {
  const createManualObservedInbox = vi.fn();
  const html = renderToStaticMarkup(createElement(ManualObservedInboxControls, { t: MESSAGES.en, agents: { createManualObservedInbox } as unknown as AgentHostApi }));
  expect(html).toContain(MESSAGES.en.observedControl.manualHint); expect(html).toContain(MESSAGES.en.observedControl.label);
  expect(createManualObservedInbox).not.toHaveBeenCalled();
});
it('keeps only the ordinary input and icon send button in the compact composer', () => {
  const t = MESSAGES.en, model = createObservedSessionControl({} as AgentHostApi, id);
  const content = renderToStaticMarkup(createElement(ObservedSessionControlContent, { t, control: model,
    view: { phase: 'ready', draft: 'Keep visible', selected: '', busy: false, status: status() } }));
  expect(content).toContain('Keep visible'); expect(content.match(/<textarea/g)).toHaveLength(1);
  expect(content).toContain('class="send-button"');
  for (const text of [t.observedControl.helper, t.observedControl.action, t.observedControl.messageLimit, t.observedControl.capabilityDetails, t.observedControl.pairingDetails]) expect(content).not.toContain(text);
  const complete = renderToStaticMarkup(createElement(ObservedSessionControl, { t, agents: {} as AgentHostApi,
    session: { id, control: 'observed' } as SessionSummary, compact: true }));
  expect(complete).not.toContain('<details'); expect(complete).not.toContain('role="combobox"');
  expect(complete.match(/<textarea/g)).toHaveLength(1);
});
it('puts settings behind a Conversation tools tab by default', () => {
  const html = renderToStaticMarkup(createElement(ObservedSessionControl, { t: MESSAGES.en, agents: {} as AgentHostApi,
    session: { id, control: 'observed' } as SessionSummary }));
  expect(html.match(/role="tab"/g)).toHaveLength(2);
  expect(html).toContain(MESSAGES.en.characterConsole.tools);
  expect(html).not.toContain(MESSAGES.en.observedControl.helper);
  expect(html).not.toContain(MESSAGES.en.observedControl.pairingDetails);
  expect(html.match(/<textarea/g)).toHaveLength(1);
});
it('uses app button styles and folds unavailable connection options without hiding active capabilities', () => {
  const t = MESSAGES.en, model = createObservedSessionControl({} as AgentHostApi, id), current = status();
  current.routes.push({ route: 'codex-native', state: 'unavailable', evidence: 'native-attachment', limit: 'existing-native-owner', capabilities: [], relatedControls: [] });
  const html = renderToStaticMarkup(createElement(ObservedSessionToolsContent, { t, control: model,
    view: { phase: 'ready', draft: '', selected: '', busy: false, status: current } }));
  const split = html.indexOf(`<summary>${t.observedControl.otherConnections}</summary>`);
  expect(split).toBeGreaterThan(0); expect(html.indexOf(t.observedControl.routes['cooperative-inbox'])).toBeLessThan(split);
  expect(html.indexOf(t.observedControl.routes['codex-native'])).toBeGreaterThan(split);
  expect(html).not.toMatch(/<details[^>]*\bopen/); expect(html).not.toContain('<textarea');
  expect(html.match(/<button[^>]+class="button(?: primary)?"/g)).toHaveLength(1);
});
