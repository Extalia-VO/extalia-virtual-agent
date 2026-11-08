import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentHostApi } from '@extalia/platform';
import { Composer } from '../src/chat/Composer';
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
const change = (node: ReactElement<Record<string, unknown>>, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });

function harness(language: 'en' | 'id' = 'en') {
  const agents = { modelChoices: vi.fn(async () => ({ models: [], efforts: [] })), setSessionOptions: vi.fn(async () => undefined), uploadAttachment: vi.fn() } as unknown as AgentHostApi;
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


function paste(h: ReturnType<typeof harness>, incoming: string, start = 0, end = start) {
  const area = elements(h.render()).find(item => item.type === 'textarea')!;
  const preventDefault = vi.fn();
  (area.props.onPaste as (event: unknown) => void)({ preventDefault, currentTarget: { selectionStart: start, selectionEnd: end }, clipboardData: { files: [], getData: () => incoming } });
  return preventDefault;
}
const inputValue = (h: ReturnType<typeof harness>) => elements(h.render()).find(item => item.type === 'textarea')!.props.value;

it('leaves short paste and the exact threshold in the textarea native path', () => {
  const h = harness();
  expect(paste(h, 'a'.repeat(8000))).not.toHaveBeenCalled();
  expect(h.props.onSend).not.toHaveBeenCalled();
});

it.each(['en', 'id'] as const)('imports full selected draft as UTF-8 text with an explicit request in %s', async language => {
  const h = harness(language);
  h.type('beforeOLDafter');
  const incoming = 'こんにちは🌟\n'.repeat(2000);
  expect(paste(h, incoming, 6, 9)).toHaveBeenCalledOnce();
  expect(inputValue(h)).toBe('');
  expect(text(h.render())).toContain(MESSAGES[language].composer.longTextAttached);
  h.submit();
  const request = vi.mocked(h.props.onSend).mock.calls[0]![0];
  expect(await request.attachments[0]!.file.text()).toBe('before' + incoming + 'after');
  expect(request.text).toBe(MESSAGES[language].composer.longTextPrompt(request.attachments[0]!.name));
});

it('preserves every Unicode character across multiple file boundaries', async () => {
  const h = harness();
  const incoming = 'a'.repeat(99999) + '🌟' + 'z'.repeat(120000);
  paste(h, incoming); h.submit();
  const request = vi.mocked(h.props.onSend).mock.calls[0]![0];
  expect(request.attachments).toHaveLength(3);
  expect((await Promise.all(request.attachments.map(chip => chip.file.text()))).join('')).toBe(incoming);
});

it('retains text and blocks send when no complete import fits', () => {
  const h = harness();
  const incoming = 'x'.repeat(400001);
  paste(h, incoming);
  expect(inputValue(h)).toBe(incoming);
  h.submit(); expect(h.props.onSend).not.toHaveBeenCalled();
  expect(text(h.render())).toContain(MESSAGES.en.composer.longTextFailed);
});

it('keeps imported chips and does not duplicate the generated directive on retry', async () => {
  const h = harness();
  vi.mocked(h.props.onSend).mockResolvedValue(false);
  paste(h, 'x'.repeat(8001));
  h.submit(); await new Promise(resolve => setTimeout(resolve, 0));
  h.submit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(vi.mocked(h.props.onSend).mock.calls).toHaveLength(2);
  const first = vi.mocked(h.props.onSend).mock.calls[0]![0];
  const second = vi.mocked(h.props.onSend).mock.calls[1]![0];
  expect(first.text).toBe(second.text);
  expect(first.attachments[0]!.key).toBe(second.attachments[0]!.key);
});

it('retains oversized paste when the host does not support attachments', () => {
  const h = harness();
  delete (h.props.agents as Partial<AgentHostApi>).uploadAttachment;
  const incoming = 'x'.repeat(100001);
  paste(h, incoming);
  expect(inputValue(h)).toBe(incoming);
  h.submit(); expect(h.props.onSend).not.toHaveBeenCalled();
});

it('validates the generated directive and typed text together before uploading', () => {
  const h = harness();
  paste(h, 'x'.repeat(8001));
  h.type('y'.repeat(100000));
  h.submit();
  expect(h.props.onSend).not.toHaveBeenCalled();
  expect(text(h.render())).toContain(MESSAGES.en.composer.longTextFailed);
});

it('reuses local files but drops old session upload ids on navigation', async () => {
  const h = harness();
  vi.mocked(h.props.onSend).mockImplementation(async request => {
    request.patch(request.attachments[0]!.key, { status: 'uploading', attachmentId: 'old-session-id' });
    return false;
  });
  paste(h, 'x'.repeat(8001));
  h.submit(); await new Promise(resolve => setTimeout(resolve, 0));
  h.props.workspaceId = 'other-workspace';
  h.render();
  h.submit(); await new Promise(resolve => setTimeout(resolve, 0));
  const latest = vi.mocked(h.props.onSend).mock.calls.at(-1)![0];
  expect(vi.mocked(h.props.onSend).mock.calls).toHaveLength(2);
  expect(latest.attachments[0]!.status).toBe('ready');
  expect(latest.attachments[0]!.attachmentId).toBeUndefined();
});
