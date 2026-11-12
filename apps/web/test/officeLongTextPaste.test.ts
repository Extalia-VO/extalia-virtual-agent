import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficePromptDock } from '../src/office/OfficePromptDock';
import { SessionWorkspaceReview } from '../src/chat/SessionWorkspaceReview';
import { MESSAGES } from '../src/i18n';

// Exercise the real dock handlers; effects retain their cleanup on navigation.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], memo: new Map<number, { deps: unknown[]; value: unknown }>(), effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const effect = (run: () => void | (() => void), deps: unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (!same(prior?.deps, deps)) {
      const next = { deps, cleanup: undefined as (() => void) | undefined };
      hooks.effects.set(id, next);
      hooks.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; });
    }
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.state[id]) : next;
        if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
      }];
    },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const id = hooks.index++, prior = hooks.memo.get(id);
      if (!prior || !same(prior.deps, deps)) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect, useId: () => 'test-office-dock',
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const contents = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(contents).join('') : isValidElement<{ children?: ReactNode }>(node) ? contents(node.props.children) : '';
const at = '2026-11-08T00:00:00.000Z';
const workspace = { id: 'workspace-a', profileId: 'default', name: 'Example A', createdAt: at, updatedAt: at };
const session = (id: string, workspaceId = workspace.id): SessionSummary => ({ id, workspaceId, connectionId: '', title: 'Example task', control: 'managed', running: false, createdAt: at, lastActiveAt: at });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

function harness(language: 'en' | 'id' = 'en') {
  const state = { profile: { id: 'default', name: 'Example' }, connections: [], workspaces: [workspace, { ...workspace, id: 'workspace-b', name: 'Example B' }], sessions: [session('existing-a'), session('existing-b', 'workspace-b')] } as unknown as HostState;
  const host = {
    createSession: vi.fn(async () => session('created-a')),
    sendPrompt: vi.fn(async () => undefined),
    uploadAttachment: vi.fn(async (_id: string, input: { name: string; mimeType: string; data: string }) => ({ id: input.name, name: input.name, mimeType: input.mimeType, size: 1, kind: 'text' as const })),
    removeAttachment: vi.fn(async () => undefined),
    getState: vi.fn(async () => state),
  };
  const props: Parameters<typeof OfficePromptDock>[0] = { t: MESSAGES[language], agents: host as unknown as AgentHostApi, state, workspaceId: workspace.id, onTarget: vi.fn(), onState: vi.fn(), onStarted: vi.fn(), onOpenSettings: vi.fn() };
  const render = () => {
    let tree: ReactNode;
    do {
      hooks.dirty = false; hooks.index = 0;
      tree = OfficePromptDock(props);
      for (const run of hooks.pending.splice(0)) run();
    } while (hooks.dirty);
    return tree;
  };
  const area = () => elements(render()).find(item => item.type === 'textarea')!;
  const type = (value: string) => (area().props.onChange as (event: unknown) => void)({ target: { value } });
  const paste = (incoming: string, start = 0, end = start) => {
    const preventDefault = vi.fn();
    (area().props.onPaste as (event: unknown) => void)({ preventDefault, currentTarget: { selectionStart: start, selectionEnd: end }, clipboardData: { files: [], getData: () => incoming } });
    return preventDefault;
  };
  const sendButton = () => elements(render()).find(item => String(item.props.className).includes('office-prompt-send'))!;
  const send = async () => { (sendButton().props.onClick as () => void)(); await settle(); render(); };
  const chips = () => elements(render()).filter(item => item.type === 'li' && String(item.props.className).includes('composer-chip'));
  const review = () => elements(render()).find(item => item.type === SessionWorkspaceReview)!;
  return { host, props, render, area, type, paste, sendButton, send, chips, review };
}

beforeEach(() => {
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = [];
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), setTimeout: () => 1, clearTimeout() {} });
});
afterEach(() => { for (const effect of hooks.effects.values()) effect.cleanup?.(); vi.unstubAllGlobals(); });

it('keeps short paste native and sends an ordinary prompt without attachment options', async () => {
  const h = harness();
  expect(h.paste('a'.repeat(8000))).not.toHaveBeenCalled();
  h.type('  A short prompt  '); await h.send();
  expect(h.host.sendPrompt).toHaveBeenCalledWith('created-a', 'A short prompt');
  expect(h.host.uploadAttachment).not.toHaveBeenCalled();
});

