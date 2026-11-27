/**
 * Universal Gateway v2 M1 Discord Adapter & Portrait Export Pipeline test suite.
 *
 * Covers acceptance tests GW-AT-016 through GW-AT-034 using synthetic fixtures,
 * temporary SQLite databases, and injectable mock `fetch` with zero live network calls.
 *
 * Note: Live Discord guild/forum/webhook verification (GW-AT-035) remains a separate
 * live-account acceptance gate and is intentionally excluded from mocked unit runs.
 */
import type { CharacterAppearance, TeamMember } from '@extalia/core';
import type { GatewayInboundEvent, GatewayProjectEvent } from '@extalia/platform';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutonomousReportService,
  GatewayOutboxService,
  GatewayRoutingService,
  GatewayStore,
} from '../src/gateway/index.js';
import {
  DISCORD_MESSAGE_CONTENT_INTENT_BIT,
  DISCORD_PERMISSIONS,
  DiscordGatewayAdapter,
  InMemoryDiscordSecretStore,
  type DiscordFetchFn,
  type DiscordHostDelegate,
  type DiscordInteractionPayload,
} from '../src/gateway/discord.js';
import {
  AVATAR_UNAVAILABLE_DIAGNOSTIC,
  AVATAR_UNAVAILABLE_INDICATOR,
  computeAppearanceHash,
  GatewayPortraitService,
  renderHeadshotPng,
  renderHeadshotSvg,
  sanitizeDiscordAgentDisplayName,
  validatePublicHttpsAssetBaseUrl,
} from '../src/gateway/portraits.js';

const NOW = '2026-11-24T15:00:00.000Z';
const LATER = '2026-11-24T15:02:00.000Z';
const AFTER_TTL = '2026-11-24T17:00:00.000Z';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extalia-gw-discord-'));
  tempDirs.push(dir);
  return path.join(dir, 'state', 'gateway.sqlite');
}

