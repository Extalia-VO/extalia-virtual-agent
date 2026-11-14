import type * as React from 'react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalMessageFileScope } from '../src/chat/MessageFilePreview';
import { TranscriptView } from '../src/chat/TranscriptView';
import type { TranscriptItem, WorkerItem } from '../src/chat/transcript';
import { MESSAGES } from '../src/i18n';

// Exercise the owning transcript's handlers and state across fresh protocol projections.
const hooks = vi.hoisted(() => ({ index: 0, states: [] as unknown[], ids: 0 }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.states[index] ??= { current: initial }; },
  useId: () => `worker-preview-test-${hooks.ids++}`,
}));

type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : [];
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : isValidElement<{ children?: ReactNode }>(value) ? text(value.props.children) : '';
const invoke = (node: Element) => (node.type as (props: Record<string, unknown>) => ReactNode)(node.props);
const worker = (overrides: Partial<WorkerItem> = {}): WorkerItem => ({ kind: 'worker', id: 'worker-invocation', subagentId: 'reviewer', label: 'Reviewer', tier: 'quick', state: 'working', status: 'running', toolCalls: 1, task: 'Review the source', activity: 'Reading source', ...overrides });

function harness(language: 'en' | 'id' = 'en', initial = worker()) {
  const onDecide = vi.fn(async () => undefined);
  const props: Parameters<typeof TranscriptView>[0] = { t: MESSAGES[language], language, items: [initial], approvalsEnabled: true, onDecide };
  const draw = (id = initial.id) => {
    hooks.index = 0;
    const transcript = TranscriptView(props);
    const runs = nodes(transcript).filter(node => typeof node.type === 'function' && 'onSetOpenKeys' in node.props && 'language' in node.props);
    for (const run of runs) {
      const runTree = invoke(run);
      const card = nodes(runTree).find(node => (node.props.item as WorkerItem | undefined)?.id === id);
      if (card) return { tree: invoke(card), scope: nodes(runTree).find(node => node.type === HistoricalMessageFileScope) };
    }
    throw new Error(`Missing worker ${id}`);
  };
  const toggle = (id?: string) => nodes(draw(id).tree).find(node => node.type === 'button' && node.props.className === 'worker-preview-toggle')!;
  const click = (id?: string) => (toggle(id).props.onClick as () => void)();
  return { props, draw, toggle, click, onDecide };
}

beforeEach(() => { hooks.index = 0; hooks.states = []; hooks.ids = 0; });

