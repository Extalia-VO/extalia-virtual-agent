import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionWorkspaceReview } from '../src/chat/SessionWorkspaceReview';
import { MESSAGES } from '../src/i18n';

const stamp = '2026-11-12T00:00:00.000Z';
const workspace: Workspace = { id: 'workspace-example', name: 'Example', profileId: 'default', projectLocation: '/projects/example', providerProfileId: 'connection-example', createdAt: stamp, updatedAt: stamp };
const session: SessionSummary = { id: 'session-example', workspaceId: workspace.id, connectionId: 'connection-example', title: 'Example', control: 'managed', running: false, createdAt: stamp, lastActiveAt: stamp, workspaceReviewRequired: true };
const state = { workspaces: [workspace] } as HostState;
const api = () => ({ previewSessionMove: vi.fn(), moveSession: vi.fn() }) as unknown as AgentHostApi;

describe('inline workspace access review', () => {
  it.each(['en', 'id'] as const)('offers explicit review without mutating or replaying in %s', language => {
    const agents = api();
    const html = renderToStaticMarkup(createElement(SessionWorkspaceReview, { t: MESSAGES[language], agents, state, session, onReviewed: vi.fn() }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(MESSAGES[language].chat.move.changedFolders);
    expect(html).toContain(MESSAGES[language].chat.move.reviewCurrent);
    expect(html).toContain('<button');
    expect(agents.previewSessionMove).not.toHaveBeenCalled();
    expect(agents.moveSession).not.toHaveBeenCalled();
  });

  it('does not invent review support or Native control for outside sessions', () => {
    const render = (record: SessionSummary, agents = api()) => renderToStaticMarkup(createElement(SessionWorkspaceReview, { t: MESSAGES.en, agents, state, session: record, onReviewed: vi.fn() }));
    expect(render({ ...session, workspaceReviewRequired: false })).toBe('');
    expect(render({ ...session, control: 'observed' })).toBe('');
    expect(render({ ...session, runtime: { id: 'hermes', profile: 'default' } })).toBe('');
    const unsupported = render(session, {} as AgentHostApi);
    expect(unsupported).toContain(MESSAGES.en.chat.move.reviewUnavailable);
    expect(unsupported).not.toContain('<button');
  });

  it('requires stopping active work before opening the review', () => {
    const html = renderToStaticMarkup(createElement(SessionWorkspaceReview, { t: MESSAGES.en, agents: api(), state, session: { ...session, running: true }, onReviewed: vi.fn() }));
    expect(html).toContain('disabled=""');
    expect(html).toContain(MESSAGES.en.chat.move.reviewWait);
  });

  it('offers explicit recovery after a rejected send even when the summary flag is absent', () => {
    const agents = api();
    const html = renderToStaticMarkup(createElement(SessionWorkspaceReview, { t: MESSAGES.en, agents, state,
      session: { ...session, workspaceReviewRequired: undefined }, required: true, onReviewed: vi.fn() }));
    expect(html).toContain(MESSAGES.en.chat.move.reviewCurrent);
    expect(html).toContain('<button');
    expect(agents.previewSessionMove).not.toHaveBeenCalled();
    expect(agents.moveSession).not.toHaveBeenCalled();
  });
});
