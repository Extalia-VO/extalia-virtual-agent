import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSystemReport } from '@extalia/platform';
import {
  GatewayOutboxService,
  GatewayRoutingService,
  GatewayStore,
} from '../src/gateway/index.js';
import {
  evaluateTelegramMedia,
  formatTelegramText,
  isTelegramAnonymousAdmin,
  isTelegramForwardedMessage,
  parseTelegramCommand,
  renderTelegramAutonomousReport,
  renderTelegramHeartbeat,
  shouldEmitTelegramUpdate,
  TELEGRAM_ANONYMOUS_ADMIN_BOT_ID,
  TELEGRAM_COMMANDS,
  TelegramGatewayAdapter,
  TelegramTransportError,
  type TelegramFetch,
  type TelegramMessage,
  type TelegramUpdate,
} from '../src/gateway/telegram.js';

const T0 = '2026-11-24T10:00:00.000Z';
const T1 = '2026-11-24T10:05:00.000Z';
const T2 = '2026-11-24T10:12:00.000Z';
const T3 = '2026-11-24T10:45:00.000Z';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extalia-gw-tg-'));
  tempDirs.push(dir);
  return path.join(dir, 'state', 'gateway.sqlite');
}

function makeMockFetch(
  handler: (method: string, body?: Record<string, unknown>) => { ok: boolean; status: number; json: unknown },
): { fetchImpl: TelegramFetch; calls: Array<{ method: string; body?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const fetchImpl: TelegramFetch = async (url, init) => {
    const method = url.split('/').pop() ?? '';
    const parsedBody = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, body: parsedBody });
    const res = handler(method, parsedBody);
    return {
      ok: res.ok,
      status: res.status,
      async json() {
        return res.json;
      },
    };
  };
  return { fetchImpl, calls };
}

