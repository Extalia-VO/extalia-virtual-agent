import { createElement } from 'react';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { officeCharacterContext } from '../src/office/characterContext';
import { OfficePromptDock } from '../src/office/OfficePromptDock';
import type { OfficeAgent } from '../src/office/presence';
import { OfficePage } from '../src/pages/OfficePage';

const captured = vi.hoisted(() => ({ canvas: undefined as { onSelect(id: string): void; agents: OfficeAgent[] } | undefined,
  camera: undefined as { onFocus(shot: { mode: 'attention'; targetId: string }): void; scope: string } | undefined }));
// Keep the real Office component's selection callbacks, without loading WebGL into a server-rendered test.
vi.mock('react', async original => ({ ...await original<typeof React>(), lazy: () => (props: { onSelect?: (id: string) => void; agents: OfficeAgent[] }) => {
  if (props.onSelect) captured.canvas = { onSelect: props.onSelect, agents: props.agents };
  return null;
} }));
vi.mock('../src/office/useCameraDirector', () => ({ useCameraDirector: (options: NonNullable<typeof captured.camera>) => {
  captured.camera = options; return undefined;
} }));

const at = '2030-01-01T00:00:00.000Z';
const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id, workspaceId: 'project-a', title: id, connectionId: 'connection', control: 'managed', running: true, createdAt: at, lastActiveAt: at, ...patch,
});
const managed = session('managed');
const observed = session('observed', { workspaceId: 'project-b', control: 'observed',
  observation: { sourceId: 'codex', nativeSessionId: 'external-session', watching: true, status: 'watching', channel: 'hook' } });
const agent = (source: SessionSummary, patch: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id: `${source.id}:primary`, sessionId: source.id, agentId: 'primary', displayName: 'Example lead', status: 'working',
  control: source.control, running: true, ...patch,
});
beforeEach(() => { captured.canvas = undefined; captured.camera = undefined; });
afterEach(() => vi.unstubAllGlobals());
function officeState(sessions = [managed, observed]): HostState {
  return { profile: { id: 'default', name: 'Example' }, connections: [],
    workspaces: [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }], sessions,
  } as unknown as HostState;
}
function page(state: HostState, workspaceId: string, extra: Partial<Parameters<typeof OfficePage>[0]> = {}) {
  return renderToStaticMarkup(createElement(OfficePage, {
    t: MESSAGES.en, language: 'en', state, workspaceId, onState: vi.fn(), onWorkspace: vi.fn(),
    onOpenSession: vi.fn(), onStartChat: vi.fn(), onOpenSettings: vi.fn(), ...extra,
  }));
}

