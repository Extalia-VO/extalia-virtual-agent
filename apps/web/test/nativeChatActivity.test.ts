import type { AgentTeam } from '@extalia/core';
import { PROTOCOL_VERSION, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import type * as React from 'react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeChatActivity, nativeMessageItems } from '../src/chat/NativeChatActivity';
import { SkillLoadCard } from '../src/chat/SkillLoadCard';
import { TranscriptView } from '../src/chat/TranscriptView';
import { projectTranscript, type SkillLoadItem, type TranscriptItem, type WorkerItem } from '../src/chat/transcript';
import { MESSAGES } from '../src/i18n';
import { ObservedSubagentList, ObservedSubagentPreview } from '../src/observe/ObservedSubagents';

const hooks = vi.hoisted(() => ({ receiptLimit: 8 }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => typeof initial === 'number'
    ? [hooks.receiptLimit, (update: (prior: number) => number) => { hooks.receiptLimit = update(hooks.receiptLimit); }]
    : [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
  useId: () => 'native-activity-test',
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock('../src/observe/useObserveScroll', () => ({ useObserveScroll: vi.fn() }));

type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : [];
const receipt = (id: string, owner: SkillLoadItem['owner'] = 'primary'): SkillLoadItem => ({ kind: 'skills', id, owner,
  agentLabel: owner === 'worker' ? 'Reviewer' : undefined, characters: 100, budgetCharacters: 1_000,
  skills: [{ name: id, source: 'builtin', reason: 'current-context', status: 'loaded', characters: 100 }] });
const worker = (id: string, extra: Partial<WorkerItem> = {}): WorkerItem => ({ kind: 'worker', id,
  subagentId: `${id}-agent`, label: id, state: 'working', status: 'running', toolCalls: 1, ...extra });
const answer = (id: string, text: string): TranscriptItem => ({ kind: 'assistant', id, text, streaming: false });
const activity = (items: readonly TranscriptItem[], extra: Partial<Parameters<typeof NativeChatActivity>[0]> = {}) => ({
  t: MESSAGES.en, language: 'en', items, onOpenWorker: vi.fn(), ...extra,
});
const render = (props: Parameters<typeof NativeChatActivity>[0]) => renderToStaticMarkup(createElement(NativeChatActivity, props));

beforeEach(() => { hooks.receiptLimit = 8; });

describe('Native Chat activity inspector', () => {
  it('filters preparation receipts recursively while preserving the original history and worker metadata', () => {
    const nested = worker('nested', { preview: [receipt('nested-skill', 'worker'), answer('nested-answer', 'Nested result')] });
    const parent = worker('parent', { task: 'Recorded assignment', preview: [receipt('worker-skill', 'worker'), nested, answer('worker-answer', 'Recorded result')] });
    const items = [receipt('lead-skill'), answer('lead-answer', 'Lead reply'), parent];
    const before = structuredClone(items);
    Object.freeze(items); Object.freeze(parent.preview); Object.freeze(nested.preview); Object.freeze(parent); Object.freeze(nested);
    const filtered = nativeMessageItems(items);
    expect(items).toEqual(before);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(items[1]);
    const copy = filtered[1] as WorkerItem;
    expect(copy).not.toBe(parent);
    expect(copy.task).toBe('Recorded assignment');
    expect(copy.preview?.map(item => item.kind)).toEqual(['worker', 'assistant']);
    expect((copy.preview?.[0] as WorkerItem).preview).toEqual([answer('nested-answer', 'Nested result')]);
    expect(nativeMessageItems(items)).toEqual(filtered);
  });

  it('handles deeply nested worker history and reference cycles without changing source arrays', () => {
    const first = worker('first');
    let last = first;
    for (let index = 0; index < 2_000; index++) {
      const next = worker(`child-${index}`, { preview: [receipt(`skill-${index}`, 'worker')] });
      last.preview = [next]; last = next;
    }
    last.preview!.push(first);
    const filtered = nativeMessageItems([first]);
    let current = filtered[0] as WorkerItem;
    for (let index = 0; index < 2_000; index++) current = current.preview![0] as WorkerItem;
    expect(current.preview).toEqual([filtered[0]]);
    expect(last.preview?.[0]?.kind).toBe('skills');
  });

  it.each(['en', 'id'] as const)('relocates lead and nested worker skills into the collapsed sidebar disclosure (%s)', language => {
    const t = MESSAGES[language];
    const nested = worker('nested', { preview: [receipt('nested-skill', 'worker'), answer('nested-answer', 'Nested result')] });
    const parent = worker('parent', { task: 'Recorded assignment', preview: [receipt('worker-skill', 'worker'), nested, answer('worker-answer', 'Recorded result')] });
    const items = [receipt('lead-skill'), answer('lead-answer', 'Lead reply'), parent];
    const props = activity(items, { t, language, selectedWorkerId: parent.id });
    const tree = nodes(NativeChatActivity(props));
    const disclosure = tree.find(node => node.props.className === 'native-chat-skills')!;
    expect(disclosure.type).toBe('details');
    expect(disclosure.props.open).toBeUndefined();
    expect(nodes(disclosure).filter(node => node.type === SkillLoadCard).map(node => (node.props.item as SkillLoadItem).id)).toEqual(['lead-skill', 'worker-skill', 'nested-skill']);
    const preview = tree.find(node => node.type === ObservedSubagentPreview)!;
    expect((preview.props.worker as WorkerItem).preview?.some(item => item.kind === 'skills')).toBe(false);
    const html = render(props);
    for (const text of ['lead-skill', 'worker-skill', 'nested-skill', 'Recorded result', 'Recorded assignment', t.observer.delegatedBy('parent'), t.chat.skillLoading.title]) expect(html).toContain(text);
    const messages = renderToStaticMarkup(createElement(TranscriptView, { t, language, items: nativeMessageItems(items), onDecide: vi.fn(), onOpenWorker: vi.fn() }));
    expect(messages).toContain('Lead reply');
    expect(messages).not.toContain('skill-load-card');
    expect(messages).not.toContain('lead-skill');
  });

  it('keeps waiting live work before closed finished/error history and opens the exact nested invocation', () => {
    const nested = worker('nested', { state: 'waiting', task: 'Waiting for source evidence', preview: [answer('actual', 'Actual worker message')] });
    const history = worker('finished', { status: 'ok', state: 'idle', preview: [nested] });
    const failed = worker('failed', { status: 'failed', state: 'blocked', summary: 'Recorded worker failure' });
    const stopped = worker('stopped', { status: 'stopped', state: 'idle' });
    const props = activity([history, failed, stopped], { selectedWorkerId: nested.id });
    const tree = nodes(NativeChatActivity(props));
    const list = tree.find(node => node.type === ObservedSubagentList)!;
    const rows = list.props.rows as { worker: WorkerItem; depth: number; parentLabel?: string }[];
    expect(rows.map(row => [row.worker.id, row.depth])).toEqual([['finished', 0], ['nested', 1], ['failed', 0], ['stopped', 0]]);
    expect(list.props.onOpenWorker).toBe(props.onOpenWorker);
    const preview = tree.find(node => node.type === ObservedSubagentPreview)!;
    expect((preview.props.worker as WorkerItem).id).toBe('nested');
    const html = render(props);
    expect(html.indexOf('Waiting for source evidence')).toBeLessThan(html.indexOf('observe-subagents-finished'));
    expect(html).toContain('<details class="observe-subagents-finished">');
    expect(html).toContain('Recorded worker failure');
    expect(html).toContain('Actual worker message');
    expect(html).toContain(MESSAGES.en.tool.status.failed);
    expect(html).toContain(MESSAGES.en.tool.status.stopped);
  });

  it('uses actual preview messages and retains passive approval and attachment rendering', () => {
    const child = worker('child', { task: 'Actual assigned task', preview: [receipt('worker-skill', 'worker'), answer('reply', 'Actual child reply'),
      { kind: 'approval', id: 'approval', approvalId: 'request', status: 'pending', action: 'Recorded action' }] });
    const previewAttachment = vi.fn(async () => undefined);
    const props = activity([child], { selectedWorkerId: child.id, previewAttachment });
    const preview = nodes(NativeChatActivity(props)).find(node => node.type === ObservedSubagentPreview)!;
    expect(preview.props.previewAttachment).toBe(previewAttachment);
    const html = render(props);
    expect(html).toContain('Actual assigned task');
    expect(html).toContain('Actual child reply');
    expect(html).toContain('Recorded action');
    expect(html).not.toContain('approval-options');
    expect(html).not.toContain('<textarea');
    expect(render(activity([worker('empty', { task: 'Assigned only' })], { selectedWorkerId: 'empty' }))).toContain(MESSAGES.en.observer.subagentNotReported);
  });

  it('bounds initial receipt history and reveals retained older receipts on demand', () => {
    const props = activity(Array.from({ length: 19 }, (_, index) => receipt(`receipt-${index}`)));
    let tree = nodes(NativeChatActivity(props));
    expect(tree.filter(node => node.type === SkillLoadCard).map(node => (node.props.item as SkillLoadItem).id)).toEqual(Array.from({ length: 8 }, (_, index) => `receipt-${index + 11}`));
    const button = tree.find(node => node.type === 'button')!;
    expect(button.props.children).toBe(MESSAGES.en.chat.showMore);
    (button.props.onClick as () => void)();
    tree = nodes(NativeChatActivity(props));
    expect(tree.filter(node => node.type === SkillLoadCard)).toHaveLength(16);
    (tree.find(node => node.type === 'button')!.props.onClick as () => void)();
    tree = nodes(NativeChatActivity(props));
    expect(tree.filter(node => node.type === SkillLoadCard)).toHaveLength(19);
    expect(tree.some(node => node.type === 'button')).toBe(false);
  });

  it('shows one attributed receipt per source event when real projection repeats it in a worker preview', () => {
    let sequence = 0;
    const event = (body: EventBody, agentId = 'primary'): ExtaliaEvent => ({ v: PROTOCOL_VERSION,
      id: `event-${++sequence}`, sessionId: 'example-session', agentId, source: { runtime: 'native', channel: 'system' },
      at: '2026-11-16T00:00:00.000Z', body });
    const report = receipt('prepared');
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'Review', via: 'extalia' }),
      event({ type: 'subagent.spawned', subagentId: 'reviewer', role: 'review', label: 'Reviewer' }),
      event({ type: 'skills.loaded', skills: report.skills, characters: report.characters, budgetCharacters: report.budgetCharacters }, 'reviewer'),
    ]);
    const parentReceipt = items.find(item => item.kind === 'skills') as SkillLoadItem;
    const child = items.find(item => item.kind === 'worker') as WorkerItem;
    const previewReceipt = child.preview!.find(item => item.kind === 'skills')!;
    expect(previewReceipt.id).toBe(parentReceipt.id);
    expect(previewReceipt).not.toBe(parentReceipt);
    const cards = nodes(NativeChatActivity(activity(items))).filter(node => node.type === SkillLoadCard);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props.item).toBe(parentReceipt);
    expect(cards[0]!.props.item).toMatchObject({ owner: 'worker', agentId: 'reviewer', agentLabel: 'Reviewer' });
    expect(parentReceipt.skills).toEqual(report.skills);
    expect(child.preview).toContain(previewReceipt);
  });

  it.each(['en', 'id'] as const)('shows an inactive saved roster with configured fields and no fabricated work state (%s)', language => {
    const t = MESSAGES[language];
    const team: AgentTeam = { enabled: false, allowedModels: [], goal: 'Review saved project', members: [
      { id: 'saved', name: 'Saved reviewer', role: 'Code review', task: 'Inspect changed files', models: ['preferred-model', 'fallback-model'] },
    ] };
    const html = render(activity([], { t, language, team }));
    for (const text of [t.chat.team.inactive, 'Saved reviewer', 'Code review', 'Inspect changed files', 'preferred-model', 'fallback-model', 'Review saved project']) expect(html).toContain(text);
    expect(html).not.toContain('tool-status');
    expect(html).not.toContain('observe-subagents-working');
    expect(html).not.toContain('<button');
    expect(html).toContain('<details class="native-chat-roster">');
    expect(NativeChatActivity(activity([]))).toBeNull();
    expect(NativeChatActivity(activity([], { team: { ...team, members: [] } }))).toBeNull();
  });
});
