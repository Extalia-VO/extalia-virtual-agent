import type * as React from 'react';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ConnectionsSection } from '../src/pages/settings/ConnectionsSection';
import { ConnectionForm } from '../src/setup/ConnectionForm';
import { draftFromPreset, toConnectionInput } from '../src/setup/validation';

type Store = { index: number; dirty: boolean; values: unknown[]; effects: Map<number, { deps: unknown[]; cleanup?: () => void }>; pending: (() => void)[] };
const hooks = vi.hoisted(() => ({ current: undefined as Store | undefined }));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const store = hooks.current!, index = store.index++;
    if (!(index in store.values)) store.values[index] = typeof initial === 'function' ? initial() : initial;
    return [store.values[index], (next: unknown) => {
      const value = typeof next === 'function' ? next(store.values[index]) : next;
      if (!Object.is(value, store.values[index])) { store.values[index] = value; store.dirty = true; }
    }];
  },
  useRef: (value: unknown) => { const store = hooks.current!, index = store.index++; return store.values[index] ??= { current: value }; },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const store = hooks.current!, index = store.index++, prior = store.effects.get(index);
    if (prior?.deps.length === deps.length && prior.deps.every((value, at) => Object.is(value, deps[at]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined };
    store.effects.set(index, next); store.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; });
  },
}));