it('returns a new-session draft to the default workspace after leaving another workspace', async () => {
  const h = harness(); h.props.workspaceId = 'workspace-b'; h.render();
  h.type('Keep this draft');
  delete h.props.workspaceId;
  const picker = elements(h.render()).find(item => item.props['aria-label'] === MESSAGES.en.officeUx.dockWorkspace)!;
  expect(picker.props.value).toBe('workspace-a');
  expect(h.area().props.value).toBe('Keep this draft');
  await h.send();
  expect(h.host.createSession).toHaveBeenCalledExactlyOnceWith('workspace-a');
  expect(h.host.sendPrompt).toHaveBeenCalledWith('created-a', 'Keep this draft');
});

it('keeps a targeted session in its source workspace when the active workspace returns to default', async () => {
  const h = harness(); h.props.workspaceId = 'workspace-b'; h.props.targetSessionId = 'existing-b'; h.render();
  delete h.props.workspaceId;
  const picker = elements(h.render()).find(item => item.props['aria-label'] === MESSAGES.en.officeUx.dockWorkspace)!;
  expect(picker.props.value).toBe('workspace-b');
  h.type('Continue this session'); await h.send();
  expect(h.host.createSession).not.toHaveBeenCalled();
  expect(h.host.sendPrompt).toHaveBeenCalledWith('existing-b', 'Continue this session');
  h.props.targetSessionId = undefined;
  expect(elements(h.render()).find(item => item.props['aria-label'] === MESSAGES.en.officeUx.dockWorkspace)!.props.value).toBe('workspace-a');
});

it.each(['en', 'id'] as const)('imports the complete selected draft exactly and shows a removable chip in %s', async language => {
  const h = harness(language); h.type('beforeOLDafter');
  const incoming = 'こんにちは🌟\n'.repeat(2000);
  expect(h.paste(incoming, 6, 9)).toHaveBeenCalledOnce();
  expect(h.area().props.value).toBe('');
  expect(contents(h.render())).toContain(MESSAGES[language].composer.longTextAttached);
  await h.send();
  const input = h.host.uploadAttachment.mock.calls[0]![1];
  expect(new TextDecoder().decode(Uint8Array.from(atob(input.data), char => char.charCodeAt(0)))).toBe('before' + incoming + 'after');
  expect(h.host.sendPrompt).toHaveBeenCalledWith('created-a', MESSAGES[language].composer.longTextPrompt(input.name), { attachmentIds: [input.name] });
  expect(h.chips()).toHaveLength(0);
});

it('removes an imported file before send', () => {
  const h = harness(); h.paste('x'.repeat(8001));
  const remove = elements(h.render()).find(item => item.props.title === MESSAGES.en.composer.removeFile)!;
  (remove.props.onClick as () => void)();
  expect(h.chips()).toHaveLength(0); expect(h.sendButton().props.disabled).toBe(true);
});

it('waits for every upload before sending the untruncated multi-part draft', async () => {
  const h = harness(); const wait = deferred<Awaited<ReturnType<typeof h.host.uploadAttachment>>>();
  h.host.uploadAttachment.mockImplementationOnce(() => wait.promise);
  const incoming = 'a'.repeat(99999) + '🌟' + 'z'.repeat(120000);
  h.paste(incoming); await h.send();
  expect(h.host.sendPrompt).not.toHaveBeenCalled(); expect(h.chips()).toHaveLength(3);
  const first = h.host.uploadAttachment.mock.calls[0]![1];
  wait.resolve({ id: first.name, name: first.name, mimeType: first.mimeType, size: 1, kind: 'text' });
  await vi.waitFor(() => expect(h.host.sendPrompt).toHaveBeenCalledOnce()); h.render();
  expect(h.host.uploadAttachment).toHaveBeenCalledTimes(3);
  const full = h.host.uploadAttachment.mock.calls.map(([, input]) => new TextDecoder().decode(Uint8Array.from(atob(input.data), char => char.charCodeAt(0)))).join('');
  expect(full).toBe(incoming); expect(h.host.sendPrompt).toHaveBeenCalledOnce();
});