function linkUser(
  routing: GatewayRoutingService,
  connectorId: string,
  botId: string,
  externalActorId: string,
  extaliaPrincipalId: string,
  permissionBands: Array<
    | 'read_status'
    | 'view_reports'
    | 'submit_prompt'
    | 'manage_own_session'
    | 'manage_schedule'
    | 'manage_gateway_route'
    | 'approve_sensitive_action'
  >,
): void {
  const challenge = routing.principalLinks.issueChallenge({
    connectorId,
    extaliaPrincipalId,
    permissionBands,
    now: T0,
  });
  const proof = routing.principalLinks.submitExternalProof({
    connectorId,
    providerAccountId: botId,
    externalActorId,
    actorKind: 'human',
    code: challenge.code,
    now: T0,
  });
  expect(proof.ok).toBe(true);
  const confirmed = routing.principalLinks.confirmLink({
    challengeId: challenge.challengeId,
    extaliaPrincipalId,
    now: T0,
  });
  expect(confirmed.ok).toBe(true);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Gateway M2 Telegram Bot API Adapter (GW-AT-036..055)', () => {
  it('GW-AT-036 & GW-AT-039: verifies & pins bot identity via getMe, hides raw token, and refuses enabling both webhook and polling', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const { fetchImpl } = makeMockFetch(method => {
        if (method === 'getMe') {
          return {
            ok: true,
            status: 200,
            json: {
              ok: true,
              result: { id: 900100200, is_bot: true, username: 'extalia_test_bot', first_name: 'Extalia Test' },
            },
          };
        }
        return { ok: false, status: 404, json: { ok: false, error_code: 404, description: 'not found' } };
      });

      const adapter = new TelegramGatewayAdapter({
        store,
        resolveBotToken: ref => (ref === 'keychain:tg-main' ? 'synthetic-token-value-001' : ''),
        fetchImpl,
        now: () => T0,
      });

      // Raw token passed as secretRef must be rejected.
      await expect(
        adapter.verifyAndConfigureConnector({
          connectorId: 'conn-tg-1',
          secretRef: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
          transportMode: 'webhook',
          webhookSecretToken: 'webhook-secret-token-12345',
          now: T0,
        }),
      ).rejects.toThrow(/opaque secret store reference/i);

      // Valid opaque secretRef verifies and pins bot identity.
      const configured = await adapter.verifyAndConfigureConnector({
        connectorId: 'conn-tg-1',
        secretRef: 'keychain:tg-main',
        transportMode: 'webhook',
        webhookSecretToken: 'webhook-secret-token-12345',
        now: T0,
      });

      expect(configured.identity.botId).toBe('900100200');
      expect(configured.identity.username).toBe('extalia_test_bot');
      expect(configured.transport.transportMode).toBe('webhook');

      const storedConnector = store.getConnector('conn-tg-1');
      expect(storedConnector?.secretRef).toBe('keychain:tg-main');
      expect(storedConnector?.providerAccountId).toBe('900100200');
      expect(JSON.stringify(storedConnector)).not.toContain('synthetic-token-value-001');

      // GW-AT-039: Attempting to enable polling simultaneously is refused.
      await expect(
        adapter.verifyAndConfigureConnector({
          connectorId: 'conn-tg-1',
          secretRef: 'keychain:tg-main',
          transportMode: 'polling',
          now: T0,
        }),
      ).rejects.toThrow(TelegramTransportError);

      await expect(
        adapter.pollUpdates({
          connectorId: 'conn-tg-1',
          leaseOwner: 'host-a',
          onUpdate: () => ({ durablyAdmitted: true }),
          now: T0,
        }),
      ).rejects.toThrow(/locked to "webhook"/i);

      const health = await adapter.health();
      expect(health.provider).toBe('telegram');
      expect(health.transport.status).toBe('healthy');
    } finally {
      store.close();
    }
  });

  it('GW-AT-037: rejects webhook requests with wrong secret header or oversized payload with zero inbox admission', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const { fetchImpl } = makeMockFetch(() => ({
        ok: true,
        status: 200,
        json: { ok: true, result: { id: 900100200, is_bot: true, username: 'extalia_test_bot' } },
      }));

      const adapter = new TelegramGatewayAdapter({
        store,
        resolveBotToken: () => 'synthetic-token-value-002',
        fetchImpl,
        now: () => T0,
      });

      await adapter.verifyAndConfigureConnector({
        connectorId: 'conn-tg-wh',
        secretRef: 'keychain:tg-wh',
        transportMode: 'webhook',
        webhookSecretToken: 'super-secret-webhook-header-token',
        maxWebhookBodyBytes: 2048,
        now: T0,
      });

      const validPayload = JSON.stringify({
        update_id: 501,
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: 777, type: 'private' },
          from: { id: 42, is_bot: false },
          text: '/status',
        },
      });

      // Wrong secret header -> rejected.
      await expect(
        adapter.authenticateInbound({
          connectorId: 'conn-tg-wh',
          provider: 'telegram',
          receivedAt: T0,
          authenticatedTransportReceipt: 'unverified',
          headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret-token-value-00000' },
          rawBody: validPayload,
        }),
      ).rejects.toThrow(/Invalid or missing X-Telegram-Bot-Api-Secret-Token/i);

      // Oversized payload -> rejected.
      await expect(
        adapter.authenticateInbound({
          connectorId: 'conn-tg-wh',
          provider: 'telegram',
          receivedAt: T0,
          authenticatedTransportReceipt: 'unverified',
          headers: { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook-header-token' },
          rawBody: 'x'.repeat(4096),
        }),
      ).rejects.toThrow(/exceeds maximum allowed size/i);

      // Valid secret header -> verified batch.
      const batch = await adapter.authenticateInbound({
        connectorId: 'conn-tg-wh',
        provider: 'telegram',
        receivedAt: T0,
        authenticatedTransportReceipt: 'pending',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook-header-token' },
        rawBody: validPayload,
      });
      expect(batch.events).toHaveLength(1);
      const events = adapter.normalize(batch);
      expect(events).toHaveLength(1);
      expect(adapter.verifyTransportReceipt(events[0]!)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('GW-AT-038: commits polling offset only after durable inbox admission and deduplicates replayed update_id across restarts', async () => {
    const dbFile = createTempDbPath();
    const store1 = await GatewayStore.open(dbFile);
    const registeredWorkspaces = new Set(['ws-alpha']);

    const updatesToReturn: TelegramUpdate[] = [
      {
        update_id: 1001,
        message: {
          message_id: 21,
          date: 1700000000,
          chat: { id: 555, type: 'private' },
          from: { id: 88, is_bot: false },
          text: 'Run tests please',
        },
      },
      {
        update_id: 1002,
        message: {
          message_id: 22,
          date: 1700000010,
          chat: { id: 555, type: 'private' },
          from: { id: 88, is_bot: false },
          text: 'Second message',
        },
      },
    ];

    try {
      const routing1 = new GatewayRoutingService(store1);
      const { fetchImpl } = makeMockFetch(method => {
        if (method === 'getMe') {
          return { ok: true, status: 200, json: { ok: true, result: { id: 9001, is_bot: true, username: 'extalia_poll_bot' } } };
        }
        if (method === 'getUpdates') {
          return { ok: true, status: 200, json: { ok: true, result: updatesToReturn } };
        }
        return { ok: false, status: 404, json: { ok: false } };
      });

      const adapter1 = new TelegramGatewayAdapter({
        store: store1,
        routing: routing1,
        resolveBotToken: () => 'synthetic-poll-token',
        fetchImpl,
        now: () => T0,
      });

      await adapter1.verifyAndConfigureConnector({
        connectorId: 'conn-tg-poll',
        secretRef: 'keychain:tg-poll',
        transportMode: 'polling',
        leaseOwner: 'host-1',
        now: T0,
      });

      linkUser(routing1, 'conn-tg-poll', '9001', '88', 'usr-1', ['submit_prompt', 'read_status']);
      const route = routing1.createRoute({
        connectorId: 'conn-tg-poll',
        providerAccountId: '9001',
        channelId: '555',
        workspaceId: 'ws-alpha',
        mode: 'reuse-pinned',
        audience: 'private',
        registeredWorkspaceIds: registeredWorkspaces,
        now: T0,
      });
      routing1.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: registeredWorkspaces,
        now: T0,
      });

      // First poll: admit update 1001, simulate crash/failure before update 1002 admission -> offset stops at 1002.
      const firstRun = await adapter1.pollUpdates({
        connectorId: 'conn-tg-poll',
        leaseOwner: 'host-1',
        onUpdate: ({ update, normalized }) => {
          if (update.update_id === 1002) {
            return { durablyAdmitted: false };
          }
          const admitted = routing1.admitInboundEvent({
            rawEvent: normalized[0]!,
            verifyTransportReceipt: ev => adapter1.verifyTransportReceipt(ev),
            registeredWorkspaceIds: registeredWorkspaces,
            now: T0,
          });
          return { durablyAdmitted: admitted.ok };
        },
        now: T0,
      });

      expect(firstRun.admittedCount).toBe(1);
      expect(firstRun.committedOffset).toBe(1002);

      // Competing polling leader is rejected while lease is active.
      await expect(
        adapter1.pollUpdates({
          connectorId: 'conn-tg-poll',
          leaseOwner: 'host-2',
          onUpdate: () => ({ durablyAdmitted: true }),
          now: T0,
        }),
      ).rejects.toThrow(/polling lease is held/i);
    } finally {
      store1.close();
    }

    // Reopen SQLite after simulated restart: offset 1002 persisted, and replaying update 1001 deduplicates to 1 action.
    const store2 = await GatewayStore.open(dbFile);
    try {
      const routing2 = new GatewayRoutingService(store2);
      const { fetchImpl } = makeMockFetch(method => {
        if (method === 'getUpdates') {
          return { ok: true, status: 200, json: { ok: true, result: updatesToReturn } };
        }
        return { ok: false, status: 404, json: { ok: false } };
      });
      const adapter2 = new TelegramGatewayAdapter({
        store: store2,
        routing: routing2,
        resolveBotToken: () => 'synthetic-poll-token',
        fetchImpl,
        now: () => T1,
      });

      expect(adapter2.getTransportState('conn-tg-poll')?.committedOffset).toBe(1002);

      const statuses: string[] = [];
      const replayRun = await adapter2.pollUpdates({
        connectorId: 'conn-tg-poll',
        leaseOwner: 'host-1',
        onUpdate: ({ normalized }) => {
          const res = routing2.admitInboundEvent({
            rawEvent: normalized[0]!,
            verifyTransportReceipt: ev => adapter2.verifyTransportReceipt(ev),
            registeredWorkspaceIds: registeredWorkspaces,
            now: T1,
          });
          if (res.ok) statuses.push(res.status);
          return { durablyAdmitted: res.ok };
        },
        now: T1,
      });

      expect(replayRun.committedOffset).toBe(1003);
      expect(statuses).toEqual(['duplicate', 'admitted']);
    } finally {
      store2.close();
    }
  });

  it('GW-AT-040..046: enforces DM session selection, topic isolation, group privacy mode, anonymous/forwarded refusal, and worker reply via Lead', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const routing = new GatewayRoutingService(store);
      const { fetchImpl } = makeMockFetch(() => ({
        ok: true,
        status: 200,
        json: { ok: true, result: { id: 9002, is_bot: true, username: 'extalia_ops_bot' } },
      }));
      const adapter = new TelegramGatewayAdapter({
        store,
        routing,
        resolveBotToken: () => 'synthetic-ops-token',
        fetchImpl,
        now: () => T0,
      });

      await adapter.verifyAndConfigureConnector({
        connectorId: 'conn-tg-ops',
        secretRef: 'keychain:tg-ops',
        transportMode: 'webhook',
        webhookSecretToken: 'ops-webhook-secret-token-9999',
        now: T0,
      });

      const registered = new Set(['ws-a', 'ws-b']);
      linkUser(routing, 'conn-tg-ops', '9002', '101', 'usr-alice', [
        'read_status',
        'submit_prompt',
        'manage_own_session',
        'manage_gateway_route',
      ]);

      // GW-AT-040: Private DM without selected session asks user selection instead of guessing.
      const dmCheck = adapter.resolvePrivateDmSessionSelection({
        connectorId: 'conn-tg-ops',
        chatId: 'dm-101',
        eligibleSessionCount: 2,
      });
      expect(dmCheck.ok).toBe(false);
      if (!dmCheck.ok) {
        expect(dmCheck.code).toBe('SESSION_SELECTION_REQUIRED');
        expect(dmCheck.prompt).toContain('/sessions');
      }

      // GW-AT-041: /sessions lists only currently authorized sessions for the workspace with nonce callbacks.
      const sessionsRes = await adapter.handleCommand({
        connectorId: 'conn-tg-ops',
        chatId: 'dm-101',
        chatType: 'private',
        externalActorId: '101',
        command: 'sessions',
        args: '',
        now: T0,
        registeredWorkspaceIds: registered,
        currentWorkspaceId: 'ws-a',
        currentPolicyRevision: 2,
        authorizedSessions: [
          { id: 'sess-a1', workspaceId: 'ws-a', title: 'Alpha Build', state: 'active' },
          { id: 'sess-b1', workspaceId: 'ws-b', title: 'Beta Secret', state: 'active' },
          { id: 'sess-unreg', workspaceId: 'ws-unregistered', title: 'Ghost', state: 'active' },
        ],
      });
      expect(sessionsRes.ok).toBe(true);
      expect(sessionsRes.text).toContain('sess-a1');
      expect(sessionsRes.text).not.toContain('sess-b1');
      expect(sessionsRes.text).not.toContain('sess-unreg');
      expect(sessionsRes.callbackTokens).toHaveLength(1);
      expect(sessionsRes.callbackTokens![0]!.callbackData.length).toBeLessThanOrEqual(64);

      // GW-AT-042 & GW-AT-043: Strict topic isolation in forum supergroups and topic-enabled DMs vs plain DM.
      const routeTopicA = routing.createRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: '-100500',
        threadId: '11',
        workspaceId: 'ws-a',
        mode: 'reuse-pinned',
        audience: 'team',
        registeredWorkspaceIds: registered,
        now: T0,
      });
      const routeTopicB = routing.createRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: '-100500',
        threadId: '22',
        workspaceId: 'ws-b',
        mode: 'reuse-pinned',
        audience: 'team',
        registeredWorkspaceIds: registered,
        now: T0,
      });
      const routePlainDm = routing.createRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: 'dm-101',
        workspaceId: 'ws-a',
        mode: 'reuse-pinned',
        audience: 'private',
        registeredWorkspaceIds: registered,
        now: T0,
      });
      const routeTopicDm = routing.createRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: 'dm-101',
        threadId: '99',
        workspaceId: 'ws-b',
        mode: 'reuse-pinned',
        audience: 'private',
        registeredWorkspaceIds: registered,
        now: T0,
      });

      const resolvedTopicA = routing.resolveRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: '-100500',
        threadId: '11',
        registeredWorkspaceIds: registered,
      });
      const resolvedTopicB = routing.resolveRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: '-100500',
        threadId: '22',
        registeredWorkspaceIds: registered,
      });
      const resolvedPlainDm = routing.resolveRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: 'dm-101',
        registeredWorkspaceIds: registered,
      });
      const resolvedTopicDm = routing.resolveRoute({
        connectorId: 'conn-tg-ops',
        providerAccountId: '9002',
        channelId: 'dm-101',
        threadId: '99',
        registeredWorkspaceIds: registered,
      });

      expect(resolvedTopicA.ok && resolvedTopicA.route.id).toBe(routeTopicA.id);
      expect(resolvedTopicA.ok && resolvedTopicA.route.workspaceId).toBe('ws-a');
      expect(resolvedTopicB.ok && resolvedTopicB.route.id).toBe(routeTopicB.id);
      expect(resolvedTopicB.ok && resolvedTopicB.route.workspaceId).toBe('ws-b');
      expect(resolvedPlainDm.ok && resolvedPlainDm.route.id).toBe(routePlainDm.id);
      expect(resolvedPlainDm.ok && resolvedPlainDm.route.workspaceId).toBe('ws-a');
      expect(resolvedTopicDm.ok && resolvedTopicDm.route.id).toBe(routeTopicDm.id);
      expect(resolvedTopicDm.ok && resolvedTopicDm.route.workspaceId).toBe('ws-b');

      // GW-AT-044: Group privacy mode ON ignores ordinary chatter and admits commands/mentions/replies.
      const chatterMsg: TelegramMessage = {
        message_id: 300,
        date: 1700000000,
        chat: { id: -100500, type: 'supergroup', is_forum: true },
        from: { id: 101, is_bot: false },
        message_thread_id: 11,
        text: 'hey team what is for lunch today?',
      };
      const mentionMsg: TelegramMessage = {
        ...chatterMsg,
        message_id: 301,
        text: '@extalia_ops_bot check build status',
      };
      const otherBotCmdMsg: TelegramMessage = {
        ...chatterMsg,
        message_id: 302,
        text: '/status@some_other_bot',
      };
      const replyToBotMsg: TelegramMessage = {
        ...chatterMsg,
        message_id: 303,
        text: 'please re-run that step',
        reply_to_message: {
          message_id: 250,
          date: 1700000000,
          chat: { id: -100500, type: 'supergroup' },
          from: { id: 9002, is_bot: true, username: 'extalia_ops_bot' },
          text: '[Worker: Builder] Build step finished',
        },
      };

      const batch = {
        connectorId: 'conn-tg-ops',
        provider: 'telegram' as const,
        authenticatedTransportReceipt: adapter.signTransportReceipt('conn-tg-ops', 'webhook', '0123456789abcdef0123456789abcdef'),
        receivedAt: T0,
        events: [
          { update_id: 2001, message: chatterMsg },
          { update_id: 2002, message: mentionMsg },
          { update_id: 2003, message: otherBotCmdMsg },
          { update_id: 2004, message: replyToBotMsg },
        ] as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>,
      };

      const normalized = adapter.normalize(batch);
      expect(normalized.map(e => e.remoteMessageId)).toEqual(['301', '303']);
      expect(parseTelegramCommand('/status@extalia_ops_bot', 'extalia_ops_bot')?.command).toBe('status');
      expect(parseTelegramCommand('/status@other_bot', 'extalia_ops_bot')).toBeNull();

      // GW-AT-045: Anonymous group admin and forwarded sender impersonation rejected.
      const anonMsg: TelegramMessage = {
        message_id: 304,
        date: 1700000000,
        chat: { id: -100500, type: 'supergroup' },
        from: { id: TELEGRAM_ANONYMOUS_ADMIN_BOT_ID, is_bot: true, username: 'GroupAnonymousBot' },
        sender_chat: { id: -100500, type: 'supergroup' },
        text: '/bind ws-a',
      };
      expect(isTelegramAnonymousAdmin(anonMsg)).toBe(true);
      const anonCmd = await adapter.handleCommand({
        connectorId: 'conn-tg-ops',
        chatId: '-100500',
        chatType: 'supergroup',
        externalActorId: String(TELEGRAM_ANONYMOUS_ADMIN_BOT_ID),
        isAnonymousAdmin: true,
        command: 'bind',
        args: 'ws-a',
        now: T0,
        registeredWorkspaceIds: registered,
      });
      expect(anonCmd.ok).toBe(false);
      expect(anonCmd.code).toBe('ANONYMOUS_ADMIN_REFUSED');

      const forwardedMsg: TelegramMessage = {
        message_id: 305,
        date: 1700000000,
        chat: { id: 999, type: 'private' },
        from: { id: 202, is_bot: false }, // unlinked attacker
        forward_from: { id: 101, is_bot: false }, // linked victim
        text: '/bind ws-a',
      };
      expect(isTelegramForwardedMessage(forwardedMsg)).toBe(true);
      const fwdEvents = adapter.normalize({
        ...batch,
        events: [{ update_id: 2005, message: forwardedMsg }] as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>,
      });
      // Attribution MUST stay on current actor (202), NEVER inherited from forward_from (101).
      expect(fwdEvents[0]?.externalActorId).toBe('202');

      // GW-AT-046: Reply to worker summary resolves via stored remoteMessageId receipt routed through Lead.
      routing.recordRemoteReceipt({
        provider: 'telegram',
        connectorId: 'conn-tg-ops',
        remoteMessageId: '250',
        providerAccountId: '9002',
        channelId: '-100500',
        threadId: '11',
        workspaceId: 'ws-a',
        sessionId: 'sess-a1',
        agentId: 'worker-builder',
        taskId: 'task-42',
        senderSnapshot: { name: 'Builder', role: 'Build Engineer' },
        acceptedAt: T0,
      });

      const replyTarget = adapter.resolveWorkerReplyContext({
        connectorId: 'conn-tg-ops',
        replyToRemoteMessageId: '250',
        expectedWorkspaceId: 'ws-a',
      });
      expect(replyTarget.ok).toBe(true);
      if (replyTarget.ok) {
        expect(replyTarget.delegateViaLead).toBe(true);
        expect(replyTarget.receipt.taskId).toBe('task-42');
        expect(replyTarget.receipt.agentId).toBe('worker-builder');
      }

      // Cross-workspace reply to the same receipt is refused.
      const crossWsReply = adapter.resolveWorkerReplyContext({
        connectorId: 'conn-tg-ops',
        replyToRemoteMessageId: '250',
        expectedWorkspaceId: 'ws-b',
      });
      expect(crossWsReply.ok).toBe(false);
    } finally {
      store.close();
    }
  });

  it('GW-AT-047, GW-AT-048, GW-AT-049: enforces one-time callback nonces, honest /cancel, full 18 commands, and immutable post-admission edits', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const routing = new GatewayRoutingService(store);
      const { fetchImpl } = makeMockFetch(() => ({
        ok: true,
        status: 200,
        json: { ok: true, result: { id: 9003, is_bot: true, username: 'extalia_cmd_bot' } },
      }));
      const adapter = new TelegramGatewayAdapter({
        store,
        routing,
        resolveBotToken: () => 'synthetic-cmd-token',
        fetchImpl,
        now: () => T0,
      });

      await adapter.verifyAndConfigureConnector({
        connectorId: 'conn-tg-cmd',
        secretRef: 'keychain:tg-cmd',
        transportMode: 'webhook',
        webhookSecretToken: 'cmd-webhook-secret-token-7777',
        now: T0,
      });

      linkUser(routing, 'conn-tg-cmd', '9003', '303', 'usr-bob', [
        'read_status',
        'view_reports',
        'submit_prompt',
        'manage_own_session',
        'manage_schedule',
        'manage_gateway_route',
      ]);

      // Verify all 18 commands exist in the exported inventory.
      expect(TELEGRAM_COMMANDS).toHaveLength(18);

      // GW-AT-047: Single-use opaque callback nonce bound to actor, destination, revision, expiry.
      const issued = adapter.issueCallbackAction({
        connectorId: 'conn-tg-cmd',
        actorExternalId: '303',
        chatId: 'dm-303',
        workspaceId: 'ws-a',
        sessionId: 'sess-1',
        action: 'use-session',
        policyRevision: 3,
        ttlSeconds: 120,
        now: T0,
      });

      // Wrong actor rejected.
      const wrongActor = adapter.consumeCallbackAction({
        connectorId: 'conn-tg-cmd',
        callbackData: issued.callbackData,
        actorExternalId: '999',
        chatId: 'dm-303',
        currentPolicyRevision: 3,
        now: T0,
      });
      expect(wrongActor.ok).toBe(false);
      if (!wrongActor.ok) expect(wrongActor.code).toBe('CALLBACK_ACTOR_MISMATCH');

      // Stale revision rejected.
      const staleRev = adapter.consumeCallbackAction({
        connectorId: 'conn-tg-cmd',
        callbackData: issued.callbackData,
        actorExternalId: '303',
        chatId: 'dm-303',
        currentPolicyRevision: 4,
        now: T0,
      });
      expect(staleRev.ok).toBe(false);
      if (!staleRev.ok) expect(staleRev.code).toBe('CALLBACK_STALE_REVISION');

      // Valid consume succeeds once.
      const validConsume = adapter.consumeCallbackAction({
        connectorId: 'conn-tg-cmd',
        callbackData: issued.callbackData,
        actorExternalId: '303',
        chatId: 'dm-303',
        currentPolicyRevision: 3,
        now: T0,
      });
      expect(validConsume.ok).toBe(true);

      // Replay rejected immediately.
      const replay = adapter.consumeCallbackAction({
        connectorId: 'conn-tg-cmd',
        callbackData: issued.callbackData,
        actorExternalId: '303',
        chatId: 'dm-303',
        currentPolicyRevision: 3,
        now: T0,
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.code).toBe('CALLBACK_REPLAYED');

      // GW-AT-048: /cancel reports honest not_supported without fabricating stop.
      const cancelUnsupported = await adapter.handleCommand({
        connectorId: 'conn-tg-cmd',
        chatId: 'dm-303',
        chatType: 'private',
        externalActorId: '303',
        command: 'cancel',
        args: '',
        now: T0,
        registeredWorkspaceIds: new Set(['ws-a']),
        currentWorkspaceId: 'ws-a',
        currentSessionId: 'sess-1',
        onCancel: () => 'not_supported',
      });
      expect(cancelUnsupported.ok).toBe(false);
      expect(cancelUnsupported.cancelStatus).toBe('not_supported');
      expect(cancelUnsupported.text).toMatch(/not supported/i);

      const cancelConfirmed = await adapter.handleCommand({
        connectorId: 'conn-tg-cmd',
        chatId: 'dm-303',
        chatType: 'private',
        externalActorId: '303',
        command: 'cancel',
        args: '',
        now: T0,
        registeredWorkspaceIds: new Set(['ws-a']),
        currentWorkspaceId: 'ws-a',
        currentSessionId: 'sess-1',
        onCancel: () => 'cancelled',
      });
      expect(cancelConfirmed.ok).toBe(true);
      expect(cancelConfirmed.cancelStatus).toBe('cancelled');

      // GW-AT-049: Post-admission edited_message never rewrites or admits a new Host instruction.
      const editedBatch = {
        connectorId: 'conn-tg-cmd',
        provider: 'telegram' as const,
        authenticatedTransportReceipt: adapter.signTransportReceipt('conn-tg-cmd', 'webhook', 'fedcba9876543210fedcba9876543210'),
        receivedAt: T1,
        events: [
          {
            update_id: 3001,
            edited_message: {
              message_id: 50,
              date: 1700000000,
              chat: { id: 303, type: 'private' },
              from: { id: 303, is_bot: false },
              text: 'edited prompt trying to rewrite prior instruction',
            },
          },
        ] as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>,
      };
      const editedEvents = adapter.normalize(editedBatch);
      expect(editedEvents).toHaveLength(0);
      expect(store.listAudit(10).some(a => a.action === 'telegram.edited_message.ignored')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('GW-AT-050..055: enforces media guard, status-card edit fallback, 429 retry_after, 403 permanent disable, heartbeat truth, and Knowledge/Skill candidate summaries', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      const routing = new GatewayRoutingService(store);
      const outbox = new GatewayOutboxService(store);
      let sendCount = 0;
      let nextSendMode: 'ok' | 'edit-fail' | '429' | '403' = 'ok';

      const { fetchImpl } = makeMockFetch(method => {
        if (method === 'getMe') {
          return { ok: true, status: 200, json: { ok: true, result: { id: 9004, is_bot: true, username: 'extalia_out_bot' } } };
        }
        if (method === 'sendMessage') {
          if (nextSendMode === '429') {
            return {
              ok: false,
              status: 429,
              json: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } },
            };
          }
          if (nextSendMode === '403') {
            return {
              ok: false,
              status: 403,
              json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
            };
          }
          sendCount += 1;
          return { ok: true, status: 200, json: { ok: true, result: { message_id: 500 + sendCount } } };
        }
        if (method === 'editMessageText') {
          if (nextSendMode === 'edit-fail') {
            return {
              ok: false,
              status: 400,
              json: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
            };
          }
          return { ok: true, status: 200, json: { ok: true, result: { message_id: 501 } } };
        }
        return { ok: false, status: 404, json: { ok: false } };
      });

      const adapter = new TelegramGatewayAdapter({
        store,
        routing,
        outbox,
        resolveBotToken: () => 'synthetic-out-token',
        fetchImpl,
        now: () => T0,
      });

      await adapter.verifyAndConfigureConnector({
        connectorId: 'conn-tg-out',
        secretRef: 'keychain:tg-out',
        transportMode: 'polling',
        now: T0,
      });

      const registered = new Set(['ws-a']);
      const route = routing.createRoute({
        connectorId: 'conn-tg-out',
        providerAccountId: '9004',
        channelId: 'chat-55',
        workspaceId: 'ws-a',
        mode: 'reuse-pinned',
        audience: 'private',
        registeredWorkspaceIds: registered,
        now: T0,
      });
      const binding = routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        sessionId: 'sess-55',
        registeredWorkspaceIds: registered,
        now: T0,
      });

      // GW-AT-050: P0 text-first & oversized attachment rejection with zero workspace writes.
      const p0Doc = evaluateTelegramMedia({
        message_id: 1,
        date: 1700000000,
        chat: { id: 55, type: 'private' },
        document: { file_id: 'f1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 1024 },
      });
      expect(p0Doc.hasMedia).toBe(true);
      expect(p0Doc.allowed).toBe(false);
      expect(p0Doc.workspaceWritePerformed).toBe(false);

      const oversizedDoc = evaluateTelegramMedia(
        {
          message_id: 2,
          date: 1700000000,
          chat: { id: 55, type: 'private' },
          document: { file_id: 'f2', file_name: 'huge.zip', mime_type: 'application/zip', file_size: 10 * 1024 * 1024 },
        },
        { allowMedia: true, maxBytes: 2 * 1024 * 1024 },
      );
      expect(oversizedDoc.allowed).toBe(false);
      expect(oversizedDoc.reason).toMatch(/exceeds local size limit/i);
      expect(oversizedDoc.workspaceWritePerformed).toBe(false);

      // Safe plain-text fallback when HTML cannot be proven safe.
      const formatted = formatTelegramText('Output has <script>alert(1)</script> and /Users/alice/secret.txt', {
        parseMode: 'HTML',
      });
      expect(formatted.fellBackToPlainText).toBe(true);
      expect(formatted.parseMode).toBeUndefined();
      expect(formatted.chunks[0]).not.toContain('/Users/alice/secret.txt');

      // Balanced coalescing (≥5m milestones) & quiet profile.
      expect(
        shouldEmitTelegramUpdate({
          profile: 'quiet',
          messageClass: 'milestone',
          now: T1,
        }).emit,
      ).toBe(false);
      expect(
        shouldEmitTelegramUpdate({
          profile: 'balanced',
          messageClass: 'milestone',
          lastMilestoneAt: T0,
          now: '2026-11-24T10:02:00.000Z',
        }).emit,
      ).toBe(false);
      expect(
        shouldEmitTelegramUpdate({
          profile: 'balanced',
          messageClass: 'milestone',
          lastMilestoneAt: T0,
          now: T1,
        }).emit,
      ).toBe(true);
      expect(
        shouldEmitTelegramUpdate({
          profile: 'balanced',
          messageClass: 'heartbeat',
          runStartedAt: T0,
          now: T2, // 12m elapsed >= 10m initial threshold
        }).emit,
      ).toBe(true);
      expect(
        shouldEmitTelegramUpdate({
          profile: 'balanced',
          messageClass: 'heartbeat',
          runStartedAt: T0,
          lastHeartbeatAt: T2,
          now: T3, // 33m since last heartbeat >= 30m cadence
        }).emit,
      ).toBe(true);

      // GW-AT-051: Edit-in-place status card creates, edits, and safely replaces on edit failure without infinite spam.
      const cardIntent = outbox.enqueue({
        connectorId: 'conn-tg-out',
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        reportOrSourceEventId: 'evt-card-1',
        senderKind: 'gateway-system',
        format: 'milestone',
        messageClass: 'accepted',
        rawText: 'Task admitted',
        now: T0,
      });
      const approvedBase = {
        intent: cardIntent.intent,
        safeText: 'Task admitted',
        disableMentions: true,
        fencingToken: 'fnc-1',
        providerRequestKey: 'req-1',
      };

      const createdCard = await adapter.upsertStatusCard({ bindingId: binding.id, runId: 'run-1', approved: approvedBase, now: T0 });
      expect(createdCard.action).toBe('created');
      expect(createdCard.receipt.remoteMessageId).toBe('501');

      const editedCard = await adapter.upsertStatusCard({
        bindingId: binding.id,
        runId: 'run-1',
        approved: { ...approvedBase, safeText: 'Milestone 1 reached' },
        now: T1,
      });
      expect(editedCard.action).toBe('edited');
      expect(editedCard.receipt.remoteMessageId).toBe('501');

      nextSendMode = 'edit-fail';
      const replacedCard = await adapter.upsertStatusCard({
        bindingId: binding.id,
        runId: 'run-1',
        approved: { ...approvedBase, safeText: 'Milestone 2 after old card deleted' },
        now: T2,
      });
      expect(replacedCard.action).toBe('replaced-after-edit-failure');
      expect(replacedCard.receipt.remoteMessageId).toBe('502');

      // GW-AT-052: 429 retry_after reschedules outbox intent respecting provider value.
      nextSendMode = '429';
      const rlIntent = outbox.enqueue({
        connectorId: 'conn-tg-out',
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        reportOrSourceEventId: 'evt-429',
        senderKind: 'gateway-system',
        format: 'milestone',
        messageClass: 'terminal',
        rawText: 'Run completed',
        now: T0,
      });
      const claimed429 = outbox.claimNextReady({ leaseOwner: 'host-1', connectorId: 'conn-tg-out', now: T0 });
      expect(claimed429?.intent.id).toBe(rlIntent.intent.id);
      const res429 = await adapter.dispatchClaimedOutboxIntent({
        approved: claimed429!.approved,
        leaseOwner: 'host-1',
        now: T0,
      });
      expect(res429.ok).toBe(false);
      expect(res429.classification).toBe('rate-limited');
      expect(res429.retryAfterSeconds).toBe(17);
      const after429 = outbox.getIntent(rlIntent.intent.id);
      expect(after429?.state).toBe('pending');
      expect(after429?.retryAfterAt).toBe('2026-11-24T10:00:17.000Z');

      // GW-AT-053: 403 blocked permanently disables destination without fallback.
      nextSendMode = '403';
      const blockedIntent = outbox.enqueue({
        connectorId: 'conn-tg-out',
        targetBindingId: binding.id,
        targetBindingRevision: binding.policyRevision,
        reportOrSourceEventId: 'evt-403',
        senderKind: 'gateway-system',
        format: 'milestone',
        messageClass: 'attention',
        rawText: 'Needs attention',
        now: T1,
      });
      const claimed403 = outbox.claimNextReady({ leaseOwner: 'host-1', connectorId: 'conn-tg-out', now: T1 });
      expect(claimed403?.intent.id).toBe(blockedIntent.intent.id);
      const res403 = await adapter.dispatchClaimedOutboxIntent({
        approved: claimed403!.approved,
        leaseOwner: 'host-1',
        now: T1,
      });
      expect(res403.classification).toBe('permanent-blocked');
      expect(outbox.getIntent(blockedIntent.intent.id)?.state).toBe('blocked');
      // Pending rate-limited intent on the same blocked binding is also cancelled without fallback.
      expect(outbox.getIntent(rlIntent.intent.id)?.state).toBe('blocked');

      // GW-AT-054: Heartbeat distinguishes live runtime lease from unasserted progress.
      const hb = renderTelegramHeartbeat({
        runId: 'run-long-1',
        workspaceLabel: 'Example Workspace',
        hasValidRuntimeLease: true,
        runtimeReachable: true,
        lastRuntimeLeaseAt: T2,
        elapsedMinutes: 15,
      });
      expect(hb).toMatch(/Runtime lease: live/i);
      expect(hb).toMatch(/no new asserted progress/i);

      // GW-AT-055: Truthful Knowledge + Skill candidate summary (indexed vs pending review, NOT ACTIVE).
      const report: WorkspaceSystemReport = {
        id: 'rpt-tg-55',
        revision: 1,
        source: 'learning',
        sourceJobId: 'lrn-55',
        workspaceId: 'ws-a',
        targetChatId: 'chat-a1',
        targetSelection: 'last-eligible',
        outcome: 'partial',
        knowledge: { state: 'saved', indexed: false, artifactReceiptIds: ['note-1'] },
        skills: [
          {
            packageId: 'pkg-lint-fix',
            revisionId: 'rev-1',
            state: 'review-required',
            activationPerformed: false,
          },
        ],
        committedAt: T2,
        lastUpdatedAt: T2,
        audienceScopeId: 'aud-1',
      };
      const summary = renderTelegramAutonomousReport(report);
      expect(summary).toContain('PARTIAL');
      expect(summary).toContain('index incomplete');
      expect(summary).toContain('pkg-lint-fix@rev-1');
      expect(summary).toContain('NOT ACTIVE');
    } finally {
      store.close();
    }
  });
});
