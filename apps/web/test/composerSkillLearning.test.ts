import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState, PromptQueueChange, PromptQueueStatus, SessionSummary } from '@extalia/platform';
import { Composer, type ComposerSend } from '../src/chat/Composer';
import { sendPromptWithAttachments, uploadAttachments } from '../src/chat/attachments';
import { createMockPlatform } from '../src/host/mockHost';
import { createComposerSession } from '../src/chat/sessionHandoff';
import { MESSAGES } from '../src/i18n';

// Exercise the actual shared composer handlers with scoped in-memory hooks.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], memo: new Map<number, { deps: unknown[]; value: unknown }>(), effects: new Map<number, unknown[]>(), pending: [] as (() => void)[] }));
vi.mock('../src/restart/unsavedDrafts', () => ({ useUnsavedDraft: () => undefined }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const effect = (run: () => void, deps: unknown[]) => {
    const id = hooks.index++;
    if (!same(hooks.effects.get(id), deps)) { hooks.effects.set(id, deps); hooks.pending.push(run); }
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
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useEffect: effect, useLayoutEffect: effect, useId: () => 'test-composer',
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const checkbox = (tree: ReactNode) => elements(tree).find(item => item.type === 'input' && item.props.type === 'checkbox');
const change = (node: ReactElement<Record<string, unknown>>, value: string) => (node.props.onChange as (event: unknown) => void)({ target: { value } });

function harness(language: 'en' | 'id' = 'en') {
  const agents = { modelChoices: vi.fn(async () => ({ models: [], efforts: [] })), setSessionOptions: vi.fn(async () => undefined) } as unknown as AgentHostApi;
  const props: Parameters<typeof Composer>[0] = { t: MESSAGES[language], agents, workspaceId: 'workspace', hermes: false, running: false, waiting: false, readOnly: false, stopping: false, onSend: vi.fn(async () => true), onStop: vi.fn() };
  const render = () => {
    let tree: ReactNode;
    do {
      hooks.dirty = false; hooks.index = 0;
      tree = Composer(props);
      for (const run of hooks.pending.splice(0)) run();
    } while (hooks.dirty);
    return tree;
  };
  const type = (value: string) => { const tree = render(); change(elements(tree).find(item => item.type === 'textarea')!, value); };
  const submit = () => { const tree = render(); (elements(tree).find(item => item.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); };
  return { props, render, type, submit };
}

beforeEach(() => { hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = []; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('session-bound prompt recovery', () => {
  it('restores separate text across session navigation, hook state updates and composer remount', () => {
    const h = harness();
    const one = { id: 'session-one', workspaceId: 'workspace', control: 'managed' } as SessionSummary;
    const two = { ...one, id: 'session-two' };
    h.props.session = one; h.type('First unsent prompt');
    h.props.session = two;
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('');
    h.type('Second unsent prompt');
    h.props.session = { ...one, running: true, title: 'Updated by a live event' };
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('First unsent prompt');
    // Closing removes all local React state, while the same host/session survives.
    hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = [];
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('First unsent prompt');
    h.props.session = two;
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('Second unsent prompt');
  });
  it('allows another session to send while the original receipt is pending, without clearing its new text', async () => {
    const h = harness(); let finish!: (ok: boolean) => void;
    h.props.session = { id: 'session-one', workspaceId: 'workspace', control: 'managed' } as SessionSummary;
    h.props.onSend = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValueOnce(true);
    h.type('First send'); h.submit();
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('First send');
    h.props.session = { ...h.props.session, id: 'session-two' };
    h.type('Second send'); h.submit(); await Promise.resolve(); await Promise.resolve();
    expect(h.props.onSend).toHaveBeenCalledTimes(2);
    h.props.session = { ...h.props.session, id: 'session-one' }; h.type('New text for first session');
    finish(true); await Promise.resolve(); await Promise.resolve();
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('New text for first session');
  });
});

describe('one busy-session composer', () => {
  function queuedComposer(unknown = false) {
    vi.useFakeTimers();
    const h = harness();
    const status: PromptQueueStatus = { sessionId: 'session', revision: 'r1', supported: true, paused: true, maxTextLength: 100_000, items: [] };
    const changeQueue = vi.fn(async (_sessionId: string, request: PromptQueueChange) => ({ ...status, revision: 'r2', paused: false,
      items: [{ id: 'queued', text: 'text' in request ? request.text : 'Follow up', state: unknown ? 'unknown' as const : 'pending' as const, createdAt: '2030-01-01T00:00:00Z' }] }));
    h.props.agents = { ...h.props.agents, promptQueueStatus: vi.fn(async () => status), changePromptQueue: changeQueue };
    h.props.session = { id: 'session', control: 'managed' } as SessionSummary;
    h.props.running = true; h.props.waiting = true;
    h.render();
    return { ...h, changeQueue };
  }
  it.each(['native', 'plan', 'hermes'] as const)('queues ordinary linked-learning prompts in %s during work and approvals', async mode => {
    const h = queuedComposer();
    h.props.hermes = mode === 'hermes';
    if (mode === 'plan') h.props.session = { ...h.props.session!, options: { permissionMode: 'plan' } };
    await vi.advanceTimersByTimeAsync(0);
    h.type('Learn this procedure from https://example.com/guide');
    expect(checkbox(h.render())).toBeUndefined();
    expect(elements(h.render()).filter(node => node.type === 'textarea')).toHaveLength(1);
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.disabled).toBe(false);
    h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(h.changeQueue).toHaveBeenCalledExactlyOnceWith('session', { action: 'add', text: 'Learn this procedure from https://example.com/guide', start: true, revision: 'r1' });
    expect(h.props.onSend).not.toHaveBeenCalled();
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('');
  });
  it('holds queue submission for workspace review while retaining an editable draft and Stop', async () => {
    const h = queuedComposer(); await vi.advanceTimersByTimeAsync(0);
    h.props.sendBlocked = true;
    h.type('Keep this pending draft');
    const input = elements(h.render()).find(node => node.type === 'textarea')!;
    expect(input.props.disabled).toBe(false);
    expect(input.props.placeholder).not.toBe(MESSAGES.en.chat.placeholderObserved);
    h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(h.changeQueue).not.toHaveBeenCalled();
    expect(h.props.onSend).not.toHaveBeenCalled();
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('Keep this pending draft');
    expect(elements(h.render()).some(node => node.type === 'button' && node.props.onClick === h.props.onStop)).toBe(true);
    h.props.sendBlocked = false;
    h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(h.changeQueue).toHaveBeenCalledExactlyOnceWith('session', { action: 'add', text: 'Keep this pending draft', start: true, revision: 'r1' });
  });
  it('retains the main draft when queue delivery is uncertain', async () => {
    const h = queuedComposer(true); await vi.advanceTimersByTimeAsync(0);
    h.type('Follow up'); h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(elements(h.render()).find(node => node.type === 'textarea')!.props.value).toBe('Follow up');
    expect(h.props.onSend).not.toHaveBeenCalled();
    h.props.running = false; h.props.waiting = false;
    h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(h.changeQueue).toHaveBeenCalledTimes(1);
    expect(h.props.onSend).not.toHaveBeenCalled();
  });
  it('uses the session working flag while transcript activity is still catching up', async () => {
    const h = queuedComposer();
    h.props.running = false; h.props.waiting = false; h.props.session!.running = true;
    await vi.advanceTimersByTimeAsync(0);
    h.type('Follow up'); h.submit(); await vi.advanceTimersByTimeAsync(0);
    expect(h.changeQueue).toHaveBeenCalledTimes(1);
    expect(h.props.onSend).not.toHaveBeenCalled();
  });
});

describe('workspace-review send hold', () => {
  it('retains text and attached files until explicit review permits sending', async () => {
    const h = harness();
    h.props.agents.uploadAttachment = vi.fn();
    h.type('Continue in the new folder');
    const file = new File(['Keep this attachment'], 'example.txt', { type: 'text/plain' });
    const input = elements(h.render()).find(node => node.type === 'input' && node.props.type === 'file')!;
    (input.props.onChange as (event: unknown) => void)({ target: { files: [file], value: '' } });
    h.props.sendBlocked = true;
    h.submit(); await Promise.resolve();
    const tree = h.render();
    expect(elements(tree).find(node => node.type === 'textarea')!.props.disabled).toBe(false);
    expect(elements(tree).find(node => node.type === 'textarea')!.props.value).toBe('Continue in the new folder');
    expect(text(tree)).toContain('example.txt');
    expect(h.props.onSend).not.toHaveBeenCalled();
    expect(h.props.agents.uploadAttachment).not.toHaveBeenCalled();
    h.props.sendBlocked = false;
    h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalledOnce());
    expect(h.props.onSend).toHaveBeenCalledWith(expect.objectContaining({ text: 'Continue in the new folder', attachments: [expect.objectContaining({ name: 'example.txt', file })] }));
  });
});

describe('shared composer automatic-learning presentation', () => {
  it.each(['en', 'id'] as const)('has no learning checkbox or hint in %s and sends ordinary linked-learning text', async language => {
    const h = harness(language);
    expect(checkbox(h.render())).toBeUndefined();
    expect(text(h.render())).not.toMatch(/Learn as skill|Pelajari sebagai skill|quarantined|dikarantina/);
    h.type('Learn this procedure from https://example.com/guide'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    const request = (h.props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(request.text).toBe('Learn this procedure from https://example.com/guide');
    expect(request).not.toHaveProperty('learnSkill');
    await Promise.resolve(); await Promise.resolve();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('');
  });

  it('retains text after a failed send for the same context', async () => {
    const h = harness(); h.props.onSend = vi.fn(async () => false);
    h.type('Keep this draft'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('Keep this draft');
  });

  it.each(['native', 'hermes', 'readOnly', 'plan'] as const)('has no learning toggle and never emits a learning flag in %s mode', async mode => {
    const h = harness();
    if (mode === 'plan') h.props.session = { id: 'session', options: { permissionMode: 'plan' } } as SessionSummary;
    else if (mode !== 'native') h.props[mode] = true;
    expect(checkbox(h.render())).toBeUndefined();
    h.type('Learn this procedure'); h.submit();
    if (mode === 'readOnly') expect(h.props.onSend).not.toHaveBeenCalled();
    else {
      await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
      expect((h.props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('learnSkill');
    }
  });

  it.each(['workspace', 'session', 'host'] as const)('preserves each draft across %s replacement, including switching back', dimension => {
    const h = harness(); h.type('Original draft');
    const old = { ...h.props };
    if (dimension === 'workspace') h.props.workspaceId = 'another-workspace';
    if (dimension === 'session') h.props.session = { id: 'another-session' } as SessionSummary;
    if (dimension === 'host') h.props.agents = { ...h.props.agents };
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('');
    h.type('New draft');
    Object.assign(h.props, old); h.props.session = old.session;
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('Original draft');
  });

  it('does not overwrite a new draft after late failure', async () => {
    const h = harness(); let settle!: (value: boolean) => void;
    h.props.onSend = vi.fn((_request: ComposerSend) => new Promise<boolean>(resolve => { settle = resolve; }));
    h.type('Old draft'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.workspaceId = 'new-workspace'; h.type('New draft');
    settle(false); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New draft');
  });

  it('clears consumed attachment chips when first-session creation changes context without clearing new text', async () => {
    const h = harness(); let settle!: (value: boolean) => void;
    h.props.agents = { ...h.props.agents, uploadAttachment: vi.fn() };
    h.props.onSend = vi.fn((_request: ComposerSend) => new Promise<boolean>(resolve => { settle = resolve; }));
    const fileInput = elements(h.render()).find(item => item.type === 'input' && item.props.type === 'file')!;
    (fileInput.props.onChange as (event: unknown) => void)({ target: { files: [new File(['Reference'], 'reference.md', { type: 'text/markdown' })], value: 'reference.md' } });
    h.type('Learn this reference'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.session = { id: 'created-session' } as SessionSummary; h.type('New text');
    expect(text(h.render())).toContain('reference.md');
    settle(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(text(h.render())).not.toContain('reference.md');
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New text');
  });

  it('preserves first-session prompt and uploaded ids after host refusal, then retries without reupload', async () => {
    const h = harness();
    const uploadedId = `att_${'a'.repeat(24)}`;
    const uploadAttachment = vi.fn(async () => ({ id: uploadedId, name: 'reference.md', mimeType: 'text/markdown', size: 9, kind: 'text' as const }));
    const sendPrompt = vi.fn().mockRejectedValueOnce(new Error('Skill registry unavailable')).mockResolvedValueOnce(undefined);
    h.props.agents = { ...h.props.agents, uploadAttachment, sendPrompt };
    const createSession = vi.fn(async () => ({ id: 'created-session' } as SessionSummary));
    h.props.onSend = vi.fn(async (request: ComposerSend) => {
      if (!h.props.session) {
        const created = await createSession();
        if (!request.bindSession!(created.id)) return false;
        h.props.session = created; h.render();
      }
      const ids = await uploadAttachments(h.props.agents, h.props.session.id, request.attachments, request.patch);
      await sendPromptWithAttachments(h.props.agents, h.props.session.id, request.text, ids, request.learnSkill);
      return true;
    });
    const fileInput = elements(h.render()).find(item => item.type === 'input' && item.props.type === 'file')!;
    (fileInput.props.onChange as (event: unknown) => void)({ target: { files: [new File(['Reference'], 'reference.md', { type: 'text/markdown' })], value: 'reference.md' } });
    h.type('Learn and keep this procedure'); h.submit();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('Learn and keep this procedure');
    expect(text(h.render())).toContain('reference.md');
    h.submit();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenLastCalledWith('created-session', 'Learn and keep this procedure', { attachmentIds: [uploadedId] });
    expect(text(h.render())).not.toContain('reference.md');
  });

  it('refuses a late first-session handoff after navigation without selecting it', async () => {
    const h = harness(); let finishCreation!: () => void;
    const selected = vi.fn();
    h.props.onSend = vi.fn(async (request: ComposerSend) => {
      await new Promise<void>(resolve => { finishCreation = resolve; });
      if (!request.bindSession!('late-session')) return false;
      selected(); h.props.session = { id: 'late-session' } as SessionSummary; return true;
    });
    h.type('Old request'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.workspaceId = 'different-workspace'; h.type('New input');
    finishCreation(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New input');
  });

  it.each(['workspace', 'host'] as const)('does not select, upload or send after %s changes while first-session state refresh is pending', async dimension => {
    const h = harness(); let finishState!: (state: HostState) => void;
    const getState = vi.fn(() => new Promise<HostState>(resolve => { finishState = resolve; }));
    const onState = vi.fn(), onSelect = vi.fn();
    const uploadAttachment = vi.fn(), sendPrompt = vi.fn();
    const originalHost = { ...h.props.agents, getState, createSession: vi.fn(async () => ({ id: 'created-session' } as SessionSummary)), uploadAttachment, sendPrompt };
    h.props.agents = originalHost;
    h.props.onSend = vi.fn(async (request: ComposerSend) => {
      const id = await createComposerSession({ agents: originalHost, workspaceId: 'workspace', choice: request.choice,
        bindSession: request.bindSession, onState, onSelect, interrupted: 'Interrupted' });
      const ids = await uploadAttachments(originalHost, id, request.attachments, request.patch);
      await sendPromptWithAttachments(originalHost, id, request.text, ids, request.learnSkill);
      return true;
    });
    h.type('Old learning request'); h.submit();
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    if (dimension === 'workspace') h.props.workspaceId = 'new-workspace';
    else h.props.agents = { ...originalHost };
    h.type('New input');
    finishState({} as HostState);
    await vi.waitFor(() => expect(elements(h.render()).find(item => item.type === 'button' && item.props.type === 'submit')!.props.disabled).toBe(false));
    expect(onState).not.toHaveBeenCalled(); expect(onSelect).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled(); expect(sendPrompt).not.toHaveBeenCalled();
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New input');
  });

  it.each([
    { text: 'Learn this', options: { learnSkill: true } },
    { text: '  /learn-skill Learn this', options: undefined },
  ])('preview host refuses unsupported learning without claiming scanner success: $text', async ({ text: prompt, options }) => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    await expect(agents.sendPrompt('not-used', prompt, options)).rejects.toThrow('not available in this preview');
  });
});