it('retains oversized text and blocks send when complete conversion fails', async () => {
  const h = harness(); const incoming = 'x'.repeat(400001);
  h.paste(incoming); expect(h.area().props.value).toBe(incoming);
  expect(contents(h.render())).toContain(MESSAGES.en.composer.longTextFailed);
  await h.send(); expect(h.host.createSession).not.toHaveBeenCalled();
});

it('retains text on an older host without attachment support', async () => {
  const h = harness(); delete (h.props.agents as Partial<AgentHostApi>).uploadAttachment;
  const incoming = 'x'.repeat(100001); h.paste(incoming);
  expect(h.area().props.value).toBe(incoming); await h.send();
  expect(h.host.sendPrompt).not.toHaveBeenCalled();
});

it('reuses the created session and uploaded IDs after a send failure', async () => {
  const h = harness(); h.host.sendPrompt.mockRejectedValueOnce(new Error('try again'));
  h.paste('x'.repeat(8001)); await h.send();
  expect(h.chips()).toHaveLength(1); expect(contents(h.render())).toContain('try again');
  await h.send();
  expect(h.host.createSession).toHaveBeenCalledOnce(); expect(h.host.uploadAttachment).toHaveBeenCalledOnce();
  expect(h.host.sendPrompt.mock.calls[0]).toEqual(h.host.sendPrompt.mock.calls[1]);
});

it('retries a failed upload in the same created session', async () => {
  const h = harness(); h.host.uploadAttachment.mockRejectedValueOnce(new Error('upload failed'));
  h.paste('x'.repeat(8001)); await h.send(); expect(h.host.sendPrompt).not.toHaveBeenCalled();
  expect(contents(h.render())).toContain(MESSAGES.en.composer.uploadFailed);
  await h.send(); expect(h.host.createSession).toHaveBeenCalledOnce();
  expect(h.host.uploadAttachment.mock.calls.map(([id]) => id)).toEqual(['created-a', 'created-a']);
});

it.each(['target', 'workspace'] as const)('does not deliver an old upload after changing %s away and back', async navigation => {
  const h = harness(); const wait = deferred<Awaited<ReturnType<typeof h.host.uploadAttachment>>>();
  h.props.targetSessionId = 'existing-a';
  h.host.uploadAttachment.mockImplementationOnce(() => wait.promise);
  h.paste('x'.repeat(8001)); await h.send();
  if (navigation === 'target') h.props.targetSessionId = 'existing-b'; else h.props.workspaceId = 'workspace-b';
  h.render();
  if (navigation === 'target') h.props.targetSessionId = 'existing-a'; else h.props.workspaceId = workspace.id;
  h.render();
  const input = h.host.uploadAttachment.mock.calls[0]![1];
  wait.resolve({ id: 'old-upload', name: input.name, mimeType: input.mimeType, size: 1, kind: 'text' });
  await settle(); h.render();
  expect(h.host.sendPrompt).not.toHaveBeenCalled(); expect(h.props.onStarted).not.toHaveBeenCalled();
  await h.send();
  expect(h.host.uploadAttachment).toHaveBeenCalledTimes(2);
  expect(h.host.sendPrompt).toHaveBeenCalledWith('existing-a', expect.any(String), { attachmentIds: [input.name] });
});

it('does not upload or target a session created after navigation', async () => {
  const h = harness(); const wait = deferred<SessionSummary>();
  h.host.createSession.mockImplementationOnce(() => wait.promise);
  h.paste('x'.repeat(8001)); await h.send();
  h.props.workspaceId = 'workspace-b'; h.render();
  wait.resolve(session('late-created')); await settle(); h.render();
  expect(h.host.uploadAttachment).not.toHaveBeenCalled(); expect(h.host.sendPrompt).not.toHaveBeenCalled();
  expect(h.props.onTarget).not.toHaveBeenCalled();
});


it('keeps the imported team spec and native model choice on session creation', async () => {
  const h = harness();
  Object.assign(h.props.agents, {
    modelChoices: vi.fn(async () => ({ models: [], efforts: [] })),
    planTeam: vi.fn(), saveSessionTeam: vi.fn(),
  });
  const picker = elements(h.render()).find(item => item.props.id === 'test-office-dock-model')!;
  (picker.props.onChange as (value: string) => void)('example-model');
  const incoming = 'Build an example feature.\nSubagent A:\n- Name: Example Member\n- Role: Reviewer\n- Model: example-model\n- Task: Review the change.\n' + 'Details. '.repeat(1000);
  h.paste(incoming); await h.send();
  expect(h.host.createSession).toHaveBeenCalledWith('workspace-a', expect.objectContaining({ model: 'example-model', team: expect.objectContaining({ members: expect.arrayContaining([expect.objectContaining({ name: 'Example Member' })]) }) }));
});