describe('explicit Office character context', () => {
  it('selects a managed source session and its workspace, with workers prompting their own lead', () => {
    const lead = agent(managed);
    const worker = agent(managed, { id: 'managed:worker', agentId: 'worker', parentId: lead.id, displayName: 'Example worker' });
    expect(officeCharacterContext(MESSAGES.en, lead, [managed, observed], [lead, worker])).toEqual({
      workspaceId: 'project-a', sessionId: 'managed', dock: { sessionId: 'managed' },
    });
    expect(officeCharacterContext(MESSAGES.id, worker, [managed, observed], [lead, worker])).toEqual({
      workspaceId: 'project-a', sessionId: 'managed', dock: { sessionId: 'managed', note: MESSAGES.id.officeUx.composer.viaSubagent('Example worker', 'Example lead') },
    });
  });

  it('retains the observed source identity without granting a managed prompt target', () => {
    const source = agent(observed);
    expect(officeCharacterContext(MESSAGES.en, source, [managed, observed], [source])).toEqual({
      workspaceId: 'project-b', sessionId: 'observed', dock: { note: MESSAGES.en.officeUx.composer.observedTarget(source.displayName) },
    });
    expect(officeCharacterContext(MESSAGES.en, source, [{ ...observed, workspaceId: '' }], [source])?.workspaceId).toBeUndefined();
    expect(officeCharacterContext(MESSAGES.en, undefined, [managed, observed], [])).toBeUndefined();
    expect(officeCharacterContext(MESSAGES.en, source, [managed], [])).toBeUndefined();
  });

  it('wires deliberate avatar picks to the source context, while camera attention and staff leave it alone', () => {
    const state = officeState();
    const onWorkspace = vi.fn();
    const markup = renderToStaticMarkup(createElement(OfficePage, {
      t: MESSAGES.en, language: 'en', state, workspaceId: 'project-a', onState: vi.fn(), onWorkspace,
      onOpenSession: vi.fn(), onStartChat: vi.fn(), onOpenSettings: vi.fn(),
    }));
    expect(markup).toContain('data-focus-key="row:managed:primary"');
    expect(markup).toContain('data-focus-key="row:observed:primary"');
    expect(onWorkspace).not.toHaveBeenCalled();
    captured.camera!.onFocus({ mode: 'attention', targetId: 'observed:primary' });
    expect(onWorkspace).not.toHaveBeenCalled();
    captured.canvas!.onSelect('managed:primary');
    expect(onWorkspace).toHaveBeenLastCalledWith('project-a', 'managed');
    captured.canvas!.onSelect('observed:primary');
    expect(onWorkspace).toHaveBeenLastCalledWith('project-b', 'observed');
    captured.canvas!.onSelect('facility:receptionist');
    captured.canvas!.onSelect('removed-session:primary');
    expect(onWorkspace).toHaveBeenCalledTimes(2);
  });

  it('keeps the global board and scene intact when the active workspace changes', () => {
    const state = officeState(); const sourceOrder = state.sessions.map(item => item.id);
    let cameraScope: string | undefined;
    for (const workspaceId of ['project-a', 'project-b']) {
      const markup = page(state, workspaceId);
      expect(markup).toContain('data-focus-key="row:managed:primary"');
      expect(markup).toContain('data-focus-key="row:observed:primary"');
      expect(captured.canvas!.agents.map(item => item.sessionId)).toEqual(expect.arrayContaining(['managed', 'observed']));
      if (cameraScope) expect(captured.camera!.scope).toBe(cameraScope);
      cameraScope = captured.camera!.scope;
    }
    expect(state.sessions.map(item => item.id)).toEqual(sourceOrder);
  });

  it('preserves observed-input priority beyond the recent-session cap across projects', () => {
    // Older in the sorted list, but still live: stale observed sessions correctly move to Earlier.
    const target = { ...observed, lastActiveAt: new Date(Date.now() - 1000).toISOString() };
    const state = officeState([...Array.from({ length: 26 }, (_, i) => session(`recent-${i}`)), target]);
    const markup = page(state, 'project-a', { inputFocus: { sessionId: target.id, token: 1 } });
    const rows = [...markup.matchAll(/data-focus-key="row:([^"]+)"/g)].map(match => match[1]);
    expect(rows).toContain('observed:primary');
    expect(rows).toContain('recent-0:primary');
    expect(captured.canvas!.agents.some(item => item.sessionId === target.id)).toBe(true);
  });

  it('keeps the shared notice slot above the compact prompt and its inert folds', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const markup = renderToStaticMarkup(createElement(OfficePromptDock, {
      t: MESSAGES.en, agents: {} as AgentHostApi, state: officeState(), workspaceId: 'project-b', compact: true,
      onTarget: vi.fn(), onState: vi.fn(), onStarted: vi.fn(), onOpenSettings: vi.fn(), onLearningTarget: vi.fn(),
    }));
    const slot = markup.indexOf('office-learning-slot');
    expect(slot).toBeGreaterThan(0);
    expect(slot).toBeLessThan(markup.indexOf('office-prompt-fold is-top'));
    expect(slot).toBeLessThan(markup.indexOf('<textarea'));
    expect(markup.slice(0, slot)).not.toContain('inert');
    expect(markup).not.toContain('data-open="true"');
  });
});
