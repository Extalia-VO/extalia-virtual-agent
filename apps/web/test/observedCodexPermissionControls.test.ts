import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, CodexPermissionHookRequest, CodexPermissionHookStatus, CodexPermissionSetupPlan } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { createCodexPermissionControl, ObservedCodexPermissionContent } from '../src/observe/ObservedCodexPermissionControls';

const instant = Date.parse('2030-01-01T00:00:00Z');
const request = (patch: Partial<CodexPermissionHookRequest> = {}): CodexPermissionHookRequest => ({
  requestId: 'opaque-request', payloadDigest: 'a'.repeat(64), nativeSessionId: 'native-thread', turnId: 'native-turn', toolName: 'Bash',
  sourceJson: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'printf example' }, cwd: '/tmp/example' }),
  expiresAt: new Date(instant + 55_000).toISOString(), availableDecisions: ['allow', 'deny', 'pass'], ...patch,
});
const status = (requests: CodexPermissionHookRequest[] = []): CodexPermissionHookStatus => ({ sessionId: 'observed', state: 'ready', installed: false, requests });
const plan: CodexPermissionSetupPlan = {
  revision: 'reviewed-revision', changed: true, nativeSessionId: 'native-thread', configPath: '/tmp/example/hooks.json',
  forwarderPath: '/tmp/example/forwarder.cjs', tokenPath: '/tmp/example/token', createsPermissionToken: true,
  diff: '+ PermissionRequest hook', needsTrust: true, undoCommand: 'extalia permission-hook undo', backupDirectory: '/tmp/example/backups',
  files: [{ path: '/tmp/example/hooks.json', afterSha256: 'b'.repeat(64) }],
};
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup(initial = status()) {
  const api = {
    observedCodexPermissionStatus: vi.fn(async () => initial), previewObservedCodexPermissionHook: vi.fn(async () => plan),
    applyObservedCodexPermissionHook: vi.fn(async () => ({ ...status(), installed: true })), answerObservedCodexPermission: vi.fn(async () => status()),
  };
  const model = createCodexPermissionControl(api as unknown as AgentHostApi, 'observed');
  stops.push(model.start()); return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('requires a preview and explicit reviewed consent before install and undo', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const { api, model } = setup(); await settle();
  await model.apply(); expect(api.applyObservedCodexPermissionHook).not.toHaveBeenCalled();
  await model.preview(); await model.apply(); expect(api.applyObservedCodexPermissionHook).not.toHaveBeenCalled();
  model.acknowledge(true); await model.apply();
  expect(api.applyObservedCodexPermissionHook).toHaveBeenCalledExactlyOnceWith('observed', plan.revision, false);
  expect(model.getSnapshot().review).toBeUndefined();
  await model.preview(true); expect(model.getSnapshot().review?.acknowledged).toBe(false);
  await model.apply(); expect(api.applyObservedCodexPermissionHook).toHaveBeenCalledTimes(1);
  model.acknowledge(true); await model.apply();
  expect(api.applyObservedCodexPermissionHook).toHaveBeenLastCalledWith('observed', plan.revision, true);
});

it('does not answer a changed or withdrawn pending request after the fresh status read', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const original = request(); const { api, model } = setup(status([original])); await settle();
  const pending = deferred<CodexPermissionHookStatus>(); api.observedCodexPermissionStatus.mockReturnValueOnce(pending.promise);
  const answer = model.answer(original, 'allow');
  pending.resolve(status([request({ sourceJson: '{"command":"changed"}', payloadDigest: 'c'.repeat(64) })])); await answer;
  expect(api.answerObservedCodexPermission).not.toHaveBeenCalled();
  api.observedCodexPermissionStatus.mockResolvedValue(status());
  await model.answer(model.getSnapshot().status!.requests[0]!, 'deny');
  expect(api.answerObservedCodexPermission).not.toHaveBeenCalled();
});

it('rechecks expiry after the status read and never submits an unadvertised choice', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const original = request({ availableDecisions: ['deny', 'pass'] }); const { api, model } = setup(status([original])); await settle();
  await model.answer(original, 'allow'); expect(api.observedCodexPermissionStatus).toHaveBeenCalledTimes(1);
  const pending = deferred<CodexPermissionHookStatus>(); api.observedCodexPermissionStatus.mockReturnValueOnce(pending.promise);
  const answer = model.answer(original, 'deny'); vi.setSystemTime(instant + 55_001); pending.resolve(status([original])); await answer;
  expect(api.answerObservedCodexPermission).not.toHaveBeenCalled();
});

it('sends the selected decision once with the exact host handle and digest, never native JSON', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const original = request(); const { api, model } = setup(status([original])); await settle();
  const pending = deferred<CodexPermissionHookStatus>(); api.answerObservedCodexPermission.mockReturnValueOnce(pending.promise);
  const answer = model.answer(original, 'deny'); await settle(); await model.answer(original, 'allow');
  expect(api.answerObservedCodexPermission).toHaveBeenCalledExactlyOnceWith('observed', { requestId: original.requestId, payloadDigest: original.payloadDigest, decision: 'deny' });
  pending.resolve(status()); await answer;
});

it('does not overlap polling or apply late reads after unmount', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const { api, model } = setup(); await settle();
  const pending = deferred<CodexPermissionHookStatus>(); api.observedCodexPermissionStatus.mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(4000); expect(api.observedCodexPermissionStatus).toHaveBeenCalledTimes(2);
  stops.pop()!(); pending.resolve(status([request()])); await settle();
  expect(model.getSnapshot().status?.requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(4000); expect(api.observedCodexPermissionStatus).toHaveBeenCalledTimes(2);
});

it('invalidates pending capabilities on foreign status or read failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const { api, model } = setup(status([request()])); await settle();
  api.observedCodexPermissionStatus.mockResolvedValueOnce({ ...status([request()]), sessionId: 'foreign' }); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined });
  await model.answer(request(), 'allow'); expect(api.answerObservedCodexPermission).not.toHaveBeenCalled();
});

it('renders full payload and review evidence with no selected decision or fake connection claim in both languages', async () => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  const sourceJson = 'BEGIN ' + 'full-native-data '.repeat(1000) + ' END';
  const { model } = setup({ ...status([request({ sourceJson, availableDecisions: ['deny', 'pass'] })]), installed: true }); await settle(); await model.preview();
  for (const language of ['en', 'id'] as const) {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(ObservedCodexPermissionContent, { t, view: model.getSnapshot(), control: model }));
    expect(html).toContain(sourceJson); expect(html).toContain(plan.undoCommand); expect(html).toContain(plan.backupDirectory);
    expect(html).toContain(plan.revision); expect(html).toContain(t.observedCodexPermission.trust.replaceAll('>', '&gt;'));
    expect(html).not.toContain('checked=""'); expect(html).not.toContain('value="allow"');
    expect(html).toContain('value="deny"'); expect(html).toContain('value="pass"');
  }
});