it('continues the send when its own session model update is published', async () => {
  const h = harness(); h.props.targetSessionId = 'existing-a';
  const updated = deferred<void>();
  Object.assign(h.props.agents, {
    modelChoices: vi.fn(async () => ({ models: [], efforts: [] })),
    setSessionOptions: vi.fn(() => updated.promise),
  });
  const picker = elements(h.render()).find(item => item.props.id === 'test-office-dock-model')!;
  (picker.props.onChange as (value: string) => void)('example-model');
  h.paste('x'.repeat(8001)); await h.send();
  h.props.state = { ...h.props.state, sessions: h.props.state.sessions.map(item => item.id === 'existing-a' ? { ...item, options: { model: 'example-model' } } : item) };
  h.render(); updated.resolve(); await settle(); h.render();
  expect(h.host.sendPrompt).toHaveBeenCalledOnce();
});

const changedFolders = 'Workspace folders or access boundaries changed. Review this session’s workspace from session actions to keep its history under the current access, or start a new Native session.';
function requireReview(h: ReturnType<typeof harness>) {
  h.props.state = { ...h.props.state, sessions: h.props.state.sessions.map(item => item.id === 'existing-a' ? { ...item, workspaceReviewRequired: true } : item) };
  h.render();
}

it.each(['en', 'id'] as const)('keeps explicit folder review outside compact folds and blocks uploads, Send and Enter in %s', async language => {
  const h = harness(language); h.props.targetSessionId = 'existing-a'; h.props.compact = true;
  requireReview(h);
  const tree = h.render();
  expect(elements(tree)[0]!.props['data-open']).toBe(true);
  const form = elements(tree).find(item => item.props.role === 'group')!;
  expect((form.props.children as ReactNode[]).some(item => isValidElement(item) && item.type === SessionWorkspaceReview)).toBe(true);
  expect(h.review().props).toMatchObject({ required: true, session: expect.objectContaining({ id: 'existing-a' }), t: MESSAGES[language] });
  h.paste('Keep the imported draft. '.repeat(500)); h.type('Keep this message too.');
  expect(h.area().props.disabled).toBe(false);
  expect(h.sendButton().props.disabled).toBe(true);
  await h.send();
  const preventDefault = vi.fn();
  (h.area().props.onKeyDown as (event: unknown) => void)({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault });
  await settle(); h.render();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(h.host.uploadAttachment).not.toHaveBeenCalled(); expect(h.host.sendPrompt).not.toHaveBeenCalled();
  expect(h.host.createSession).not.toHaveBeenCalled(); expect(h.chips()).toHaveLength(1);
  expect(h.area().props.value).toBe('Keep this message too.');
});

it('recovers a rejected existing-session send even without a summary flag and retains text and uploaded IDs until explicit review', async () => {
  const h = harness(); h.props.targetSessionId = 'existing-a';
  h.host.sendPrompt.mockRejectedValueOnce(new Error(changedFolders));
  h.paste('Retain this imported attachment. '.repeat(400)); h.type('Retain this draft.');
  await h.send();
  expect(h.host.sendPrompt).toHaveBeenCalledOnce(); expect(h.host.uploadAttachment).toHaveBeenCalledOnce();
  expect(h.host.getState).toHaveBeenCalledOnce(); expect(h.props.onState).toHaveBeenCalledWith(h.props.state);
  expect(h.review().props.required).toBe(true); expect(h.sendButton().props.disabled).toBe(true);
  expect(h.area().props.value).toBe('Retain this draft.'); expect(h.chips()).toHaveLength(1);
  expect(contents(h.render())).toContain(changedFolders);
  (h.review().props.onReviewed as (next: HostState) => void)(h.props.state); h.render();
  expect(h.review().props.required).toBe(false); expect(h.sendButton().props.disabled).toBe(false);
  expect(contents(h.render())).not.toContain(changedFolders);
  expect(h.host.sendPrompt).toHaveBeenCalledOnce();
  await h.send();
  expect(h.host.uploadAttachment).toHaveBeenCalledOnce(); expect(h.host.sendPrompt).toHaveBeenCalledTimes(2);
  expect(h.host.sendPrompt.mock.calls[0]).toEqual(h.host.sendPrompt.mock.calls[1]);
});

