import type { HostState, RestartCapability } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { agentAppPrerequisites } from '../src/pages/ConnectAgentAppsCard';
import { activeAgentWork, restartPlan } from '../src/restart/restartPlan';
import { DraftRegistry } from '../src/restart/unsavedDrafts';
import { MESSAGES } from '../src/i18n';
import { RestartPrompt } from '../src/ui/RestartPrompt';

type Session = HostState['sessions'][number];

function session(overrides: Partial<Session>): Session {
  return { id: 's', workspaceId: 'w', connectionId: 'c', title: 'Session', control: 'managed', createdAt: '', lastActiveAt: '', running: false, ...overrides } as Session;
}

const t = MESSAGES.en;

describe('restart plan', () => {
  it('counts only Extalia-managed sessions that are running or waiting for an approval', () => {
    const state = {
      sessions: [
        session({ running: true }),
        session({ id: 'approval', pendingApprovalId: 'a1' }),
        session({ id: 'idle' }),
        session({ id: 'watched', control: 'observed', running: true }),
      ],
    };
    expect(activeAgentWork(state)).toBe(2);
    expect(activeAgentWork(null)).toBe(0);
  });

  it('restarts Desktop without confirmation when nothing would be lost', () => {
    expect(restartPlan('relaunch', { activeWork: 0, unsavedDraft: false })).toEqual({
      kind: 'relaunch', label: 'restartNow', confirm: false, reasons: [], options: { acknowledgeActiveWork: false },
    });
  });

  it('asks before a restart that would stop agent work or discard unsaved text', () => {
    expect(restartPlan('relaunch', { activeWork: 2, unsavedDraft: false })).toMatchObject({ confirm: true, reasons: ['activeWork'], options: { acknowledgeActiveWork: true } });
    expect(restartPlan('relaunch', { activeWork: 0, unsavedDraft: true })).toMatchObject({ confirm: true, reasons: ['unsavedDraft'], options: { acknowledgeActiveWork: false } });
    expect(restartPlan('relaunch', { activeWork: 1, unsavedDraft: true }).reasons).toEqual(['activeWork', 'unsavedDraft']);
  });

  it('offers Reload page on the web and keeps the same confirmation rule', () => {
    expect(restartPlan('reload', { activeWork: 0, unsavedDraft: false })).toMatchObject({ label: 'reloadPage', confirm: false });
    expect(restartPlan('reload', { activeWork: 0, unsavedDraft: true })).toMatchObject({ label: 'reloadPage', confirm: true });
  });
});

describe('unsaved drafts registry', () => {
  it('reports drafts only while an owner has pending text, and notifies on real changes only', () => {
    const registry = new DraftRegistry();
    const listener = vi.fn();
    const stop = registry.subscribe(listener);

    expect(registry.hasDrafts()).toBe(false);
    registry.set('composer', true);
    registry.set('composer', true);
    expect(registry.hasDrafts()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.set('other', true);
    registry.set('composer', false);
    expect(registry.hasDrafts()).toBe(true);
    registry.set('other', false);
    expect(registry.hasDrafts()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);

    stop();
    registry.set('composer', true);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('agent app prerequisites', () => {
  it('keeps the restart and the Codex hook approval as separate states', () => {
    expect(agentAppPrerequisites({ app: 'codex', trust: { status: 'untrusted', trusted: 0, total: 3 } })).toEqual({ eventsReceived: false, approval: 'pending' });
    expect(agentAppPrerequisites({ app: 'codex', trust: { status: 'modified', trusted: 2, total: 3 } }, '2026-10-15T10:00:00Z')).toEqual({ eventsReceived: true, approval: 'pending' });
    expect(agentAppPrerequisites({ app: 'codex', trust: { status: 'trusted', trusted: 3, total: 3 } }, '2026-10-15T10:00:00Z')).toEqual({ eventsReceived: true, approval: 'trusted' });
  });

  it('asks for no approval where the app does not use one', () => {
    expect(agentAppPrerequisites({ app: 'claude', trust: { status: 'not-applicable', trusted: 0, total: 0 } })).toEqual({ eventsReceived: false });
    expect(agentAppPrerequisites({ app: 'codex', trust: { status: 'unknown', trusted: 0, total: 0 } })).toEqual({ eventsReceived: false });
  });
});

describe('restart prompt markup', () => {
  const desktop: RestartCapability = { kind: 'relaunch', restart: async () => undefined };
  const web: RestartCapability = { kind: 'reload', restart: async () => undefined };
  const render = (props: Partial<Parameters<typeof RestartPrompt>[0]>) => renderToStaticMarkup(createElement(RestartPrompt, { t, restart: desktop, hostState: null, ...props }));

  it('offers Restart now and Later on Desktop', () => {
    const html = render({ onDismiss: () => undefined });
    expect(html).toContain('Restart now');
    expect(html).toContain('Later');
    expect(html).not.toContain('Reload page');
    expect(html).toContain('Saved sessions stay on this computer');
  });

  it('offers Reload page on the web and says it does not restart the Bridge or outside apps', () => {
    const html = render({ restart: web, onDismiss: () => undefined });
    expect(html).toContain('Reload page');
    expect(html).not.toContain('Restart now');
    expect(html).toContain('does not restart the Bridge, the CLI, Hermes or outside agent apps');
    expect(html).toContain('Later');
  });

  it('omits Later when the prompt is not optional, and renders nothing without a restart capability', () => {
    expect(render({})).not.toContain('>Later<');
    expect(render({ restart: undefined })).toBe('');
  });

  it('gives the reason and the outside-app limit as plain text', () => {
    const html = render({ reason: t.restart.manualLead });
    expect(html).toContain(t.restart.manualLead);
    expect(html).toContain('Extalia does not restart Codex');
  });
});