function makeAppearance(overrides: Partial<CharacterAppearance> = {}): CharacterAppearance {
  return {
    presentation: 'feminine',
    hairStyle: 'long-bangs',
    hairColor: '#2c1e16',
    skinTone: '#d9a684',
    outfit: 'architect',
    top: 'shirt',
    bottom: 'trousers',
    topColor: '#f1f5f9',
    outerColor: '#1e293b',
    accentColor: '#3b82f6',
    stature: 'default',
    gait: 'feminine',
    accessories: {
      glasses: 'rectangular',
      watch: 'classic',
      earrings: 'studs',
      bag: 'none',
      tie: true,
      badge: true,
      headphones: false,
    },
    ...overrides,
  };
}

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function createTestHarness(opts?: {
  publicAssetBaseUrl?: string;
  isAssetEndpointReachable?: () => boolean;
  publicKeyHex?: string;
  fetchHandler?: (req: RecordedFetch) => Promise<Response> | Response;
  hostOverrides?: Partial<DiscordHostDelegate>;
}) {
  const store = await GatewayStore.open(createTempDbPath());
  const routing = new GatewayRoutingService(store);
  const outbox = new GatewayOutboxService(store);
  const reports = new AutonomousReportService(store);
  const portraits = new GatewayPortraitService(store, {
    publicAssetBaseUrl: opts?.publicAssetBaseUrl ?? 'https://assets.example.com/gateway/avatars',
    isAssetEndpointReachable: opts?.isAssetEndpointReachable,
  });
  const secrets = new InMemoryDiscordSecretStore();
  secrets.put('keychain://extalia/gateway/discord/bot-1', 'mock-bot-secret-value');

  store.upsertConnector({
    id: 'conn-discord-1',
    provider: 'discord',
    providerAccountId: 'guild-100',
    secretRef: 'keychain://extalia/gateway/discord/bot-1',
    status: 'connected',
    now: NOW,
  });

  const recorded: RecordedFetch[] = [];
  let messageCounter = 1000;

  const fetchImpl: DiscordFetchFn = async (input, init) => {
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const body = typeof init?.body === 'string' && init.body
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    const rec: RecordedFetch = { url: input, method, headers, body };
    recorded.push(rec);

    if (opts?.fetchHandler) {
      return opts.fetchHandler(rec);
    }

    if (method === 'POST' && input.includes('/webhooks/') && !input.endsWith('/webhooks')) {
      messageCounter += 1;
      return jsonResponse({ id: `wh-msg-${messageCounter}` });
    }
    if (method === 'POST' && input.includes('/messages')) {
      messageCounter += 1;
      return jsonResponse({ id: `bot-msg-${messageCounter}` });
    }
    if (method === 'PATCH') {
      return jsonResponse({ id: `edited-${messageCounter}` });
    }
    return jsonResponse({ ok: true });
  };

  let createdSessionSeq = 0;
  const host: DiscordHostDelegate = {
    getRegisteredWorkspaceIds: () => new Set(['ws-alpha', 'ws-beta']),
    createManagedSession: async ({ workspaceId }) => {
      createdSessionSeq += 1;
      return { ok: true, sessionId: `sess-${workspaceId}-${createdSessionSeq}`, leadName: 'Elena Vael' };
    },
    listWorkspaceSessions: async ({ workspaceId }) => [
      { sessionId: `sess-${workspaceId}-existing`, workspaceId, title: 'Main build', running: true },
    ],
    getSessionStatus: async () => ({
      state: 'running',
      runId: 'run-42',
      leadName: 'Elena Vael',
      activeWorkers: 2,
      totalTasks: 5,
      lastVerifiedActivityAt: NOW,
      summary: 'Running integration checks.',
    }),
    getSessionTeam: async () => [
      {
        id: 'w-reviewer',
        name: 'Marcus Chen',
        role: 'Reviewer',
        state: 'working',
        portraitReady: true,
        soul: 'TOP-SECRET-INTERNAL-SOUL-PROMPT',
      },
    ],
    getSessionTasks: async () => [
      { id: 'task-1', title: 'Audit Discord webhook security', status: 'in_progress', ownerAgentId: 'w-reviewer' },
    ],
    listSchedules: async () => [
      { id: 'sch-1', name: 'Nightly knowledge refresh', nextRunAt: '2026-11-25T02:00:00.000Z', enabled: true },
    ],
    requestCancelTurn: async () => ({ status: 'request_sent', detail: 'Cancellation dispatched to runtime.' }),
    submitLeadTurn: async ({ actionId }) => ({ ok: true, hostActionId: `host-${actionId}`, status: 'admitted' }),
    isWorkerActiveInSession: () => true,
    getPinnedParentSessionId: ({ workspaceId }) => `sess-${workspaceId}-pinned`,
    settingsUiBaseUrl: 'https://extalia.example.com',
    ...opts?.hostOverrides,
  };

  const adapter = new DiscordGatewayAdapter({
    connectorId: 'conn-discord-1',
    applicationId: 'app-900',
    botUserId: 'bot-user-900',
    botTokenSecretRef: 'keychain://extalia/gateway/discord/bot-1',
    publicKeyHex: opts?.publicKeyHex,
    verifyGatewayWsReceipt: req => req.authenticatedTransportReceipt.startsWith('ws-sig:valid-'),
    store,
    routing,
    outbox,
    portraits,
    reports,
    secrets,
    host,
    fetchImpl,
    clock: () => NOW,
  });

  const linkPrincipal = (input: {
    guildId?: string;
    externalActorId: string;
    extaliaPrincipalId: string;
    bands: Array<
      | 'read_status'
      | 'view_reports'
      | 'submit_prompt'
      | 'manage_own_session'
      | 'manage_schedule'
      | 'manage_gateway_route'
    >;
  }) => {
    const issued = routing.principalLinks.issueChallenge({
      connectorId: 'conn-discord-1',
      extaliaPrincipalId: input.extaliaPrincipalId,
      permissionBands: input.bands,
      now: NOW,
    });
    const proof = routing.principalLinks.submitExternalProof({
      connectorId: 'conn-discord-1',
      providerAccountId: input.guildId ?? 'guild-100',
      externalActorId: input.externalActorId,
      actorKind: 'human',
      code: issued.code,
      now: NOW,
    });
    expect(proof.ok).toBe(true);
    const confirmed = routing.principalLinks.confirmLink({
      challengeId: issued.challengeId,
      extaliaPrincipalId: input.extaliaPrincipalId,
      now: NOW,
    });
    expect(confirmed.ok).toBe(true);
    return confirmed;
  };

  return { store, routing, outbox, reports, portraits, secrets, host, adapter, recorded, linkPrincipal };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Gateway M1 Portrait Pipeline & Discord Adapter (GW-AT-016..034)', () => {
  it('GW-AT-016 & GW-FR-024: falls back honestly to bot-only mode without Manage Webhooks, provisions opaque secretRef when granted, and rejects pasted webhook URLs', async () => {
    const basePerms =
      DISCORD_PERMISSIONS.VIEW_CHANNEL
      | DISCORD_PERMISSIONS.SEND_MESSAGES
      | DISCORD_PERMISSIONS.SEND_MESSAGES_IN_THREADS
      | DISCORD_PERMISSIONS.USE_APPLICATION_COMMANDS;

    let grantManageWebhooks = false;
    const h = await createTestHarness({
      fetchHandler: req => {
        if (req.method === 'GET' && req.url.endsWith('/guilds/guild-100')) {
          const perms = grantManageWebhooks ? (basePerms | DISCORD_PERMISSIONS.MANAGE_WEBHOOKS) : basePerms;
          return jsonResponse({ id: 'guild-100', roles: [{ id: 'role-bot', permissions: perms.toString() }] });
        }
        if (req.method === 'GET' && req.url.includes('/members/bot-user-900')) {
          return jsonResponse({ roles: ['role-bot'] });
        }
        if (req.method === 'GET' && req.url.endsWith('/channels/chan-200')) {
          return jsonResponse({ id: 'chan-200', guild_id: 'guild-100', permission_overwrites: [] });
        }
        if (req.method === 'POST' && req.url.endsWith('/channels/chan-200/webhooks')) {
          return jsonResponse({ id: 'wh-555', token: 'raw-webhook-secret-token-xyz' });
        }
        if (req.method === 'POST' && req.url.includes('/channels/thread-300/messages')) {
          return jsonResponse({ id: 'bot-fallback-msg-1' });
        }
        return jsonResponse({ id: 'wh-msg-1' });
      },
    });

    try {
      // 1. Missing Manage Webhooks -> honest bot-only fallback.
      const setupFallback = await h.adapter.verifyChannelPermissionsAndSetupWebhook({
        guildId: 'guild-100',
        channelId: 'chan-200',
        actor: 'admin-1',
        now: NOW,
      });
      expect(setupFallback.ok).toBe(true);
      expect(setupFallback.mode).toBe('bot-only-fallback');
      expect(setupFallback.missingPermissions).toContain('MANAGE_WEBHOOKS');
      expect(setupFallback.explanation).toMatch(/Manage Webhooks/i);
      expect((await h.adapter.capabilities('conn-discord-1')).perAgentWebhookPortraits).toBe(false);

      // Sending a Lead message in bot-only fallback must use Bot API with explicit fallback label.
      const route = h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });
      const binding = h.routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        threadId: 'thread-300',
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });
      const leadPortrait = h.portraits.exportLeadPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        leadName: 'Elena Vael',
        appearance: makeAppearance(),
        now: NOW,
      });
      expect(leadPortrait.ok).toBe(true);
      if (!leadPortrait.ok) throw new Error('Expected lead portrait');

      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-lead-fallback-1',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'primary',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'Starting architecture review.',
          at: NOW,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: leadPortrait.identity,
        now: NOW,
      });

      const dispatched = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'worker-1', now: NOW });
      expect(dispatched.status).toBe('accepted');
      const fallbackPost = h.recorded.find(r => r.method === 'POST' && r.url.includes('/channels/thread-300/messages'));
      expect(fallbackPost).toBeDefined();
      expect(String(fallbackPost?.body?.content)).toContain('[Lead: Elena Vael · Lead] (bot-only fallback)');

      // 2. Grant Manage Webhooks -> auto-provisions webhook, stores ONLY opaque secretRef, never echoes raw token.
      grantManageWebhooks = true;
      const setupWebhook = await h.adapter.verifyChannelPermissionsAndSetupWebhook({
        guildId: 'guild-100',
        channelId: 'chan-200',
        actor: 'admin-1',
        now: LATER,
      });
      expect(setupWebhook.ok).toBe(true);
      expect(setupWebhook.mode).toBe('webhook-portraits');
      expect(setupWebhook.webhook?.secretRef).toMatch(/^keychain:\/\//);
      expect(setupWebhook.explanation).not.toContain('raw-webhook-secret-token-xyz');
      expect(h.secrets.get(setupWebhook.webhook!.secretRef)).toBe('raw-webhook-secret-token-xyz');
      expect((await h.adapter.capabilities('conn-discord-1')).perAgentWebhookPortraits).toBe(true);
      // Verify audit never contains raw token.
      const audits = JSON.stringify(h.store.listAudit(50));
      expect(audits).not.toContain('raw-webhook-secret-token-xyz');

      // 3. GW-FR-024: pasting a raw webhook URL into slash command or chat is explicitly refused.
      h.linkPrincipal({
        externalActorId: 'discord-user-1',
        extaliaPrincipalId: 'ext-user-1',
        bands: ['manage_gateway_route', 'submit_prompt'],
      });
      const pastedCmd = await h.adapter.executeSlashCommand(
        {
          id: 'ix-paste-1',
          type: 2,
          application_id: 'app-900',
          token: 'ix-tok',
          guild_id: 'guild-100',
          channel_id: 'chan-200',
          member: { user: { id: 'discord-user-1' } },
          data: {
            name: 'extalia',
            options: [{
              name: 'connect',
              options: [{ name: 'url', value: 'https://discord.com/api/webhooks/123456789/super-secret-token' }], // extalia-allow-secret
            }],
          },
        },
        LATER,
      );
      expect(pastedCmd.ok).toBe(false);
      expect(pastedCmd.code).toBe('WEBHOOK_SECRET_IN_CHAT_REFUSED');
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-017 & GW-AT-018: authorized admin binds workspace with persisted revision; unauthorized guild member is refused with zero routes created', async () => {
    const h = await createTestHarness();
    try {
      h.linkPrincipal({
        externalActorId: 'discord-admin',
        extaliaPrincipalId: 'ext-admin',
        bands: ['manage_gateway_route', 'read_status'],
      });
      h.linkPrincipal({
        externalActorId: 'discord-viewer',
        extaliaPrincipalId: 'ext-viewer',
        bands: ['read_status'],
      });

      // GW-AT-018: Unlinked guild member invokes /extalia bind -> refused.
      const unlinkedRes = await h.adapter.executeSlashCommand(
        {
          id: 'ix-bind-unlinked',
          type: 2,
          application_id: 'app-900',
          token: 'tok-1',
          guild_id: 'guild-100',
          channel_id: 'chan-200',
          member: { user: { id: 'discord-stranger' } },
          data: {
            name: 'extalia',
            options: [{ name: 'bind', options: [{ name: 'workspace', value: 'ws-alpha' }] }],
          },
        },
        NOW,
      );
      expect(unlinkedRes.ok).toBe(false);
      expect(unlinkedRes.code).toBe('UNLINKED_PRINCIPAL');

      // GW-AT-018: Linked member without manage_gateway_route invokes /extalia bind -> refused.
      const viewerRes = await h.adapter.executeSlashCommand(
        {
          id: 'ix-bind-viewer',
          type: 2,
          application_id: 'app-900',
          token: 'tok-2',
          guild_id: 'guild-100',
          channel_id: 'chan-200',
          member: { user: { id: 'discord-viewer' } },
          data: {
            name: 'extalia',
            options: [{ name: 'bind', options: [{ name: 'workspace', value: 'ws-alpha' }] }],
          },
        },
        NOW,
      );
      expect(viewerRes.ok).toBe(false);
      expect(viewerRes.code).toBe('INSUFFICIENT_PERMISSION');

      const routeCountBefore = h.store.database.prepare('SELECT count(*) as c FROM gateway_routes').get() as { c: number };
      expect(routeCountBefore.c).toBe(0);

      // GW-AT-017: Authorized admin binds channel to registered workspace.
      const adminRes = await h.adapter.executeSlashCommand(
        {
          id: 'ix-bind-admin',
          type: 2,
          application_id: 'app-900',
          token: 'tok-3',
          guild_id: 'guild-100',
          channel_id: 'chan-200',
          member: { user: { id: 'discord-admin' } },
          data: {
            name: 'extalia',
            options: [{
              name: 'bind',
              options: [
                { name: 'workspace', value: 'ws-alpha' },
                { name: 'mode', value: 'thread-new-session' },
                { name: 'audience', value: 'team' },
              ],
            }],
          },
        },
        NOW,
      );
      expect(adminRes.ok).toBe(true);
      expect(adminRes.route?.workspaceId).toBe('ws-alpha');
      expect(adminRes.route?.policyRevision).toBe(1);
      expect(adminRes.content).toContain('Revision: `1`');
      expect(adminRes.content).toContain('Effective permissions:');

      // Unbind with stale revision must be rejected.
      const staleUnbind = await h.adapter.executeSlashCommand(
        {
          id: 'ix-unbind-stale',
          type: 2,
          application_id: 'app-900',
          token: 'tok-4',
          guild_id: 'guild-100',
          channel_id: 'chan-200',
          member: { user: { id: 'discord-admin' } },
          data: {
            name: 'extalia',
            options: [{ name: 'unbind', options: [{ name: 'revision', value: 99 }] }],
          },
        },
        LATER,
      );
      expect(staleUnbind.ok).toBe(false);
      expect(staleUnbind.code).toBe('STALE_ROUTE_REVISION');
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-019..022: forum/thread policy creation, ID-stable rename, archived/locked pause without blind unarchive, and deleted thread destination-lost preserving session', async () => {
    const h = await createTestHarness();
    try {
      h.linkPrincipal({
        externalActorId: 'discord-dev-1',
        extaliaPrincipalId: 'ext-dev-1',
        bands: ['submit_prompt', 'read_status'],
      });
      const workspaces = new Set(['ws-alpha', 'ws-beta']);

      // Forum route with `thread-new-session` policy (GW-AT-019).
      h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'forum-1',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });

      const created = await h.adapter.handleThreadCreated({
        eventId: 'ev-th-1',
        guildId: 'guild-100',
        parentChannelId: 'forum-1',
        threadId: 'post-901',
        name: 'Fix parser bug',
        ownerExternalActorId: 'discord-dev-1',
        now: NOW,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('expected thread created');
      expect(created.action).toBe('bound-new-session');
      expect(created.binding?.workspaceId).toBe('ws-alpha');
      const originalSessionId = created.binding!.sessionId!;

      // Explicit-only parent route does NOT auto-create a session.
      h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-explicit',
        workspaceId: 'ws-beta',
        mode: 'explicit-only',
        audience: 'team',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      const explicitThread = await h.adapter.handleThreadCreated({
        eventId: 'ev-th-2',
        guildId: 'guild-100',
        parentChannelId: 'chan-explicit',
        threadId: 'post-902',
        ownerExternalActorId: 'discord-dev-1',
        now: NOW,
      });
      expect(explicitThread.ok).toBe(true);
      if (explicitThread.ok) {
        expect(explicitThread.action).toBe('awaiting-explicit');
        expect(explicitThread.binding).toBeUndefined();
      }

      // GW-AT-020: Thread rename preserves exact same session binding (remote ID stable).
      const renamed = h.adapter.handleThreadUpdated({
        eventId: 'ev-th-rename',
        guildId: 'guild-100',
        parentChannelId: 'forum-1',
        threadId: 'post-901',
        name: 'Renamed: Parser regression investigation',
        archived: false,
        locked: false,
        now: LATER,
      });
      expect(renamed.status).toBe('unchanged-rename');
      expect(renamed.sessionId).toBe(originalSessionId);

      // GW-AT-021: Archived/locked thread pauses outbound; zero PATCH unarchive call and report send is blocked cleanly.
      const archived = h.adapter.handleThreadUpdated({
        eventId: 'ev-th-archive',
        guildId: 'guild-100',
        parentChannelId: 'forum-1',
        threadId: 'post-901',
        archived: true,
        locked: false,
        now: LATER,
      });
      expect(archived.status).toBe('paused-archived-or-locked');
      expect(h.recorded.some(r => r.method === 'PATCH')).toBe(false);

      h.outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: created.binding!.id,
        targetBindingRevision: created.binding!.policyRevision,
        reportOrSourceEventId: 'rpt-archived-1',
        reportId: 'rpt-archived-1',
        senderKind: 'gateway-system',
        format: 'report',
        messageClass: 'system-report',
        rawText: 'Knowledge report ready.',
        now: LATER,
      });
      const archivedSend = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'worker-1', now: LATER });
      expect(archivedSend.status).toBe('blocked');
      expect(h.recorded.length).toBe(0); // zero network calls or blind unarchive!

      // GW-AT-022: Thread deleted -> binding marked destination-lost, pending outbox cancelled, session preserved.
      const secondThread = await h.adapter.handleThreadCreated({
        eventId: 'ev-th-3',
        guildId: 'guild-100',
        parentChannelId: 'forum-1',
        threadId: 'post-903',
        ownerExternalActorId: 'discord-dev-1',
        now: LATER,
      });
      expect(secondThread.ok).toBe(true);
      if (!secondThread.ok || !secondThread.binding) throw new Error('expected binding');

      h.outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: secondThread.binding.id,
        targetBindingRevision: secondThread.binding.policyRevision,
        reportOrSourceEventId: 'ev-pending-del',
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: 'milestone',
        rawText: 'Build step 3 complete.',
        now: LATER,
      });

      const deleted = h.adapter.handleThreadDeleted({
        eventId: 'ev-th-del',
        guildId: 'guild-100',
        parentChannelId: 'forum-1',
        threadId: 'post-903',
        now: LATER,
      });
      expect(deleted.status).toBe('destination-lost');
      expect(deleted.sessionPreserved).toBe(true);
      expect(deleted.cancelledOutboxCount).toBe(1);
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-023, GW-AT-024, GW-AT-025 & spoofing guards: Lead/Worker portraits, mid-run revision updates, private/unreachable avatar URL refusal, and display-name guards', async () => {
    let endpointReachable = true;
    const h = await createTestHarness({
      publicAssetBaseUrl: 'https://assets.example.com/gateway/avatars',
      isAssetEndpointReachable: () => endpointReachable,
    });

    try {
      // Configure active channel webhook with opaque secretRef.
      h.secrets.put('keychain://extalia/gateway/discord/wh-chan-200', 'webhook-tok-200');
      h.adapter.registerManagedWebhook({
        webhookId: 'wh-200',
        guildId: 'guild-100',
        channelId: 'chan-200',
        secretRef: 'keychain://extalia/gateway/discord/wh-chan-200',
        state: 'active',
        createdAt: NOW,
      });

      const route = h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: new Set(['ws-alpha', 'ws-beta']),
        now: NOW,
      });
      const binding = h.routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        threadId: 'thread-500',
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: new Set(['ws-alpha', 'ws-beta']),
        now: NOW,
      });

      // Deterministic SVG & valid PNG rendering reflects saved CharacterAppearance traits.
      const leadLook = makeAppearance({ hairStyle: 'long-bangs', hairColor: '#2c1e16', skinTone: '#d9a684' });
      const workerLookA = makeAppearance({
        presentation: 'masculine',
        hairStyle: 'short-fade',
        hairColor: '#111827',
        skinTone: '#8d5524',
        outfit: 'technical',
        accessories: { glasses: 'round', watch: 'smart', earrings: 'none', bag: 'none', tie: false, badge: true, headphones: true },
      });

      const svgLead = renderHeadshotSvg(leadLook);
      const svgWorker = renderHeadshotSvg(workerLookA);
      expect(svgLead).toContain('#2c1e16');
      expect(svgLead).toContain('#d9a684');
      expect(svgLead).not.toBe(svgWorker);
      expect(svgLead).not.toMatch(/<script|\/Users\/|soul/i);

      const pngLead = renderHeadshotPng(leadLook);
      const pngWorker = renderHeadshotPng(workerLookA);
      expect(pngLead.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(pngLead.equals(renderHeadshotPng(leadLook))).toBe(true); // deterministic
      expect(pngLead.equals(pngWorker)).toBe(false);
      expect(computeAppearanceHash(leadLook)).not.toBe(computeAppearanceHash(workerLookA));

      const workerRoster: TeamMember[] = [
        { id: 'w-rev-1', name: 'Marcus Chen', role: 'Reviewer', models: ['gpt-5'] },
      ];
      const leadExport = h.portraits.exportLeadPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        leadName: 'Elena Vael',
        appearance: leadLook,
        profileRevision: 1,
        now: NOW,
      });
      const workerExportV1 = h.portraits.exportWorkerPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        workerAgentId: 'w-rev-1',
        sessionTeamMembers: workerRoster,
        appearances: { 'sess-alpha-1:w-rev-1': workerLookA },
        profileRevision: 1,
        now: NOW,
      });
      expect(leadExport.ok).toBe(true);
      expect(workerExportV1.ok).toBe(true);
      if (!leadExport.ok || !workerExportV1.ok) throw new Error('Expected portraits');

      // Same worker name in another workspace produces completely separate identity & asset (GW-FR-033).
      const otherWsWorker = h.portraits.exportWorkerPortrait({
        workspaceId: 'ws-beta',
        sessionId: 'sess-beta-9',
        workerAgentId: 'w-rev-beta',
        sessionTeamMembers: [{ id: 'w-rev-beta', name: 'Marcus Chen', role: 'Tester', models: ['gpt-5'] }],
        appearances: { 'sess-beta-9:w-rev-beta': leadLook },
        profileRevision: 1,
        now: NOW,
      });
      expect(otherWsWorker.ok).toBe(true);
      if (otherWsWorker.ok) {
        expect(otherWsWorker.identity.portraitAssetId).not.toBe(workerExportV1.identity.portraitAssetId);
        expect(otherWsWorker.identity.workspaceId).toBe('ws-beta');
      }

      // Unidentified worker not in active session roster falls back cleanly to gateway-system.
      const unknownWorker = h.portraits.exportWorkerPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        workerAgentId: 'w-ghost',
        sessionTeamMembers: workerRoster,
        appearances: {},
        now: NOW,
      });
      expect(unknownWorker.ok).toBe(false);
      if (!unknownWorker.ok) {
        expect(unknownWorker.code).toBe('UNIDENTIFIED_WORKER');
        expect(unknownWorker.fallbackSenderKind).toBe('gateway-system');
      }

      // GW-AT-023: Lead and Worker speak in same thread under distinct webhook usernames & HTTPS avatar URLs.
      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-lead-1',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'primary',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'Delegating review to Marcus.',
          at: NOW,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: leadExport.identity,
        now: NOW,
      });
      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-worker-1',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'w-rev-1',
          taskId: 'task-1',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'Found one edge case in route validation.',
          at: NOW,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: workerExportV1.identity,
        now: NOW,
      });

      const leadSent = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: NOW });
      const workerSentV1 = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', taskId: 'task-1', now: NOW });
      expect(leadSent.status).toBe('accepted');
      expect(workerSentV1.status).toBe('accepted');

      const webhookCalls = h.recorded.filter(r => r.url.includes('/webhooks/wh-200/'));
      expect(webhookCalls.length).toBe(2);
      expect(webhookCalls[0]!.url).toContain('wait=true');
      expect(webhookCalls[0]!.url).toContain('thread_id=thread-500');
      expect(webhookCalls[0]!.body?.username).toBe('Elena Vael');
      expect(String(webhookCalls[0]!.body?.avatar_url)).toMatch(/^https:\/\/assets\.example\.com\/gateway\/avatars\/.+\.png$/);
      expect(webhookCalls[1]!.body?.username).toBe('Marcus Chen');
      expect(webhookCalls[1]!.body?.avatar_url).not.toBe(webhookCalls[0]!.body?.avatar_url);

      // GW-AT-024: Mid-run roster/appearance update keeps old receipt snapshot intact while new message uses new revision.
      const workerLookV2 = makeAppearance({ ...workerLookA, hairColor: '#b45309', outfit: 'creative' });
      const workerExportV2 = h.portraits.exportWorkerPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        workerAgentId: 'w-rev-1',
        sessionTeamMembers: [{ id: 'w-rev-1', name: 'Marcus Chen-V2', role: 'Lead Reviewer', models: ['gpt-5'] }],
        appearances: { 'sess-alpha-1:w-rev-1': workerLookV2 },
        profileRevision: 2,
        now: LATER,
      });
      expect(workerExportV2.ok).toBe(true);
      if (!workerExportV2.ok) throw new Error('expected v2');
      expect(workerExportV2.identity.portraitRevision).not.toBe(workerExportV1.identity.portraitRevision);

      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-worker-2',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'w-rev-1',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'Updated review summary after patch.',
          at: LATER,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: workerExportV2.identity,
        now: LATER,
      });
      const workerSentV2 = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: LATER });
      expect(workerSentV2.status).toBe('accepted');

      // Historic v1 receipt retains original name & appearanceHash!
      if (workerSentV1.status === 'accepted' && workerSentV2.status === 'accepted') {
        expect(workerSentV1.receipt.senderSnapshot.name).toBe('Marcus Chen');
        expect(workerSentV1.receipt.senderSnapshot.portraitRevision).toBe(workerExportV1.identity.portraitRevision);
        expect(workerSentV2.receipt.senderSnapshot.name).toBe('Marcus Chen-V2');
        expect(workerSentV2.receipt.senderSnapshot.portraitRevision).toBe(workerExportV2.identity.portraitRevision);
      }

      // GW-AT-025: Refuse http://, localhost, 127.0.0.1, [::1], RFC1918 private IPs; graceful fallback when unreachable.
      for (const badUrl of [
        'http://assets.example.com/avatars',
        'https://localhost:8443/avatars',
        'https://127.0.0.1/avatars',
        'https://[::1]/avatars',
        'https://10.0.0.12/avatars',
        'https://172.16.4.1/avatars',
        'https://192.168.1.50/avatars',
        'https://169.254.169.254/latest',
      ]) {
        expect(validatePublicHttpsAssetBaseUrl(badUrl).ok).toBe(false);
      }

      endpointReachable = false;
      const unreachableUrl = h.portraits.resolveAvatarUrlForIdentity(leadExport.identity, LATER);
      expect(unreachableUrl.ok).toBe(false);
      if (!unreachableUrl.ok) {
        expect(unreachableUrl.fallbackIndicator).toBe(AVATAR_UNAVAILABLE_INDICATOR);
        expect(unreachableUrl.diagnostic).toBe(AVATAR_UNAVAILABLE_DIAGNOSTIC);
      }

      // Send while asset server unreachable: omits avatar_url (never leaks localhost), preserves agent name, labels fallback.
      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-lead-no-avatar',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'primary',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'Continuing with fallback indicator.',
          at: LATER,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: leadExport.identity,
        now: LATER,
      });
      await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: LATER });
      const lastCall = h.recorded[h.recorded.length - 1]!;
      expect(lastCall.body?.username).toBe('Elena Vael');
      expect(lastCall.body?.avatar_url).toBeUndefined();
      expect(String(lastCall.body?.content)).toContain(AVATAR_UNAVAILABLE_INDICATOR);

      // Asset TTL expiry and revocation.
      endpointReachable = true;
      expect(h.portraits.getAssetByToken(leadExport.asset.token, NOW)).toBeDefined();
      expect(h.portraits.getAssetByToken(leadExport.asset.token, AFTER_TTL)).toBeUndefined();
      expect(h.portraits.revokeAsset({ assetId: leadExport.asset.assetId, actor: 'admin', reason: 'rotate', now: NOW })).toBe(true);
      expect(h.portraits.getAssetByToken(leadExport.asset.token, NOW)).toBeUndefined();

      // Display-name spoofing guards.
      const spoofGateway = sanitizeDiscordAgentDisplayName('Extalia Gateway', { role: 'Reviewer', kind: 'worker' });
      expect(spoofGateway.guarded).toBe(true);
      expect(spoofGateway.displayName).toBe('Team Worker (Reviewer)');
      expect(spoofGateway.originalName).toBe('Extalia Gateway');

      const spoofDiscord = sanitizeDiscordAgentDisplayName('Official Discord Admin', { role: 'Scout', kind: 'worker' });
      expect(spoofDiscord.guarded).toBe(true);
      expect(spoofDiscord.displayName.toLowerCase()).not.toContain('discord');

      const overlong = sanitizeDiscordAgentDisplayName('A'.repeat(120), { kind: 'worker' });
      expect(overlong.guarded).toBe(true);
      expect(overlong.displayName.length).toBeLessThanOrEqual(80);
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-026, GW-AT-027, GW-AT-028 & GW-AT-030: tool-only events use system projection (no forged quotes); wait=true receipt resolves reply-to-worker via Lead; lost receipt refused', async () => {
    let workerStillActive = true;
    const leadTurns: Array<Record<string, unknown>> = [];
    const h = await createTestHarness({
      hostOverrides: {
        isWorkerActiveInSession: () => workerStillActive,
        submitLeadTurn: async payload => {
          leadTurns.push(payload as unknown as Record<string, unknown>);
          return { ok: true, hostActionId: `host-${payload.actionId}`, status: 'admitted' };
        },
      },
    });

    try {
      h.secrets.put('keychain://extalia/gateway/discord/wh-chan-200', 'webhook-tok-200');
      h.adapter.registerManagedWebhook({
        webhookId: 'wh-200',
        guildId: 'guild-100',
        channelId: 'chan-200',
        secretRef: 'keychain://extalia/gateway/discord/wh-chan-200',
        state: 'active',
        createdAt: NOW,
      });

      h.linkPrincipal({
        externalActorId: 'discord-reviewer-1',
        extaliaPrincipalId: 'ext-reviewer-1',
        bands: ['submit_prompt', 'read_status'],
      });

      const route = h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });
      const binding = h.routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        threadId: 'thread-700',
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });

      const workerPortrait = h.portraits.exportWorkerPortrait({
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        workerAgentId: 'w-1',
        sessionTeamMembers: [{ id: 'w-1', name: 'Iris Kael', role: 'Tester', models: ['gpt-5'] }],
        appearances: { 'sess-alpha-1:w-1': makeAppearance() },
        now: NOW,
      });
      if (!workerPortrait.ok) throw new Error('expected portrait');

      // GW-AT-026: Tool-only event (`worker-activity`) MUST NOT send as worker webhook persona.
      const toolEvent: GatewayProjectEvent = {
        sourceEventId: 'ev-tool-only-1',
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha-1',
        agentId: 'w-1',
        taskId: 'task-test-suite',
        category: 'worker-activity',
        provenance: 'runtime-observed',
        verification: 'unverified',
        safeText: 'Executed vitest on gateway suite (exit 0).',
        at: NOW,
      };
      const enqTool = h.adapter.enqueueProjectEvent({
        event: toolEvent,
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: workerPortrait.identity,
        now: NOW,
      });
      expect(enqTool.senderKind).toBe('gateway-system');

      await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', taskId: 'task-test-suite', now: NOW });
      const toolCall = h.recorded[h.recorded.length - 1]!;
      expect(toolCall.url).toContain('/channels/thread-700/messages'); // Bot identity, NOT webhook!
      expect(String(toolCall.body?.content)).toContain('[Observed activity]');

      // GW-AT-030: Real worker utterance sent via webhook with wait=true stores remoteMessageId receipt.
      h.adapter.enqueueProjectEvent({
        event: {
          sourceEventId: 'ev-worker-quote-1',
          workspaceId: 'ws-alpha',
          sessionId: 'sess-alpha-1',
          agentId: 'w-1',
          taskId: 'task-test-suite',
          category: 'agent-message',
          provenance: 'runtime-observed',
          verification: 'not-applicable',
          safeText: 'All 18 gateway checks passed.',
          at: NOW,
        },
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        portrait: workerPortrait.identity,
        now: NOW,
      });
      const sentWorker = await h.adapter.dispatchNextOutboxIntent({
        leaseOwner: 'w',
        runId: 'run-77',
        taskId: 'task-test-suite',
        now: NOW,
      });
      expect(sentWorker.status).toBe('accepted');
      if (sentWorker.status !== 'accepted') throw new Error('expected accepted');
      const storedMsgId = sentWorker.receipt.remoteMessageId;
      expect(storedMsgId).toMatch(/^wh-msg-/);

      // GW-AT-027: Reply to worker webhook message resolves receipt and delegates safely through Lead.
      const replyEvent: GatewayInboundEvent = {
        schema: 'extalia.gateway.inbound.v1',
        connectorId: 'conn-discord-1',
        provider: 'discord',
        providerEventId: 'msg:reply-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        threadId: 'thread-700',
        externalActorId: 'discord-reviewer-1',
        actorKind: 'human',
        remoteMessageId: 'reply-1',
        replyToRemoteMessageId: storedMsgId,
        kind: 'text',
        text: 'Please also add a negative test for revoked links.',
        receivedAt: LATER,
        authenticatedTransportReceipt: 'ws-sig:valid-reply-1',
      };
      const replyRes = await h.adapter.handleInboundReply({
        event: replyEvent,
        verifyTransportReceipt: () => true,
        now: LATER,
      });
      expect(replyRes.ok).toBe(true);
      if (replyRes.ok) {
        expect(replyRes.delegateViaLead).toBe(true);
        expect(replyRes.targetAgentId).toBe('w-1');
        expect(replyRes.targetTaskId).toBe('task-test-suite');
        expect(replyRes.sessionId).toBe('sess-alpha-1');
      }
      expect(leadTurns.length).toBe(1);
      expect((leadTurns[0]!.replyContext as Record<string, unknown>).delegateViaLead).toBe(true);

      // Inactive worker reply still delegates to Lead with explicit notice instead of silently spawning.
      workerStillActive = false;
      const inactiveReply = await h.adapter.handleInboundReply({
        event: { ...replyEvent, providerEventId: 'msg:reply-2', remoteMessageId: 'reply-2' },
        verifyTransportReceipt: () => true,
        now: LATER,
      });
      expect(inactiveReply.ok).toBe(true);
      if (inactiveReply.ok) {
        expect(inactiveReply.workerActive).toBe(false);
        expect(inactiveReply.notice).toMatch(/no longer active/i);
      }

      // GW-AT-028: Reply to a lost/missing webhook receipt is refused (never matched by display name).
      const lostReply = await h.adapter.handleInboundReply({
        event: {
          ...replyEvent,
          providerEventId: 'msg:reply-lost',
          remoteMessageId: 'reply-lost',
          replyToRemoteMessageId: 'non-existent-webhook-msg-999',
        },
        verifyTransportReceipt: () => true,
        now: LATER,
      });
      expect(lostReply.ok).toBe(false);
      if (!lostReply.ok) expect(lostReply.code).toBe('REPLY_RECEIPT_MISSING');
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-029 & GW-AT-032: 100 burst tool events coalesce adaptively, preserve critical transitions, strip thinking/secrets/paths/mentions, respect 429, and quarantine timeout as unknown', async () => {
    let mode: 'ok' | '429' | 'timeout' = 'ok';
    const h = await createTestHarness({
      fetchHandler: req => {
        if (mode === '429') {
          return jsonResponse({ message: 'You are being rate limited.', retry_after: 7 }, 429, { 'retry-after': '7' });
        }
        if (mode === 'timeout') {
          return Promise.reject(new Error('ETIMEDOUT socket hang up'));
        }
        if (req.method === 'PATCH') return jsonResponse({ id: 'live-card-1' });
        return jsonResponse({ id: 'live-card-1' });
      },
    });

    try {
      const route = h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });
      const binding = h.routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        threadId: 'thread-800',
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: new Set(['ws-alpha']),
        now: NOW,
      });

      // GW-AT-029: 100 rapid tool progress events over 2.5 s coalesce aggressively while preserving important transitions.
      const baseMs = Date.parse(NOW);
      const emittedUpdates = [];
      for (let seq = 1; seq <= 100; seq++) {
        const at = new Date(baseMs + seq * 25).toISOString();
        const upd = h.adapter.liveRunCoalescer.ingest({
          bindingId: binding.id,
          runId: 'run-burst-1',
          sequence: seq,
          category: 'worker-activity',
          provenance: 'runtime-observed',
          verification: 'unverified',
          agentName: 'Marcus Chen',
          agentRole: 'Reviewer',
          text: `Step ${seq}: @everyone check /Users/alice/private/repo <thinking>hidden chain of thought</thinking> [click](javascript:alert(1))`,
          state: 'running',
          activeWorkers: 2,
          at,
        });
        if (upd) {
          emittedUpdates.push(upd);
          await h.adapter.publishCoalescedLiveRunCard(upd, at);
        }
      }
      // Initial event flushes once; remaining 99 burst events within 2.5 s are coalesced (<= 2 flushes total).
      expect(emittedUpdates.length).toBeLessThanOrEqual(2);

      // Out-of-order lower sequence must be ignored.
      const staleSeq = h.adapter.liveRunCoalescer.ingest({
        bindingId: binding.id,
        runId: 'run-burst-1',
        sequence: 50,
        category: 'worker-activity',
        provenance: 'runtime-observed',
        verification: 'unverified',
        text: 'Stale old event',
        at: new Date(baseMs + 3000).toISOString(),
      });
      expect(staleSeq).toBeUndefined();

      // Terminal transition flushes immediately as an EDIT to the existing live card (never flooding new cards).
      const terminalUpd = h.adapter.liveRunCoalescer.ingest({
        bindingId: binding.id,
        runId: 'run-burst-1',
        sequence: 101,
        category: 'terminal',
        provenance: 'host-receipt',
        verification: 'verified',
        text: 'Suite finished with secret sk-proj-1234567890abcdefghijklmnop and @here', // extalia-allow-secret
        state: 'completed',
        activeWorkers: 0,
        at: new Date(baseMs + 3100).toISOString(),
      });
      expect(terminalUpd).toBeDefined();
      expect(terminalUpd!.isEdit).toBe(true);
      expect(terminalUpd!.remoteMessageId).toBe('live-card-1');

      // GW-AT-032: Verify mass mentions, thinking blocks, secrets, private paths, and unsafe markdown links stripped.
      expect(terminalUpd!.text).not.toContain('@everyone');
      expect(terminalUpd!.text).not.toContain('@here');
      expect(terminalUpd!.text).not.toContain('hidden chain of thought');
      expect(terminalUpd!.text).not.toContain('sk-proj-');
      expect(terminalUpd!.text).not.toContain('/Users/alice/');
      expect(terminalUpd!.text).not.toContain('javascript:');

      await h.adapter.publishCoalescedLiveRunCard(terminalUpd!, new Date(baseMs + 3100).toISOString());
      const patchCall = h.recorded.find(r => r.method === 'PATCH');
      expect(patchCall?.body?.allowed_mentions).toEqual({ parse: [] });

      // 429 Retry-After respect via outbox dispatch.
      mode = '429';
      const enq429 = h.outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        reportOrSourceEventId: 'ev-rate-limit-1',
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: 'milestone',
        rawText: 'Rate limited test.',
        now: NOW,
      });
      const res429 = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: NOW });
      expect(res429.status).toBe('rate-limited');
      expect(h.outbox.getIntent(enq429.intent.id)?.retryAfterAt).toBe('2026-11-24T15:00:07.000Z');

      // Timeout after dispatch -> quarantined as `unknown` (zero blind resend!).
      mode = 'timeout';
      const enqTimeout = h.outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        reportOrSourceEventId: 'ev-timeout-1',
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: 'terminal',
        rawText: 'Terminal result facing network timeout.',
        now: LATER,
      });
      const resTimeout = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: LATER });
      expect(resTimeout.status).toBe('unknown');
      expect(h.outbox.getIntent(enqTimeout.intent.id)?.state).toBe('unknown');
      // Subsequent claim must NOT pick up the quarantined `unknown` intent.
      const nextClaim = await h.adapter.dispatchNextOutboxIntent({ leaseOwner: 'w', now: LATER });
      expect(nextClaim.status).not.toBe('accepted');
      expect(h.outbox.getIntent(enqTimeout.intent.id)?.state).toBe('unknown');
    } finally {
      h.store.close();
    }
  });

  it('GW-AT-031, GW-AT-033 & GW-AT-034: Ed25519 auth, deferred interaction followup without username override, guild-leave isolation, and full slash commands without Message Content Intent', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const publicKeyHex = pubDer.subarray(pubDer.length - 32).toString('hex');

    const h = await createTestHarness({ publicKeyHex });
    try {
      // GW-AT-034: Adapter minimal intents never request Message Content Intent.
      expect((h.adapter.getMinimalGatewayIntents() & DISCORD_MESSAGE_CONTENT_INTENT_BIT)).toBe(0);

      // Ed25519 signed HTTP interaction verification & forged signature refusal.
      const ixPayload: DiscordInteractionPayload = {
        id: 'ix-signed-1',
        type: 2,
        application_id: 'app-900',
        token: 'ix-followup-token-1',
        guild_id: 'guild-100',
        channel_id: 'chan-200',
        member: { user: { id: 'discord-ops' } },
        data: { name: 'extalia', options: [{ name: 'help' }] },
      };
      const rawBody = JSON.stringify(ixPayload);
      const ts = String(Math.floor(Date.parse(NOW) / 1000));
      const validSig = cryptoSign(null, Buffer.from(`${ts}${rawBody}`, 'utf8'), privateKey).toString('hex');

      await expect(
        h.adapter.authenticateInbound({
          connectorId: 'conn-discord-1',
          provider: 'discord',
          receivedAt: NOW,
          authenticatedTransportReceipt: 'http-ix',
          headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': ts },
          rawBody,
        }),
      ).rejects.toThrow(/Unauthenticated/);

      const verifiedBatch = await h.adapter.authenticateInbound({
        connectorId: 'conn-discord-1',
        provider: 'discord',
        receivedAt: NOW,
        authenticatedTransportReceipt: 'http-ix',
        headers: { 'x-signature-ed25519': validSig, 'x-signature-timestamp': ts },
        rawBody,
      });
      const normalized = h.adapter.normalize(verifiedBatch);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]!.kind).toBe('command');

      // GW-AT-031: Immediate deferred ACK + interaction followup NEVER sets username or avatar_url override.
      const { ack, followupPromise } = h.adapter.handleInteraction(ixPayload, NOW);
      expect(ack.type).toBe(5);
      const followup = await followupPromise!;
      expect(followup.commandResult.ok).toBe(true);
      const followupCall = h.recorded.find(r => r.url.includes('/webhooks/app-900/ix-followup-token-1'));
      expect(followupCall).toBeDefined();
      expect(followupCall!.body?.username).toBeUndefined();
      expect(followupCall!.body?.avatar_url).toBeUndefined();
      expect(followupCall!.body?.allowed_mentions).toEqual({ parse: [] });

      // GW-AT-034: Exercise all slash commands with linked principal & zero Message Content Intent.
      h.linkPrincipal({
        externalActorId: 'discord-ops',
        extaliaPrincipalId: 'ext-ops',
        bands: [
          'manage_gateway_route',
          'submit_prompt',
          'manage_own_session',
          'read_status',
          'manage_schedule',
          'view_reports',
        ],
      });

      const makeCmd = (sub: string, options: Array<{ name: string; value: string | number }> = []): DiscordInteractionPayload => ({
        id: `ix-cmd-${sub}`,
        type: 2,
        application_id: 'app-900',
        token: `tok-${sub}`,
        guild_id: 'guild-100',
        channel_id: 'chan-200',
        member: { user: { id: 'discord-ops' } },
        data: { name: 'extalia', options: [{ name: sub, options }] },
      });

      expect((await h.adapter.executeSlashCommand(makeCmd('connect'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('bind', [{ name: 'workspace', value: 'ws-alpha' }]), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('new'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('session'), NOW)).ok).toBe(true);
      // Cross-workspace session switch must be refused.
      expect((await h.adapter.executeSlashCommand(makeCmd('session', [{ name: 'id', value: 'sess-ws-beta-existing' }]), NOW)).ok).toBe(false);
      expect((await h.adapter.executeSlashCommand(makeCmd('status'), NOW)).ok).toBe(true);
      const teamRes = await h.adapter.executeSlashCommand(makeCmd('team'), NOW);
      expect(teamRes.ok).toBe(true);
      expect(teamRes.content).toContain('Marcus Chen');
      expect(teamRes.content).not.toContain('TOP-SECRET-INTERNAL-SOUL-PROMPT'); // soul never leaked!
      expect((await h.adapter.executeSlashCommand(makeCmd('tasks'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('schedule'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('reports'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('cancel'), NOW)).ok).toBe(true);
      expect((await h.adapter.executeSlashCommand(makeCmd('pause'), NOW)).ok).toBe(true);

      // GW-AT-033: Bot leaves guild-100 -> all guild-100 routes/bindings disabled; guild-200 stays intact with zero leak.
      const guild200Route = h.routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-200',
        channelId: 'chan-other',
        workspaceId: 'ws-beta',
        mode: 'reuse-pinned',
        audience: 'team',
        registeredWorkspaceIds: new Set(['ws-alpha', 'ws-beta']),
        now: NOW,
      });
      h.adapter.registerManagedWebhook({
        webhookId: 'wh-g100',
        guildId: 'guild-100',
        channelId: 'chan-200',
        secretRef: 'keychain://extalia/gateway/discord/wh-g100',
        state: 'active',
        createdAt: NOW,
      });

      const removed = h.adapter.handleGuildRemoved({ guildId: 'guild-100', now: LATER });
      expect(removed.disabledRoutes).toBeGreaterThanOrEqual(1);
      expect(removed.disabledBindings).toBeGreaterThanOrEqual(1);
      expect(removed.disabledWebhooks).toBe(1);
      expect(h.adapter.getChannelWebhook('chan-200')).toBeUndefined();

      // guild-100 route resolution fails closed; guild-200 route remains active.
      const g100Resolve = h.routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        registeredWorkspaceIds: new Set(['ws-alpha', 'ws-beta']),
      });
      expect(g100Resolve.ok).toBe(false);
      const g200Resolve = h.routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-200',
        channelId: 'chan-other',
        registeredWorkspaceIds: new Set(['ws-alpha', 'ws-beta']),
      });
      expect(g200Resolve.ok).toBe(true);
      if (g200Resolve.ok) expect(g200Resolve.route.id).toBe(guild200Route.id);

      // 5-dimension connector health check.
      const health = await h.adapter.health();
      expect(health.provider).toBe('discord');
      expect(health.transport.status).toBe('healthy');
      expect(health.host.status).toBe('healthy');
    } finally {
      h.store.close();
    }
  });
});