it('leaves an ordinary existing-session failure available without offering folder consent', async () => {
  const h = harness(); h.props.targetSessionId = 'existing-a'; h.type('Keep the ordinary failure draft.');
  h.host.sendPrompt.mockRejectedValueOnce(new Error('The connection is unavailable.'));
  await h.send();
  expect(h.host.getState).not.toHaveBeenCalled(); expect(h.review().props.required).toBe(false);
  expect(contents(h.render())).toContain('The connection is unavailable.');
  expect(h.area().props.value).toBe('Keep the ordinary failure draft.');
});

it.each(['target', 'workspace'] as const)('ignores a folder-change send failure after %s changes away and back', async navigation => {
  const h = harness(); h.props.targetSessionId = 'existing-a'; h.type('Preserve this context draft.');
  let reject!: (failure: Error) => void;
  const pending = new Promise<undefined>((_resolve, fail) => { reject = fail; });
  h.host.sendPrompt.mockImplementationOnce(() => pending); await h.send();
  if (navigation === 'target') h.props.targetSessionId = 'existing-b'; else h.props.workspaceId = 'workspace-b'; h.render();
  if (navigation === 'target') h.props.targetSessionId = 'existing-a'; else h.props.workspaceId = workspace.id; h.render();
  reject(new Error(changedFolders)); await settle(); h.render();
  expect(h.host.getState).not.toHaveBeenCalled(); expect(h.props.onState).not.toHaveBeenCalled();
  expect(h.review().props.required).toBe(false); expect(contents(h.render())).not.toContain(changedFolders);
  expect(h.host.sendPrompt).toHaveBeenCalledOnce(); expect(h.area().props.value).toBe('Preserve this context draft.');
});

it('ignores a late recovery refresh after the target changes', async () => {
  const h = harness(); h.props.targetSessionId = 'existing-a'; h.type('Retain after navigation.');
  const refresh = deferred<HostState>();
  h.host.sendPrompt.mockRejectedValueOnce(new Error(changedFolders)); h.host.getState.mockImplementationOnce(() => refresh.promise);
  await h.send(); expect(h.host.getState).toHaveBeenCalledOnce();
  h.props.targetSessionId = 'existing-b'; h.render();
  refresh.resolve(h.props.state); await settle(); h.render();
  expect(h.props.onState).not.toHaveBeenCalled(); expect(h.review().props.required).toBe(false);
  expect(h.area().props.value).toBe('Retain after navigation.');
});

it.each(['options', 'upload'] as const)('stops delivery when the host requests review during an in-flight %s', async phase => {
  const h = harness(); h.props.targetSessionId = 'existing-a'; h.paste('Retain this attachment. '.repeat(500));
  const release = deferred<void>(), upload = deferred<Awaited<ReturnType<typeof h.host.uploadAttachment>>>();
  if (phase === 'options') {
    Object.assign(h.props.agents, { modelChoices: vi.fn(async () => ({ models: [], efforts: [] })), setSessionOptions: vi.fn(() => release.promise) });
    const picker = elements(h.render()).find(item => item.props.id === 'test-office-dock-model')!;
    (picker.props.onChange as (value: string) => void)('example-model');
  } else h.host.uploadAttachment.mockImplementationOnce(() => upload.promise);
  await h.send(); requireReview(h);
  if (phase === 'options') release.resolve();
  else {
    const input = h.host.uploadAttachment.mock.calls[0]![1];
    upload.resolve({ id: 'retained-upload', name: input.name, mimeType: input.mimeType, size: 1, kind: 'text' });
  }
  await settle(); h.render();
  expect(h.host.sendPrompt).not.toHaveBeenCalled(); expect(h.chips()).toHaveLength(1); expect(h.review().props.required).toBe(true);
  if (phase === 'options') expect(h.host.uploadAttachment).not.toHaveBeenCalled();
});
