import { generateFullName } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  latestAgentModels, looksLikePersonName, observedChannel, observedSource, observedSubagentIdentity, sessionLeadModel, sessionOrigin,
} from '../src/office/agentOrigin';
import { boardRows } from '../src/office/overlay/boardTree';
import { projectOfficePresence } from '../src/office/presence';
import { lookIdentity } from '../src/office/scene/avatars/appearance';
import { addIgnoredFolder, isDefaultIgnoredFolder, missesDefaults, normalizeIgnoredFolder, readDefaultIgnoreFolders, readIgnoreFolders, removeIgnoredFolder } from '../src/pages/ignoredFolders';

type Observation = NonNullable<SessionSummary['observation']>;
function session(id: string, overrides: Partial<SessionSummary> = {}, observation?: Partial<Observation> & Record<string, unknown>): SessionSummary {
  return {
    id, workspaceId: 'ws', connectionId: '', title: id, control: observation ? 'observed' : 'managed',
    createdAt: '2026-10-09T00:00:00.000Z', lastActiveAt: '2026-10-09T00:00:00.000Z', running: false,
    ...(observation ? { observation: { sourceId: 'codex', nativeSessionId: `native-${id}`, watching: true, status: 'watching', ...observation } as Observation } : {}),
    ...overrides,
  };
}
function event(sessionId: string, n: number, body: EventBody, agentId = 'primary'): ExtaliaEvent {
  return createEvent({ id: `${sessionId}-${n}`, at: `2026-10-09T00:00:${String(n).padStart(2, '0')}.000Z`, seq: n, sessionId, agentId,
    source: { runtime: 'test', channel: 'transcript' }, body });
}

describe('agent origin (source, channel, model)', () => {
  it('normalises hook app ids and importer source ids to one brand', () => {
    expect(observedSource('claude')).toEqual({ mark: 'claude-code', label: 'Claude Code' });
    expect(observedSource('claude-code')).toEqual({ mark: 'claude-code', label: 'Claude Code' });
    expect(observedSource('gemini')).toEqual({ mark: 'gemini-cli', label: 'Gemini CLI' });
    expect(observedSource('codex')).toEqual({ mark: 'codex', label: 'Codex' });
    expect(observedSource('antigravity')).toEqual({ mark: 'antigravity', label: 'Antigravity' });
    expect(observedSource('hermes')).toEqual({ mark: 'hermes', label: 'Hermes' });
    expect(observedSource('antigravity-cli')).toEqual({ mark: 'other', label: 'Antigravity CLI' });
  });

  it('prefers the reported channel and otherwise implies it from hook/Hermes/transcript', () => {
    expect(observedChannel(session('a', {}, { channel: 'dashboard' }))).toBe('dashboard');
    expect(observedChannel(session('b', {}, { hook: true }))).toBe('hook');
    expect(observedChannel(session('c', {}, { sourceId: 'hermes' }))).toBe('dashboard');
    expect(observedChannel(session('d', {}, {}))).toBe('transcript');
    expect(observedChannel(session('e', {}, { channel: 'bogus' as never }))).toBe('transcript');
    expect(observedChannel(session('m'))).toBeUndefined();
  });

  it('names the runtime for managed sessions', () => {
    expect(sessionOrigin(session('m'))).toEqual({ mark: 'extalia-native', label: 'Extalia Native' });
    expect(sessionOrigin(session('h', { runtime: { id: 'hermes', profile: 'default' } }))).toEqual({ mark: 'hermes', label: 'Hermes' });
    expect(sessionOrigin(session('o', {}, { sourceId: 'claude-code', hook: true }))).toEqual({ mark: 'claude-code', label: 'Claude Code', channel: 'hook' });
  });

  it('reads the lead model from the summary and every agent model from events', () => {
    expect(sessionLeadModel({ ...session('o', {}, {}), model: ' gpt-5.5 ' } as SessionSummary)).toBe('gpt-5.5');
    expect(sessionLeadModel(session('o', {}, { model: 'nested-model' }))).toBe('nested-model');
    expect(sessionLeadModel(session('o', {}, {}))).toBeUndefined();
    const models = latestAgentModels([
      event('s', 1, { type: 'session.started', control: 'observed', model: 'm-1' }),
      event('s', 2, { type: 'model.completed', text: 'x', model: 'm-2' }),
      event('s', 3, { type: 'turn.completed', model: 'sub-model' }, 'child'),
      event('s', 4, { type: 'turn.completed' }),
    ]);
    expect(Object.fromEntries(models)).toEqual({ primary: 'm-2', child: 'sub-model' });
  });
});