describe('worker transcript previews', () => {
  it.each(['en', 'id'] as const)('opens an accessible localized preview and keeps assignment and live summary visible (%s)', language => {
    const h = harness(language), t = MESSAGES[language];
    expect(h.toggle().props).toMatchObject({ type: 'button', 'aria-expanded': false, title: t.tool.showWorkerPreview });
    expect(text(h.draw().tree)).toContain('Review the source');
    expect(text(h.draw().tree)).toContain('Reading source');
    expect(text(h.draw().tree)).toContain(t.tool.workerAssignment);
    expect(nodes(h.draw().tree).some(node => node.props.className === 'worker-preview')).toBe(false);
    h.click();
    const { tree } = h.draw();
    const button = nodes(tree).find(node => node.type === 'button')!;
    const region = nodes(tree).find(node => node.type === 'section')!;
    expect(button.props).toMatchObject({ 'aria-expanded': true, 'aria-controls': region.props.id, title: t.tool.hideWorkerPreview });
    expect(region.props['aria-label']).toBe(t.tool.workerPreview('Reviewer'));
    expect(text(tree)).toContain(t.tool.workerReadOnly);
    expect(text(tree)).toContain(t.tool.workerPreviewEmpty);
    expect(nodes(tree).find(node => node.props.className === 'worker-preview-scroll')?.props).toMatchObject({ role: 'region', tabIndex: 0 });
    h.click();
    expect(h.toggle().props['aria-expanded']).toBe(false);
  });

  it('preserves each worker choice through status, summary and run-boundary updates', () => {
    const h = harness();
    h.click();
    h.props.items = [worker({ id: 'earlier-worker', subagentId: 'earlier', label: 'Earlier' }), worker({ status: 'ok', state: 'idle', summary: 'Review complete', preview: [{ kind: 'assistant', id: 'answer', text: 'Recorded answer', streaming: false }] })];
    expect(h.toggle().props['aria-expanded']).toBe(true);
    expect(h.toggle('earlier-worker').props['aria-expanded']).toBe(false);
    h.props.items = [h.props.items[0]!, { kind: 'assistant', id: 'lead-update', text: 'Lead update', streaming: true }, h.props.items[1]!];
    expect(h.toggle().props['aria-expanded']).toBe(true);
    expect(text(h.draw().tree)).toContain('Review complete');
    h.click();
    h.props.items = [worker({ activity: 'Reading another file' })];
    expect(h.toggle().props['aria-expanded']).toBe(false);
    // A fresh invocation for the same agent does not inherit the earlier invocation's choice.
    h.click(); h.props.items = [worker({ id: 'new-invocation' })];
    expect(h.toggle('new-invocation').props['aria-expanded']).toBe(false);
  });

  it('shows an assignment only once when the initial progress summary repeats it', () => {
    const h = harness('en', worker({ activity: 'Review the source' }));
    expect(text(h.draw().tree).split('Review the source')).toHaveLength(2);
    expect(nodes(h.draw().tree).some(node => node.props.className === 'worker-detail')).toBe(false);
  });

  it('renders actual worker records through the shared transcript with no parent approval action', async () => {
    const preview: TranscriptItem[] = [
      { kind: 'assistant', id: 'answer', text: 'Recorded worker finding', streaming: false },
      { kind: 'tool', id: 'read', callId: 'read-call', tool: 'read_file', activity: 'read', label: 'Read source', status: 'ok', output: 'Actual file contents', files: [{ path: 'src/example.ts', change: 'update' }] },
      { kind: 'tool', id: 'command', callId: 'command-call', tool: 'command', activity: 'command', label: 'Run verification', status: 'ok', files: [], command: { command: 'pnpm test', output: [{ stream: 'stdout', text: 'Recorded command output' }], exitCode: 0 } },
      { kind: 'usage', id: 'usage', usage: { inputTokens: 120, outputTokens: 35 }, model: 'example-model' },
      { kind: 'notice', id: 'notice', reason: 'agent-error', text: 'Recorded worker error' },
      { kind: 'approval', id: 'approval', approvalId: 'child-approval', action: 'Child action', status: 'pending' },
    ];
    const h = harness('en', worker({ preview })); h.click();
    const nested = nodes(h.draw().tree).find(node => node.type === TranscriptView)!;
    expect(nested.props.items).toBe(preview);
    expect(nested.props.approvalsEnabled).toBe(false);
    expect(nested.props.onDecide).not.toBe(h.onDecide);
    await (nested.props.onDecide as () => Promise<void>)();
    expect(h.onDecide).not.toHaveBeenCalled();
    hooks.index = 0; hooks.states = [new Map([['read-call', true], ['row:read-call', true], ['row:command-call', true]])];
    const html = renderToStaticMarkup(createElement(TranscriptView, nested.props as Parameters<typeof TranscriptView>[0]));
    for (const recorded of ['Recorded worker finding', 'Actual file contents', 'src/example.ts', 'pnpm test', 'Recorded command output', '120 in · 35 out', 'example-model', 'Recorded worker error', 'Child action']) expect(html).toContain(recorded);
    expect(html).not.toContain('approval-option');
    expect(html).not.toContain(MESSAGES.en.tool.workerPreviewEmpty);
  });

  it('retains historical file scope and the session attachment loader around the nested transcript', () => {
    const scope = { workspaceId: 'historical-workspace', projectLocation: '/project/history' };
    const preview: TranscriptItem[] = [{ kind: 'assistant', id: 'record', text: 'See src/example.ts', streaming: false, fileScope: null }];
    const h = harness('en', worker({ preview }));
    h.props.items[0]!.fileScope = scope;
    h.props.previewAttachment = vi.fn(async () => undefined);
    h.click();
    const { tree, scope: wrapper } = h.draw();
    expect(wrapper?.props.scope).toBe(scope);
    const nested = nodes(tree).find(node => node.type === TranscriptView)!;
    expect(nested.props.previewAttachment).toBe(h.props.previewAttachment);
    expect((nested.props.items as TranscriptItem[])[0]!.fileScope).toBeNull();
  });
});
