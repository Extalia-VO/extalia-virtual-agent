import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
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
const change = (node: ReactElement<Record<string, unknown>>, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });

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

describe('shared Native skill-learning composer', () => {
  it.each(['en', 'id'] as const)('labels opt-in and scanner/quarantine hint in %s, resets after success', async language => {
    const h = harness(language), t = MESSAGES[language];
    expect(checkbox(h.render())?.props.checked).toBe(false);
    expect(text(h.render())).toContain(t.composer.learnSkill);
    expect(text(h.render())).not.toContain(t.composer.learnSkillHint);
    change(checkbox(h.render())!, true); h.type('Learn this procedure');
    expect(text(h.render())).toContain(t.composer.learnSkillHint);
    h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalledWith(expect.objectContaining({ text: 'Learn this procedure', learnSkill: true })));
    await Promise.resolve(); await Promise.resolve();
    expect(checkbox(h.render())?.props.checked).toBe(false);
  });

  it('retains the choice and text after a failed send for the same context', async () => {
    const h = harness(); h.props.onSend = vi.fn(async () => false);
    change(checkbox(h.render())!, true); h.type('Keep this draft'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(checkbox(h.render())?.props.checked).toBe(true);
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('Keep this draft');
  });

  it.each(['hermes', 'readOnly', 'plan'] as const)('never submits learning in %s mode', async mode => {
    const h = harness(); change(checkbox(h.render())!, true);
    if (mode === 'plan') h.props.session = { id: 'session', options: { permissionMode: 'plan' } } as SessionSummary;
    else h.props[mode] = true;
    expect(checkbox(h.render())).toBeUndefined();
    if (mode !== 'readOnly') {
      h.type('Read as data'); h.submit();
      await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
      expect((h.props.onSend as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('learnSkill');
    }
  });

  it.each(['workspace', 'session', 'host'] as const)('drops the choice across %s replacement, including switching back', dimension => {
    const h = harness(); change(checkbox(h.render())!, true);
    const old = { ...h.props };
    if (dimension === 'workspace') h.props.workspaceId = 'another-workspace';
    if (dimension === 'session') h.props.session = { id: 'another-session' } as SessionSummary;
    if (dimension === 'host') h.props.agents = { ...h.props.agents };
    expect(checkbox(h.render())?.props.checked).toBe(false);
    Object.assign(h.props, old);
    expect(checkbox(h.render())?.props.checked).toBe(false);
  });

  it('disables the learning choice during approvals, running turns and pending sends', () => {
    const h = harness();
    h.props.waiting = true; expect(checkbox(h.render())?.props.disabled).toBe(true);
    h.props.waiting = false; h.props.running = true; expect(checkbox(h.render())?.props.disabled).toBe(true);
    h.props.running = false; h.props.onSend = () => new Promise<boolean>(() => undefined);
    h.type('Pending'); h.submit(); expect(checkbox(h.render())?.props.disabled).toBe(true);
  });

  it('does not restore an old learning choice or overwrite a new draft after late failure', async () => {
    const h = harness(); let settle!: (value: boolean) => void;
    h.props.onSend = vi.fn((_request: ComposerSend) => new Promise<boolean>(resolve => { settle = resolve; }));
    change(checkbox(h.render())!, true); h.type('Old draft'); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.workspaceId = 'new-workspace'; h.type('New draft');
    settle(false); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(checkbox(h.render())?.props.checked).toBe(false);
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New draft');
  });

  it('clears consumed attachment chips when first-session creation changes context without clearing new text', async () => {
    const h = harness(); let settle!: (value: boolean) => void;
    h.props.agents = { ...h.props.agents, uploadAttachment: vi.fn() };
    h.props.onSend = vi.fn((_request: ComposerSend) => new Promise<boolean>(resolve => { settle = resolve; }));
    const fileInput = elements(h.render()).find(item => item.type === 'input' && item.props.type === 'file')!;
    (fileInput.props.onChange as (event: unknown) => void)({ target: { files: [new File(['Reference'], 'reference.md', { type: 'text/markdown' })], value: 'reference.md' } });
    h.type('Learn this reference'); change(checkbox(h.render())!, true); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.session = { id: 'created-session' } as SessionSummary; h.type('New text');
    expect(text(h.render())).toContain('reference.md');
    settle(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(text(h.render())).not.toContain('reference.md');
    expect(checkbox(h.render())?.props.checked).toBe(false);
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('New text');
  });

  it('preserves first-session learning, prompt and uploaded ids after host refusal, then retries without reupload', async () => {
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
    h.type('Learn and keep this procedure'); change(checkbox(h.render())!, true); h.submit();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(checkbox(h.render())?.props.checked).toBe(true);
    expect(elements(h.render()).find(item => item.type === 'textarea')!.props.value).toBe('Learn and keep this procedure');
    expect(text(h.render())).toContain('reference.md');
    h.submit();
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenLastCalledWith('created-session', 'Learn and keep this procedure', { attachmentIds: [uploadedId], learnSkill: true });
    expect(checkbox(h.render())?.props.checked).toBe(false);
    expect(text(h.render())).not.toContain('reference.md');
  });

  it('refuses a late first-session handoff after navigation without selecting it or restoring old learning', async () => {
    const h = harness(); let finishCreation!: () => void;
    const selected = vi.fn();
    h.props.onSend = vi.fn(async (request: ComposerSend) => {
      await new Promise<void>(resolve => { finishCreation = resolve; });
      if (!request.bindSession!('late-session')) return false;
      selected(); h.props.session = { id: 'late-session' } as SessionSummary; return true;
    });
    h.type('Old request'); change(checkbox(h.render())!, true); h.submit();
    await vi.waitFor(() => expect(h.props.onSend).toHaveBeenCalled());
    h.props.workspaceId = 'different-workspace'; h.type('New input');
    finishCreation(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
    expect(checkbox(h.render())?.props.checked).toBe(false);
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
    h.type('Old learning request'); change(checkbox(h.render())!, true); h.submit();
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    if (dimension === 'workspace') h.props.workspaceId = 'new-workspace';
    else h.props.agents = { ...originalHost };
    h.type('New input');
    finishState({} as HostState);
    await vi.waitFor(() => expect(checkbox(h.render())?.props.disabled).toBe(false));
    expect(onState).not.toHaveBeenCalled(); expect(onSelect).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled(); expect(sendPrompt).not.toHaveBeenCalled();
    expect(checkbox(h.render())?.props.checked).toBe(false);
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