describe('observed subagent names', () => {
  it('recognises person-like nicknames and rejects task descriptions', () => {
    for (const name of ['Carver the 2nd', 'Ada Lovelace', 'Noor', 'Ludwig van Beethoven', 'Henry III']) expect(looksLikePersonName(name)).toBe(true);
    for (const label of ['Team setup dialog UI', 'explorer', 'Fix the login test', 'UI', 'review-agent', '', 'A b', 'One Two Three Four Five']) expect(looksLikePersonName(label)).toBe(false);
  });

  it('keeps a Codex nickname and uses the role as its task line', () => {
    expect(observedSubagentIdentity({ sessionId: 's', subagentId: 'c1', sourceId: 'codex', label: 'Carver the 2nd', role: 'explorer' }))
      .toEqual({ name: 'Carver the 2nd', task: 'explorer' });
  });

  it('generates a seeded full name for Claude descriptions and non-person labels, keeping the label as task', () => {
    const claude = observedSubagentIdentity({ sessionId: 's', subagentId: 'a1', sourceId: 'claude-code', label: 'Team setup dialog UI', role: 'general-purpose' });
    const expected = generateFullName('s:a1', new Set());
    expect(claude).toEqual({ name: expected.name, gender: expected.gender, task: 'Team setup dialog UI' });
    // Claude labels are descriptions even when they look like a name.
    expect(observedSubagentIdentity({ sessionId: 's', subagentId: 'a1', sourceId: 'claude-code', label: 'Reviewer' }).name).toBe(expected.name);
    expect(observedSubagentIdentity({ sessionId: 's', subagentId: 'x', sourceId: 'codex', label: 'worker' }).task).toBe('worker');
    expect(observedSubagentIdentity({ sessionId: 's', subagentId: 'x', sourceId: 'codex' }).task).toBeUndefined();
    const taken = new Set([generateFullName('s:a1', new Set()).name]);
    expect(observedSubagentIdentity({ sessionId: 's', subagentId: 'a1', sourceId: 'claude-code', taken }).name).not.toBe(expected.name);
  });
});

