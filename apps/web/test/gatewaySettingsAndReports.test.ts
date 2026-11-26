import type * as React from 'react';
import {
  AGENT_HOST_METHODS,
  GATEWAY_HOST_METHODS,
  type AgentHostApi,
  type ChatSystemReportsView,
  type GatewayOverview,
  type HostState,
  type WorkspaceReportsInboxView,
  type WorkspaceSystemReport,
} from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../src/chat/ChatPage';
import { ChatSystemReportCard } from '../src/chat/ChatSystemReportCard';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { SettingsPage } from '../src/pages/SettingsPage';
import { GatewaySettingsSection } from '../src/pages/settings/GatewaySettingsSection';
import { availableSettingsSections, SETTINGS_SECTIONS } from '../src/pages/settings/settingsSections';
import { DEFAULT_PREFERENCES } from '../src/preferences';

const hooks = vi.hoisted(() => ({
  enabled: false,
  index: 0,
  values: [] as unknown[],
  pending: [] as (() => void)[],
}));

vi.mock('react', async original => {
  const actual = await original<typeof React>();
  return {
    ...actual,
    useId: () => {
      if (!hooks.enabled) return actual.useId();
      return `gw-test-${hooks.index++}`;
    },
    useRef: (initial: unknown) => {
      if (!hooks.enabled) return actual.useRef(initial);
      const index = hooks.index++;
      return hooks.values[index] ??= { current: initial };
    },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      if (!hooks.enabled) return actual.useMemo(compute, deps);
      return compute();
    },
    useState: (initial: unknown) => {
      if (!hooks.enabled) return actual.useState(initial);
      const index = hooks.index++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      return [
        hooks.values[index],
        (next: unknown) => {
          hooks.values[index] = typeof next === 'function'
            ? (next as (current: unknown) => unknown)(hooks.values[index])
            : next;
        },
      ];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.enabled) return actual.useEffect(effect, deps);
      const index = hooks.index++;
      const slot = hooks.values[index] as { deps?: unknown[]; cleanup?: () => void } | undefined;
      const unchanged = slot?.deps && deps && slot.deps.length === deps.length
        && slot.deps.every((value, at) => Object.is(value, deps[at]));
      if (unchanged) return;
      hooks.pending.push(() => {
        slot?.cleanup?.();
        const cleanup = effect();
        hooks.values[index] = { deps, cleanup: cleanup || undefined };
      });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.enabled) return actual.useLayoutEffect(effect, deps);
      hooks.pending.push(() => { effect(); });
    },
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;');

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  hooks.enabled = false;
  hooks.index = 0;
  hooks.values = [];
  hooks.pending = [];
});

afterEach(() => {
  hooks.enabled = false;
  vi.unstubAllGlobals();
});