const store = (): Store => ({ index: 0, dirty: false, values: [], effects: new Map(), pending: [] });
const dispose = (value: Store) => { for (const effect of value.effects.values()) effect.cleanup?.(); value.effects.clear(); };
function run<T>(value: Store, render: () => T): T {
  let output: T;
  do { hooks.current = value; value.index = 0; value.dirty = false; output = render(); for (const effect of value.pending.splice(0)) effect(); } while (value.dirty);
  return output;
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function harness(props: Parameters<typeof ConnectionsSection>[0]) {
  const outer = store(); let inner = store(), key: string | null | undefined;
  const draw = () => {
    const child = run(outer, () => ConnectionsSection(props));
    if (child.key !== key) { dispose(inner); inner = store(); key = child.key; }
    return elements(run(inner, () => (child.type as (value: typeof child.props) => ReactNode)(child.props)));
  };
  const stop = () => { dispose(inner); dispose(outer); };
  cleanups.push(stop);
  return { draw, stop };
}
const baseState = () => ({ profile: { id: 'default', name: 'Default' }, dataDirectory: '/data/default', connections: [], workspaces: [], sessions: [] }) as unknown as HostState;
const validDraft = () => ({ ...draftFromPreset('openai'), name: 'Example connection', apiKey: 'example-key', model: 'custom-model' });
const changeDraft = (nodes: ReturnType<typeof elements>, draft = validDraft()) => (nodes.find(node => node.type === ConnectionForm)!.props.onChange as (value: typeof draft) => void)(draft);
const submit = (nodes: ReturnType<typeof elements>) => (nodes.find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
const click = (node: ReactElement<Record<string, unknown>>) => (node.props.onClick as () => void)();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('connection settings save inputs', () => {
  it('admits one save, locks the draft, and retains values after a failed save for retry', async () => {
    const state = baseState();
    let rejectSave!: (error: Error) => void;
    const saveConnection = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }))
      .mockResolvedValueOnce(state);
    const props = { t: MESSAGES.en, agents: { saveConnection } as unknown as AgentHostApi, state, onState: vi.fn() };
    const { draw } = harness(props);
    const add = draw().find(node => node.type === 'button')!;
    (add.props.onClick as () => void)();
    const draft = { ...draftFromPreset('openai'), name: 'Example connection', apiKey: 'example-key', model: 'custom-model' };
    const change = (next: typeof draft) => (draw().find(node => node.type === ConnectionForm)!.props.onChange as (value: typeof draft) => void)(next);
    change(draft);
    const form = draw().find(node => node.type === 'form')!;
    expect(form.props.noValidate).toBe(true);
    expect(form.props.autoComplete).toBe('off');
    const submit = () => (draw().find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
    submit(); submit();
    expect(saveConnection).toHaveBeenCalledTimes(1);
    expect(draw().find(node => node.type === 'fieldset')!.props.disabled).toBe(true);
    expect(draw().find(node => node.type === 'form')!.props['aria-busy']).toBe(true);
    change({ ...draft, name: 'Unexpected pending edit' });
    rejectSave(new Error('Example save failure'));
    await flush();
    const failed = draw();
    expect(failed.find(node => node.type === ConnectionForm)!.props.draft).toEqual(draft);
    expect(failed.find(node => node.type === 'fieldset')!.props.disabled).toBe(false);
    expect(failed.some(node => node.props.role === 'alert')).toBe(true);
    submit(); await flush();
    expect(saveConnection).toHaveBeenCalledTimes(2);
    expect(props.onState).toHaveBeenCalledWith(state);
    expect(draw().some(node => node.type === ConnectionForm)).toBe(false);
  });

  it('shows localized validation without sending an invalid draft to the host', async () => {
    const saveConnection = vi.fn();
    const props = { t: MESSAGES.id, agents: { saveConnection } as unknown as AgentHostApi,
      state: baseState(), onState: vi.fn() };
    const { draw } = harness(props);
    (draw().find(node => node.type === 'button')!.props.onClick as () => void)();
    (draw().find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
    await flush();
    expect(saveConnection).not.toHaveBeenCalled();
    expect(draw().find(node => node.type === ConnectionForm)!.props.showAllErrors).toBe(true);
    expect(draw().find(node => node.type === 'fieldset')!.props.disabled).toBe(false);
  });

  it.each(['save', 'delete'] as const)('ignores %s replies after unmount, host/profile/directory changes and return to the original owner', async action => {
    for (const identity of ['unmount', 'host', 'profile', 'directory', 'ABA'] as const) {
      const pending = deferred<HostState>(), nextPending = deferred<HostState>();
      const method = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(nextPending.promise);
      const agents = { saveConnection: action === 'save' ? method : vi.fn(), deleteConnection: action === 'delete' ? method : vi.fn() } as unknown as AgentHostApi;
      const original = baseState();
      original.connections = [{ ...toConnectionInput(validDraft()).input, id: 'example', credentialStatus: 'ok', createdAt: '', updatedAt: '' } as HostState['connections'][number]];
      const props = { t: MESSAGES.en, agents, state: original, onState: vi.fn() };
      const h = harness(props);
      if (action === 'save') {
        click(h.draw().find(node => node.type === 'button')!); changeDraft(h.draw()); submit(h.draw());
      } else {
        click(h.draw().find(node => node.props['aria-label'] === `${MESSAGES.en.common.delete}: Example connection`)!);
        click(h.draw().find(node => node.type === 'button' && node.props.className === 'button small danger')!);
      }
      expect(method).toHaveBeenCalledOnce();
      if (identity === 'unmount') h.stop();
      else {
        if (identity === 'host' || identity === 'ABA') props.agents = { ...agents };
        else if (identity === 'profile') props.state = { ...original, profile: { ...original.profile, id: 'other' } };
        else props.state = { ...original, dataDirectory: '/data/other' };
        h.draw();
        if (identity === 'ABA') {
          props.agents = agents; h.draw();
          if (action === 'save') {
            click(h.draw().find(node => node.type === 'button')!); changeDraft(h.draw()); submit(h.draw());
          } else {
            click(h.draw().find(node => node.props['aria-label'] === `${MESSAGES.en.common.delete}: Example connection`)!);
            click(h.draw().find(node => node.type === 'button' && node.props.className === 'button small danger')!);
          }
          expect(method).toHaveBeenCalledTimes(2);
        }
      }
      pending.resolve({ ...original, dataDirectory: '/data/retired-result' }); await flush();
      expect(props.onState).not.toHaveBeenCalled();
      if (identity === 'ABA') {
        expect(h.draw().find(node => action === 'save' ? node.type === 'fieldset' : node.props.className === 'button small danger')!.props.disabled).toBe(true);
        nextPending.resolve(original); await flush();
        expect(props.onState).toHaveBeenCalledExactlyOnceWith(original);
      } else if (identity !== 'unmount') expect(h.draw().some(node => node.type === ConnectionForm)).toBe(false);
      h.stop();
    }
  });

  it('blocks saved add/edit/cancel callbacks during a pending delete and ignores retired failures', async () => {
    const pending = deferred<HostState>(), state = baseState();
    state.connections = ['one', 'two'].map(id => ({ ...toConnectionInput(validDraft()).input, id, name: id, credentialStatus: 'ok', createdAt: '', updatedAt: '' } as HostState['connections'][number]));
    const props = { t: MESSAGES.en, agents: { deleteConnection: vi.fn(() => pending.promise) } as unknown as AgentHostApi, state, onState: vi.fn() };
    const h = harness(props), initial = h.draw();
    const add = initial.find(node => node.type === 'button')!;
    const edit = initial.find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(MESSAGES.en.common.edit))!;
    click(initial.find(node => node.props['aria-label'] === `${MESSAGES.en.common.delete}: one`)!);
    const cancel = h.draw().find(node => node.type === 'button' && node.props.children === MESSAGES.en.common.cancel)!;
    click(h.draw().find(node => node.type === 'button' && node.props.className === 'button small danger')!);
    click(add); click(edit); click(cancel);
    expect(h.draw().some(node => node.type === ConnectionForm)).toBe(false);
    expect(h.draw().find(node => node.props.role === 'alertdialog')).toBeDefined();
    expect(h.draw().filter(node => node.type === 'button').every(node => node.props.disabled === true)).toBe(true);
    props.agents = { ...props.agents }; h.draw();
    pending.reject(new Error('Retired delete failure')); await flush();
    expect(props.onState).not.toHaveBeenCalled();
    expect(h.draw().some(node => node.props.role === 'alert')).toBe(false);
  });
});