describe('observed presence: sources, nested subagents, names, models', () => {
  const now = Date.parse('2026-10-09T00:01:00.000Z');
  const codex = { ...session('cx', { agentName: 'Mira Santoso', agentGender: 'female', title: 'Refactor the router' }, { sourceId: 'codex', hook: true }), model: 'gpt-5.5-codex' } as SessionSummary;
  const claude = session('cl', { agentName: 'Bima Pratama', title: 'Team dialog' }, { sourceId: 'claude-code' });
  const events = [
    event('cx', 1, { type: 'prompt.submitted', text: 'go', via: 'native' }),
    event('cx', 2, { type: 'subagent.spawned', subagentId: 'c1', label: 'Carver the 2nd', role: 'explorer', model: 'gpt-5.5-mini' }),
    event('cx', 3, { type: 'subagent.spawned', subagentId: 'c2', label: 'router_split', role: 'worker', model: 'gpt-5.5' }, 'c1'),
    event('cx', 4, { type: 'turn.completed', model: 'gpt-5.5-high' }, 'c2'),
    event('cl', 1, { type: 'subagent.spawned', subagentId: 'agent-1', label: 'Team setup dialog UI', role: 'general-purpose', model: 'opus' }),
    event('cl', 2, { type: 'model.completed', text: 'done', model: 'claude-opus-5-5' }, 'agent-1'),
    event('cl', 3, { type: 'model.completed', text: 'ok', model: 'claude-sonnet-5-5' }),
  ];
  const agents = projectOfficePresence([codex, claude], events, now);
  const byId = new Map(agents.map(agent => [agent.id, agent]));

  it('gives leads their name, source, channel and model', () => {
    expect(byId.get('cx:primary')).toMatchObject({ displayName: 'Mira Santoso', title: 'Refactor the router', model: 'gpt-5.5-codex',
      origin: { mark: 'codex', label: 'Codex', channel: 'hook' } });
    expect(byId.get('cl:primary')).toMatchObject({ displayName: 'Bima Pratama', model: 'claude-sonnet-5-5', origin: { mark: 'claude-code', channel: 'transcript' } });
  });

  it('nests Codex children, keeps nicknames, generates names, and takes the newest model', () => {
    const carver = byId.get('cx:c1');
    expect(carver).toMatchObject({ displayName: 'Carver the 2nd', title: 'explorer', parentId: 'cx:primary', model: 'gpt-5.5-mini', look: lookIdentity('Carver the 2nd') });
    const nested = byId.get('cx:c2');
    expect(nested).toMatchObject({ parentId: 'cx:c1', title: 'router_split', model: 'gpt-5.5-high', origin: { mark: 'codex' } });
    expect(nested?.displayName).toMatch(/^\S+ \S+/);
    expect(nested?.look?.seed).toBe(lookIdentity(nested!.displayName)!.seed);
  });

  it('names Claude subagents from the generator, with the description as task line', () => {
    const child = byId.get('cl:agent-1');
    const expected = generateFullName('cl:agent-1', new Set(['Bima Pratama']));
    expect(child).toMatchObject({ displayName: expected.name, title: 'Team setup dialog UI', model: 'claude-opus-5-5', parentId: 'cl:primary' });
    expect(child?.look).toEqual(lookIdentity(expected.name, expected.gender));
    // Stable across projections (3D, board and popover read the same presence).
    expect(projectOfficePresence([codex, claude], events, now).find(agent => agent.id === 'cl:agent-1')?.displayName).toBe(expected.name);
  });

  it('keeps the board tree data (depth, guides, elbows, stems) unchanged by the dashed lines', () => {
    const rows = boardRows(agents);
    expect(rows.map(row => [row.agent.id, row.depth, row.guides, row.last, row.stem])).toEqual([
      ['cx:primary', 0, [], true, true],
      ['cx:c1', 1, [], true, true],
      ['cx:c2', 2, [false], true, false],
      ['cl:primary', 0, [], true, true],
      ['cl:agent-1', 1, [], true, false],
    ]);
  });

  it('leaves managed agents without an observed model', () => {
    const [managed] = projectOfficePresence([session('m')], [], now);
    expect(managed?.origin).toEqual({ mark: 'extalia-native', label: 'Extalia Native' });
    expect(managed?.model).toBeUndefined();
  });
});

describe('ignored folders', () => {
  it('feature-detects the host list', () => {
    expect(readIgnoreFolders({ labelsOnly: false })).toBeUndefined();
    expect(readIgnoreFolders(undefined)).toBeUndefined();
    expect(readIgnoreFolders({ ignoreFolders: ['~/.claude-mem/', '', 3] })).toEqual(['~/.claude-mem']);
  });

  it('normalises, de-duplicates, removes and marks the default', () => {
    expect(normalizeIgnoredFolder('  ~/work/tmp//  ')).toBe('~/work/tmp');
    expect(normalizeIgnoredFolder('/')).toBe('/');
    expect(normalizeIgnoredFolder('~/')).toBe('~/');
    expect(addIgnoredFolder(['~/.claude-mem'], '~/.claude-mem/')).toMatchObject({ added: false, duplicate: true });
    expect(addIgnoredFolder(['~/.claude-mem'], '   ')).toMatchObject({ added: false, duplicate: false });
    expect(addIgnoredFolder(['~/.claude-mem'], '~/scratch/')).toEqual({ list: ['~/.claude-mem', '~/scratch'], added: true, duplicate: false });
    expect(removeIgnoredFolder(['~/.claude-mem', '~/scratch'], '~/.claude-mem/')).toEqual(['~/scratch']);
    expect(isDefaultIgnoredFolder('~/.claude-mem/')).toBe(true);
    expect(isDefaultIgnoredFolder('~/scratch')).toBe(false);
    expect(readDefaultIgnoreFolders({ defaultIgnoreFolders: ['~/helpers/'] })).toEqual(['~/helpers']);
    expect(readDefaultIgnoreFolders({})).toEqual(['~/.claude-mem']);
    expect(isDefaultIgnoredFolder('~/helpers', ['~/helpers'])).toBe(true);
    expect(missesDefaults(['~/scratch'])).toBe(true);
    expect(missesDefaults(['~/.claude-mem/', '~/scratch'])).toBe(false);
  });
});