describe('Gateway Settings UI, Workspace Reports Inbox, Chat System Reports & Mocks (GW-WP-17)', () => {
  it('registers all GATEWAY_HOST_METHODS in AGENT_HOST_METHODS and mockHost', () => {
    for (const method of GATEWAY_HOST_METHODS) {
      expect(AGENT_HOST_METHODS).toContain(method);
    }
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    for (const method of GATEWAY_HOST_METHODS) {
      expect(typeof agents[method]).toBe('function');
    }
  });

  it('orders gateway between agent-apps and storage while preserving backwards-compatible availableSettingsSections', () => {
    const agentAppsIndex = SETTINGS_SECTIONS.indexOf('agent-apps');
    const gatewayIndex = SETTINGS_SECTIONS.indexOf('gateway');
    const storageIndex = SETTINGS_SECTIONS.indexOf('storage');
    expect(gatewayIndex).toBe(agentAppsIndex + 1);
    expect(storageIndex).toBe(gatewayIndex + 1);

    expect(availableSettingsSections({ agents: true, system: true })).toEqual(SETTINGS_SECTIONS);
    expect(availableSettingsSections({ agents: true, system: true, gateway: true })).toContain('gateway');
    expect(availableSettingsSections({ agents: true, system: true, gateway: false })).not.toContain('gateway');
    expect(availableSettingsSections({ agents: false, system: true, gateway: true })).not.toContain('gateway');
  });

  it('renders Gateway tab in SettingsPage only when managed and gatewayOverview is supported', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const hostState = await agents.getState();

    const managedHtml = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState,
      onHostState: vi.fn(),
      updateStatus: null,
      section: 'gateway',
    }));
    expect(managedHtml).toContain(escapeHtml(MESSAGES.en.settings.sections.gateway));
    expect(managedHtml).toContain(escapeHtml(MESSAGES.en.gatewaySettings.title));

    const observeHtml = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState: { ...hostState, workflow: 'observe' },
      onHostState: vi.fn(),
      updateStatus: null,
      section: 'gateway',
    }));
    expect(observeHtml).not.toContain(escapeHtml(MESSAGES.en.settings.sections.gateway));

    const noGatewayAgents = { ...agents };
    delete noGatewayAgents.gatewayOverview;
    const unsupportedHtml = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform: { ...platform, capabilities: { ...platform.capabilities, agents: noGatewayAgents } },
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState,
      onHostState: vi.fn(),
      updateStatus: null,
      section: 'gateway',
    }));
    expect(unsupportedHtml).not.toContain(escapeHtml(MESSAGES.en.settings.sections.gateway));
  });

  it('renders GatewaySettingsSection in EN and ID with 5-dimension health, linking, routes, inbox, and audit log', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const hostState = await agents.getState();
    const overview: GatewayOverview = await agents.gatewayOverview!();
    const inbox: WorkspaceReportsInboxView = await agents.listWorkspaceReports!(hostState.workspaces[0]!.id);

    for (const lang of ['en', 'id'] as const) {
      const t = MESSAGES[lang];
      const html = renderToStaticMarkup(createElement(GatewaySettingsSection, {
        t,
        agents,
        state: hostState,
        initialOverview: overview,
        initialInbox: inbox,
      }));
      expect(html).toContain(t.gatewaySettings.title);
      expect(html).toContain(t.gatewaySettings.connectors.title);
      expect(html).toContain(t.gatewaySettings.connectors.secretRefHint);
      expect(html).toContain(t.gatewaySettings.connectors.healthDimensions.transport);
      expect(html).toContain(t.gatewaySettings.connectors.healthDimensions.host);
      expect(html).toContain(t.gatewaySettings.connectors.healthDimensions.runtime);
      expect(html).toContain(t.gatewaySettings.connectors.healthDimensions.progress);
      expect(html).toContain(t.gatewaySettings.connectors.healthDimensions.notification);
      expect(html).toContain(escapeHtml(t.gatewaySettings.linking.title));
      expect(html).toContain(escapeHtml(t.gatewaySettings.routes.title));
      expect(html).toContain(escapeHtml(t.gatewaySettings.inbox.title));
      expect(html).toContain(t.gatewaySettings.inbox.candidateSeparationNote);
      expect(html).toContain(t.gatewaySettings.audit.title);
      expect(html).toContain('skill-audit-helper@rev-2');
      expect(html).toContain(t.chat.systemReports.skillStates['review-required']);
    }
  });

  it('renders ChatSystemReportCard read-only in EN and ID with sanitized problems and GW-AT-088 badge', () => {
    const syntheticPath = ['/Users', 'example-user', '.extalia-vo', 'secret'].join('/');
    const syntheticToken = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const report: WorkspaceSystemReport = {
      id: 'rep-test-1',
      revision: 1,
      source: 'skills',
      sourceJobId: 'job-skills-1',
      workspaceId: 'ws-1',
      sourceSessionId: 'sess-1',
      targetChatId: 'sess-1',
      targetSelection: 'last-eligible',
      outcome: 'partial',
      knowledge: { state: 'saved', indexed: true },
      skills: [{
        packageId: 'pkg-check',
        revisionId: 'rev-1',
        state: 'review-required',
        activationPerformed: false,
      }],
      meeting: { outcome: 'completed', knowledge: 'saved' },
      problems: [
        `Failed upload from ${syntheticPath} using token ${syntheticToken}`,
      ],
      committedAt: '2026-11-26T00:00:00.000Z',
      lastUpdatedAt: '2026-11-26T00:00:00.000Z',
      audienceScopeId: 'workspace:ws-1:private',
    };

    for (const lang of ['en', 'id'] as const) {
      const t = MESSAGES[lang];
      const html = renderToStaticMarkup(createElement(ChatSystemReportCard, {
        t,
        report,
        language: lang,
      }));
      expect(html).toContain('data-testid="chat-system-report-card"');
      expect(html).toContain(t.chat.systemReports.readOnlyBadge);
      expect(html).toContain(t.chat.systemReports.sources.skills);
      expect(html).toContain(t.chat.systemReports.outcomes.partial);
      expect(html).toContain(t.chat.systemReports.knowledgeStates.saved);
      expect(html).toContain(t.chat.systemReports.skillStates['review-required']);
      expect(html).toContain(t.chat.systemReports.activationNotPerformed);
      expect(html).toContain(t.chat.systemReports.meetingOutcomes.completed);
      expect(html).toContain('[redacted-secret]');
      expect(html).toContain('[redacted-path]');
      expect(html).not.toContain(syntheticToken);
      expect(html).not.toContain(syntheticPath);
    }
  });

  it('fetches and displays session system reports in ChatPage race-safely without touching composer', async () => {
    hooks.enabled = true;
    vi.stubGlobal('window', { addEventListener: vi.fn(), scrollTo: vi.fn() });
    vi.stubGlobal('document', { documentElement: { scrollHeight: 0 } });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));

    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const baseAgents = platform.capabilities.agents!;
    const hostState: HostState = await baseAgents.getState();
    const workspace = hostState.workspaces.find(item => item.mode !== 'observe')!;
    const workspaceSessions = hostState.sessions.filter(item => item.workspaceId === workspace.id && item.control === 'managed');
    const sessionA = workspaceSessions[0]!;
    const sessionB = workspaceSessions[1]!;

    let resolveFirst!: (value: ChatSystemReportsView) => void;
    const listSessionSystemReports = vi.fn((wsId: string, sessId: string) => {
      if (sessId === sessionA.id) {
        return new Promise<ChatSystemReportsView>(resolve => { resolveFirst = resolve; });
      }
      return Promise.resolve({
        workspaceId: wsId,
        sessionId: sessId,
        reports: [{
          id: 'rep-session-b',
          revision: 1,
          source: 'knowledge-build' as const,
          sourceJobId: 'job-b',
          workspaceId: wsId,
          sourceSessionId: sessId,
          targetChatId: sessId,
          targetSelection: 'pinned' as const,
          outcome: 'completed' as const,
          knowledge: { state: 'saved' as const, indexed: true },
          committedAt: '2026-11-26T00:00:00.000Z',
          lastUpdatedAt: '2026-11-26T00:00:00.000Z',
          audienceScopeId: `workspace:${wsId}:team`,
        }],
      });
    });

    const agents: AgentHostApi = {
      ...baseAgents,
      sessionEvents: vi.fn(async () => []),
      subscribe: vi.fn(() => () => {}),
      listSessionSystemReports,
    };

    const drawChat = (sessionId: string) => {
      hooks.index = 0;
      const tree = ChatPage({
        t: MESSAGES.en,
        language: 'en',
        agents,
        state: hostState,
        onState: vi.fn(),
        selection: { workspaceId: workspace.id, sessionId },
        onSelect: vi.fn(),
        onOpenSettings: vi.fn(),
        onReviewSkills: vi.fn(),
      });
      for (const effect of hooks.pending.splice(0)) effect();
      return tree;
    };

    // Start on session A (pending promise)
    drawChat(sessionA.id);
    // Switch to session B before session A resolves
    drawChat(sessionB.id);
    await flushMicrotasks();

    // Now resolve stale session A response with a marker that must be dropped
    resolveFirst({
      workspaceId: workspace.id,
      sessionId: sessionA.id,
      reports: [{
        id: 'rep-stale-a',
        revision: 1,
        source: 'learning',
        sourceJobId: 'job-stale-a',
        workspaceId: workspace.id,
        sourceSessionId: sessionA.id,
        targetChatId: sessionA.id,
        targetSelection: 'last-eligible',
        outcome: 'completed',
        committedAt: '2026-11-26T00:00:00.000Z',
        lastUpdatedAt: '2026-11-26T00:00:00.000Z',
        audienceScopeId: `workspace:${workspace.id}:team`,
      }],
    });
    await flushMicrotasks();

    const finalTree = drawChat(sessionB.id);
    const cards = elements(finalTree).filter(node => node.type === ChatSystemReportCard);
    expect(cards).toHaveLength(1);
    expect((cards[0]!.props.report as WorkspaceSystemReport).id).toBe('rep-session-b');
  });

  it('exercises the full mockHost Gateway RPC lifecycle and raw-secret rejection', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const state = await agents.getState();
    const workspaceId = state.workspaces[0]!.id;

    // Seeded overview
    const initial = await agents.gatewayOverview!();
    expect(initial.connectors.length).toBeGreaterThanOrEqual(2);
    expect(initial.connectors.map(item => item.provider)).toEqual(expect.arrayContaining(['discord', 'telegram']));
    for (const connector of initial.connectors) {
      expect(connector.health).toBeDefined();
      expect(connector.health?.transport).toBeDefined();
      expect(connector.health?.host).toBeDefined();
      expect(connector.health?.runtime).toBeDefined();
      expect(connector.health?.progress).toBeDefined();
      expect(connector.health?.notification).toBeDefined();
    }

    // Raw secret rejection
    await expect(agents.saveGatewayConnector!({
      provider: 'discord',
      providerAccountId: 'guild-raw-test',
      secretRef: 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz',
    })).rejects.toThrow(/opaque secretRef/i);

    await expect(agents.saveGatewayConnector!({
      provider: 'telegram',
      providerAccountId: 'bot-raw-test',
      secretRef: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    })).rejects.toThrow(/opaque secretRef/i);

    // Save connector + status toggle
    const afterSave = await agents.saveGatewayConnector!({
      provider: 'whatsapp',
      providerAccountId: 'wa-demo-001',
      secretRef: 'keychain:extalia-gateway-wa-1',
    });
    const wa = afterSave.connectors.find(item => item.provider === 'whatsapp')!;
    expect(wa.status).toBe('connected');

    const afterDisable = await agents.setGatewayConnectorStatus!(wa.id, 'disabled');
    expect(afterDisable.connectors.find(item => item.id === wa.id)?.status).toBe('disabled');
    expect(afterDisable.connectors.find(item => item.id === wa.id)?.health?.transport.status).toBe('disconnected');

    // Challenge -> confirm -> reuse rejection -> revoke
    const challenge = await agents.issueGatewayLinkChallenge!({
      connectorId: wa.id,
      extaliaPrincipalId: 'principal-operator',
    });
    expect(challenge.code).toBeTruthy();

    const afterLink = await agents.confirmGatewayPrincipalLink!({
      challengeId: challenge.challengeId,
      providerAccountId: 'wa-demo-001',
      externalActorId: 'wa-actor-42',
      permissionBands: ['read_status', 'view_reports'],
    });
    const createdLink = afterLink.links.find(item => item.externalActorId === 'wa-actor-42')!;
    expect(createdLink.state).toBe('active');
    expect(createdLink.permissionBands).toEqual(['read_status', 'view_reports']);

    await expect(agents.confirmGatewayPrincipalLink!({
      challengeId: challenge.challengeId,
      providerAccountId: 'wa-demo-001',
      externalActorId: 'wa-actor-99',
      permissionBands: ['read_status'],
    })).rejects.toThrow(/already been used/i);

    const afterRevoke = await agents.revokeGatewayPrincipalLink!(createdLink.id, 'No longer needed');
    expect(afterRevoke.links.find(item => item.id === createdLink.id)?.state).toBe('revoked');

    // Route save -> delete
    const afterRoute = await agents.saveGatewayRoute!({
      connectorId: wa.id,
      providerAccountId: 'wa-demo-001',
      channelId: 'wa-room-100',
      threadId: 'wa-thread-1',
      workspaceId,
      mode: 'thread-new-session',
      audience: 'team',
      inboundEnabled: true,
      outboundEnabled: true,
    });
    const createdRoute = afterRoute.routes.find(item => item.channelId === 'wa-room-100')!;
    expect(createdRoute.threadId).toBe('wa-thread-1');
    expect(createdRoute.workspaceId).toBe(workspaceId);

    const afterDeleteRoute = await agents.deleteGatewayRoute!(createdRoute.id);
    expect(afterDeleteRoute.routes.some(item => item.id === createdRoute.id)).toBe(false);

    // Workspace inbox & session reports
    const inbox = await agents.listWorkspaceReports!(workspaceId);
    expect(inbox.reports.some(item => item.knowledge?.state === 'saved')).toBe(true);
    expect(inbox.reports.some(item => item.skills?.some(skill => skill.state === 'review-required' && !skill.activationPerformed))).toBe(true);
    expect(inbox.reports.some(item => item.source === 'schedule-run')).toBe(true);

    const chatReportSession = inbox.reports.find(item => item.targetChatId)?.targetChatId;
    expect(chatReportSession).toBeTruthy();
    const sessionReports = await agents.listSessionSystemReports!(workspaceId, chatReportSession!);
    expect(sessionReports.reports.length).toBeGreaterThanOrEqual(1);
    expect(sessionReports.reports.every(item => item.targetSelection !== 'inbox')).toBe(true);
  });
});
