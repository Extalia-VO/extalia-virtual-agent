import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../src/chat/ChatPage';
import { Composer } from '../src/chat/Composer';
import { NativeChatActivity } from '../src/chat/NativeChatActivity';
import { TranscriptView } from '../src/chat/TranscriptView';
import { ProjectSkillsNotice } from '../src/skills/ProjectSkills';
import { MESSAGES } from '../src/i18n';
import type { TranscriptItem, WorkerItem } from '../src/chat/transcript';

const feed = vi.hoisted(() => ({ events: [] as ExtaliaEvent[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(), useRef: (initial: unknown) => ({ current: initial }),
  useId: () => 'chat-inspector', useEffect: () => undefined, useLayoutEffect: () => undefined,
}));
vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: feed.events, loading: false, error: null }) }));
vi.mock('../src/chat/chatTeam', () => ({ useChatTeam: () => ({ supported: false, isUpdating: () => false }) }));
const nodes = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
const at = '2026-01-01T00:00:00Z';
const event = (id: string, body: EventBody, agentId = 'primary') => createEvent({ id, at, sessionId: 'session', agentId, source: { runtime: 'extalia-native', channel: 'stream' }, body });
const state: HostState = { setupComplete: true, profile: { id: 'profile', name: 'Example' }, connections: [],
  workspaces: [{ id: 'workspace', profileId: 'profile', name: 'Example', projectLocation: '/projects/example', createdAt: at, updatedAt: at }],
  sessions: [{ id: 'session', workspaceId: 'workspace', connectionId: 'connection', title: 'Example work', control: 'managed', running: true, createdAt: at, lastActiveAt: at }],
  library: [], dataDirectory: '/example/data', storage: { dataDirectory: '/example/data', secretStore: 'memory' }, host: { kind: 'bridge', version: 'test' } };
function render(control: 'managed' | 'observed' = 'managed') {
  const resolveApproval = vi.fn(async () => undefined), agents = { resolveApproval } as unknown as AgentHostApi;
  const props: Parameters<typeof ChatPage>[0] = { t: MESSAGES.en, language: 'en', state: { ...state, sessions: state.sessions.map(session => ({ ...session, control })) }, agents,
    selection: { workspaceId: 'workspace', sessionId: 'session' }, onState: vi.fn(), onSelect: vi.fn(), onOpenSettings: vi.fn(), onReviewSkills: vi.fn() };
  return { all: nodes(ChatPage(props)), resolveApproval };
}

describe('Native Chat inspector integration', () => {
  it('separates host skill receipts from messages and sends delegated invocations to the same inspector action', () => {
    feed.events = [event('prompt', { type: 'prompt.submitted', via: 'extalia', text: 'Review the project' }),
      event('skill', { type: 'skills.loaded', skills: [], characters: 0, budgetCharacters: 100 }),
      event('spawn', { type: 'subagent.spawned', subagentId: 'reviewer', label: 'Reviewer' }),
      event('worker-text', { type: 'model.delta', text: 'Worker evidence' }, 'reviewer'),
      event('approval', { type: 'approval.requested', approvalId: 'approve', action: 'Save evidence' })];
    const before = structuredClone(feed.events), { all } = render();
    const conversation = all.find(node => node.props.className === 'chat-conversation')!;
    const inspector = all.find(node => node.props.className === 'chat-context-rail')!;
    const transcript = nodes(conversation).find(node => node.type === TranscriptView)!;
    const activity = nodes(inspector).find(node => node.type === NativeChatActivity)!;
    expect(activity.props.events).toBe(feed.events);
    expect(activity.props.sessionId).toBe('session');
    expect(activity.props.scopeKey).toContain('workspace');
    const messages = transcript.props.items as TranscriptItem[], history = activity.props.items as TranscriptItem[];
    expect(messages.some(item => item.kind === 'skills')).toBe(false);
    expect(history.some(item => item.kind === 'skills')).toBe(true);
    expect((messages.find(item => item.kind === 'worker') as WorkerItem).preview).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Worker evidence' })]));
    expect(transcript.props.onOpenWorker).toBe(activity.props.onOpenWorker);
    expect(nodes(conversation).some(node => node.type === ProjectSkillsNotice)).toBe(false);
    expect(nodes(inspector).filter(node => node.type === ProjectSkillsNotice)).toHaveLength(1);
    expect(nodes(conversation).filter(node => node.type === Composer)).toHaveLength(1);
    expect(nodes(inspector).some(node => node.type === Composer)).toBe(false);
    expect(feed.events).toEqual(before);
  });

  it('keeps Native approval actions on the main conversation and preserves observed read-only behavior', async () => {
    feed.events = [event('approval', { type: 'approval.requested', approvalId: 'approve', action: 'Save evidence' })];
    const managed = render(), main = managed.all.find(node => node.type === TranscriptView)!;
    expect(main.props.approvalsEnabled).toBe(true);
    await (main.props.onDecide as (id: string, choice: string) => Promise<boolean>)('approve', 'once');
    expect(managed.resolveApproval).toHaveBeenCalledExactlyOnceWith('session', 'approve', 'once');
    const observed = render('observed'), passive = observed.all.find(node => node.type === TranscriptView)!;
    expect(passive.props.approvalsEnabled).toBe(false);
    expect(await (passive.props.onDecide as (id: string, choice: string) => Promise<boolean>)('approve', 'once')).toBe(false);
    expect(observed.resolveApproval).not.toHaveBeenCalled();
  });
});
