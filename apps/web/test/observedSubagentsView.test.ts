import type * as React from 'react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HistoricalMessageFileScope } from '../src/chat/MessageFilePreview';
import { MessageAttachments } from '../src/chat/MessageAttachments';
import { TranscriptView } from '../src/chat/TranscriptView';
import type { TranscriptItem } from '../src/chat/transcript';
import { ObservedSubagentList, ObservedSubagentPreview, observedSubagentRows } from '../src/observe/ObservedSubagents';
import { MESSAGES } from '../src/i18n';

// Inspect component callbacks without mounting an application host or enabling child actions.
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useId: () => 'observed-child-preview',
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock('../src/observe/useObserveScroll', () => ({ useObserveScroll: vi.fn() }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : [];
const invoke = (node: Element) => (node.type as (props: Record<string, unknown>) => ReactNode)(node.props);
const worker = (overrides: Partial<Extract<TranscriptItem, { kind: 'worker' }>> = {}): Extract<TranscriptItem, { kind: 'worker' }> => ({ kind: 'worker', id: 'child-invocation', subagentId: 'reviewer', label: 'Reviewer', state: 'working', status: 'running', toolCalls: 1, activity: 'Reading source', ...overrides });

function delegationCard(props: Parameters<typeof TranscriptView>[0]) {
  const run = nodes(TranscriptView(props)).find(node => typeof node.type === 'function' && 'onSetOpenKeys' in node.props && 'language' in node.props)!;
  // This test targets worker routing after the user opens its enclosing group.
  const openedRun = { ...run, props: { ...run.props, openStates: new Map((run.props.items as TranscriptItem[]).map(item => [`worker-group:${item.id}`, true])) } };
  const card = nodes(invoke(openedRun)).find(node => 'item' in node.props && 'onOpenWorker' in node.props)!;
  return invoke(card);
}

describe('observed subagent inspector', () => {
  it('lists authentic workers and nested lineage without inferring children from tool names', () => {
    const nested = worker({ id: 'nested', subagentId: 'nested-reviewer', label: 'Nested reviewer' });
    const parent = worker({ preview: [nested] });
    const tool: TranscriptItem = { kind: 'tool', id: 'delegate-looking-tool', callId: 'tool', tool: 'delegate_task', activity: 'tool', label: 'Worker tool', status: 'ok', files: [] };
    expect(observedSubagentRows([tool, parent])).toEqual([{ worker: parent, depth: 0, parentLabel: undefined }, { worker: nested, depth: 1, parentLabel: 'Reviewer' }]);
    expect(observedSubagentRows([tool])).toEqual([]);
  });

  it('traverses deep nested recordings iteratively and safely ignores reference cycles', () => {
    const first = worker({ id: '0' });
    let last = first;
    for (let index = 1; index < 2_000; index++) { const child = worker({ id: String(index) }); last.preview = [child]; last = child; }
    last.preview = [first];
    const rows = observedSubagentRows([first]);
    expect(rows).toHaveLength(2_000);
    expect(rows.at(-1)).toMatchObject({ worker: { id: '1999' }, depth: 1999 });
  });

  it.each(['en', 'id'] as const)('renders localized roster status, parent and latest activity, and selects the exact invocation (%s)', language => {
    const t = MESSAGES[language], selected = worker({ id: 'second-invocation', status: 'ok', summary: 'Recorded finding' });
    const onOpenWorker = vi.fn();
    const props = { t, rows: [{ worker: selected, depth: 1, parentLabel: 'Lead reviewer' }], selectedWorkerId: selected.id, onOpenWorker };
    const tree = ObservedSubagentList(props)!;
    const button = nodes(tree).find(node => node.type === 'button')!;
    expect(button.props['aria-pressed']).toBe(true);
    (button.props.onClick as () => void)();
    expect(onOpenWorker).toHaveBeenCalledExactlyOnceWith(selected);
    const html = renderToStaticMarkup(createElement(ObservedSubagentList, props));
    for (const label of [t.observer.subagents, t.tool.status.ok, t.observer.delegatedBy('Lead reviewer'), 'Recorded finding']) expect(html).toContain(label);
    expect(ObservedSubagentList({ ...props, rows: [] })).toBeNull();
  });

  it.each(['en', 'id'] as const)('puts working children first and keeps all terminal statuses in a closed history group (%s)', language => {
    const t = MESSAGES[language];
    const rows = [
      worker({ id: 'done', label: 'Finished reviewer', status: 'ok' }),
      worker({ id: 'active', label: 'Active researcher' }),
      worker({ id: 'failed', label: 'Failed checker', status: 'failed' }),
      worker({ id: 'stopped', label: 'Stopped checker', status: 'stopped' }),
      worker({ id: 'nested', label: 'Active nested checker' }),
    ].map((worker, index) => ({ worker, depth: index === 4 ? 1 : 0, parentLabel: index === 4 ? 'Finished reviewer' : undefined }));
    const tree = ObservedSubagentList({ t, rows, selectedWorkerId: 'done', onOpenWorker: vi.fn() })!;
    const all = nodes(tree), active = all.find(node => node.props.className === 'observe-subagents-working')!;
    const history = all.find(node => node.type === 'details')!;
    expect(nodes(active).filter(node => node.type === 'button').map(node => node.props['aria-pressed'])).toEqual([false, false]);
    expect(nodes(history).filter(node => node.type === 'button').map(node => node.props['aria-pressed'])).toEqual([true, false, false]);
    expect(history.props.open).toBeUndefined();
    const html = renderToStaticMarkup(createElement(ObservedSubagentList, { t, rows, onOpenWorker: vi.fn() }));
    expect(html.indexOf('Active researcher')).toBeLessThan(html.indexOf('Finished reviewer'));
    for (const label of [t.observer.subagentsWorking, t.observer.subagentsFinished, t.tool.status.failed, t.tool.status.stopped, t.observer.delegatedBy('Finished reviewer')]) expect(html).toContain(label);
  });

  it('collapses a wholly finished roster without dropping its selected preview', () => {
    const selected = worker({ status: 'ok', preview: [{ kind: 'assistant', id: 'result', text: 'Recorded completed result', streaming: false }] });
    const props = { t: MESSAGES.en, rows: [{ worker: selected, depth: 0 }], selectedWorkerId: selected.id, onOpenWorker: vi.fn() };
    const list = nodes(ObservedSubagentList(props)!);
    expect(list.some(node => node.props.className === 'observe-subagents-working')).toBe(false);
    expect(list.find(node => node.type === 'details')?.props.open).toBeUndefined();
    const html = renderToStaticMarkup(createElement(ObservedSubagentPreview, { t: MESSAGES.en, language: 'en', worker: selected, onOpenWorker: vi.fn() }));
    expect(html).toContain('Recorded completed result');
  });

  it('routes a delegation card to the inspector without an inline preview or child control', () => {
    const item = worker({ preview: [{ kind: 'assistant', id: 'actual', text: 'Actual child record', streaming: false }] });
    const onOpenWorker = vi.fn();
    const tree = delegationCard({ t: MESSAGES.en, language: 'en', items: [item], onDecide: vi.fn(), onOpenWorker, selectedWorkerId: item.id });
    const button = nodes(tree).find(node => node.type === 'button')!;
    expect(button.props['aria-pressed']).toBe(true);
    expect(button.props['aria-expanded']).toBeUndefined();
    (button.props.onClick as () => void)();
    expect(onOpenWorker).toHaveBeenCalledExactlyOnceWith(item);
    expect(nodes(tree).some(node => node.props.className === 'worker-preview')).toBe(false);
    expect(nodes(tree).some(node => node.type === MessageAttachments)).toBe(false);
    const native = delegationCard({ t: MESSAGES.en, language: 'en', items: [item], onDecide: vi.fn() });
    expect(nodes(native).find(node => node.type === 'button')?.props['aria-expanded']).toBe(false);
    expect(nodes(native).some(node => node.type === MessageAttachments)).toBe(true);
  });

  it('uses the current child records with historical file scope and disables approval decisions', async () => {
    const fileScope = { workspaceId: 'history', projectLocation: '/projects/history' };
    const item = worker({ fileScope, preview: [
      { kind: 'assistant', id: 'actual', text: 'Actual child record', streaming: false },
      { kind: 'approval', id: 'child-approval', approvalId: 'approval', action: 'Recorded child action', status: 'pending' },
    ] });
    const onOpenWorker = vi.fn(), previewAttachment = vi.fn(async () => undefined);
    const props = { t: MESSAGES.en, language: 'en', worker: item, onOpenWorker, previewAttachment };
    const tree = ObservedSubagentPreview(props);
    expect(nodes(tree).find(node => node.type === HistoricalMessageFileScope)?.props.scope).toBe(fileScope);
    expect(nodes(tree).find(node => node.type === MessageAttachments)?.props).toMatchObject({ files: item.attachments ?? [], load: previewAttachment });
    const transcript = nodes(tree).find(node => node.type === TranscriptView)!;
    expect(transcript.props).toMatchObject({ items: item.preview, approvalsEnabled: false, onOpenWorker, previewAttachment });
    await (transcript.props.onDecide as () => Promise<void>)();
    expect(onOpenWorker).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(ObservedSubagentPreview, props));
    expect(html).toContain('Actual child record');
    expect(html).toContain('Recorded child action');
    expect(html).not.toContain('approval-option');
    expect(html).not.toContain('<textarea');
    const refreshed = worker({ preview: [{ kind: 'assistant', id: 'fresh', text: 'Fresh live child output', streaming: true }] });
    const updated = nodes(ObservedSubagentPreview({ ...props, worker: refreshed })).find(node => node.type === TranscriptView)!;
    expect(updated.props.items).toBe(refreshed.preview);
  });

  it.each(['en', 'id'] as const)('shows honest source-empty state instead of treating a task or summary as child messages (%s)', language => {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(ObservedSubagentPreview, { t, language, worker: worker({ task: 'Assigned review', summary: 'Started reviewing' }), onOpenWorker: vi.fn() }));
    expect(html).toContain(t.observer.subagentNotReported);
    expect(html).toContain('Assigned review');
    expect(html).not.toContain('Started reviewing');
    expect(html).not.toContain('class="transcript"');
  });
});