describe('newest reported model under interleaved hook and transcript events', () => {
  // Hook events arrive live (no sequence, their own times); transcript events carry sequence numbers and may be re-read.
  const clock = (n: number) => `2026-10-09T00:00:${String(n).padStart(2, '0')}.000Z`;
  const hookEvent = (n: number, body: EventBody, agentId = 'primary') => createEvent({ id: `h-${n}-${agentId}`, at: clock(n), sessionId: 'o', agentId,
    source: { runtime: 'claude-code', channel: 'hook' }, body });
  const transcriptEvent = (n: number, body: EventBody, agentId = 'primary') => createEvent({ id: `t-${n}-${agentId}`, at: clock(n), seq: n, sessionId: 'o', agentId,
    source: { runtime: 'claude-code', channel: 'transcript' }, body });
  const turn = (model: string) => ({ type: 'turn.completed' as const, model });

  it('keeps the model of the newest event time whatever the arrival order', () => {
    const hook = hookEvent(5, { type: 'session.started', control: 'observed', model: 'hook-new' });
    const transcript = transcriptEvent(3, turn('transcript-old'));
    const reread = transcriptEvent(1, turn('stale-window'));
    for (const order of [[hook, transcript, reread], [transcript, reread, hook], [reread, hook, transcript]]) {
      expect(latestAgentModels(order).get('primary')).toBe('hook-new');
    }
  });

  it('takes a later transcript report over an earlier hook report', () => {
    const hook = hookEvent(5, turn('hook-old'));
    const transcript = transcriptEvent(8, turn('transcript-new'));
    expect(latestAgentModels([transcript, hook]).get('primary')).toBe('transcript-new');
    expect(latestAgentModels([hook, transcript]).get('primary')).toBe('transcript-new');
  });

  it('breaks a tie in event time by sequence, and ignores copied history and events without a model', () => {
    const second = transcriptEvent(7, turn('second'));
    const first = createEvent({ id: 'first', at: clock(7), seq: 6, sessionId: 'o', source: { runtime: 'claude-code', channel: 'transcript' }, body: turn('first') });
    const copied = createEvent({ id: 'copied', at: clock(9), seq: 20, sessionId: 'o', source: { runtime: 'claude-code', channel: 'import' }, body: turn('copied') });
    const blank = transcriptEvent(10, { type: 'turn.completed' });
    expect(latestAgentModels([second, copied, blank, first]).get('primary')).toBe('second');
  });

  it('keys a sub-agent spawn model and its later replies by the sub-agent', () => {
    const spawn = hookEvent(2, { type: 'subagent.spawned', subagentId: 'sub', model: 'spawn-model' });
    const reply = transcriptEvent(4, { type: 'model.completed', text: 'ok', model: 'reply-model' }, 'sub');
    const late = transcriptEvent(3, { type: 'model.completed', text: 'older', model: 'older-reply' }, 'sub');
    expect(Object.fromEntries(latestAgentModels([reply, spawn, late]))).toEqual({ sub: 'reply-model' });
  });

  it('shows the event-derived lead model in the office, not the session summary when events report one', () => {
    const sessions = [session('o', { model: 'summary-stale' } as Partial<SessionSummary>, { sourceId: 'claude-code', hook: true })];
    const events = [
      transcriptEvent(3, turn('transcript-old')),
      hookEvent(5, { type: 'session.started', control: 'observed', model: 'hook-new' }),
      transcriptEvent(1, turn('stale-window')),
    ];
    const lead = (list: ExtaliaEvent[]) => projectOfficePresence(sessions, list, Date.parse(clock(30))).find(agent => agent.agentId === 'primary');
    expect(lead(events)?.model).toBe('hook-new');
    expect(lead([])?.model).toBe('summary-stale');
  });
});
