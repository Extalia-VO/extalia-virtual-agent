import {
  sanitizeGatewayText,
  validateGatewayInboundEvent,
  type GatewayInboundEvent,
} from '@extalia/platform';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateConnectorHealth,
  classifyExecutionHealth,
  GATEWAY_SCHEMA_VERSION,
  GatewayOutboxService,
  GatewayRoutingService,
  GatewayStore,
  GatewayStoreError,
} from '../src/gateway/index.js';

const NOW = '2026-11-24T12:00:00.000Z';
const LATER = '2026-11-24T12:01:00.000Z';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extalia-gw-core-'));
  tempDirs.push(dir);
  return path.join(dir, 'state', 'gateway.sqlite');
}

function makeInbound(overrides: Partial<GatewayInboundEvent> = {}): GatewayInboundEvent {
  return {
    schema: 'extalia.gateway.inbound.v1',
    connectorId: 'conn-discord-1',
    provider: 'discord',
    providerEventId: 'evt-001',
    providerAccountId: 'guild-100',
    channelId: 'chan-200',
    threadId: 'thread-300',
    externalActorId: 'discord-user-42',
    actorKind: 'human',
    remoteMessageId: 'msg-900',
    kind: 'text',
    text: 'Run the test suite.',
    receivedAt: NOW,
    authenticatedTransportReceipt: 'sig:valid-ed25519-receipt',
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Gateway M0 Core: store, identity, routing, redaction, and outbox (GW-AT-001..015)', () => {
  it('enforces private 0o600 permissions, opaque secretRef, and refuses schema downgrade', async () => {
    const dbPath = createTempDbPath();
    const store = await GatewayStore.open(dbPath);
    expect(store.getSchemaVersion()).toBe(GATEWAY_SCHEMA_VERSION);
    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }

    // Raw credentials or webhook URLs must be rejected as secretRef.
    expect(() =>
      store.upsertConnector({
        id: 'conn-bad',
        provider: 'discord',
        providerAccountId: 'guild-1',
        secretRef: 'https://discord.com/api/webhooks/123456/raw-token-value', // extalia-allow-secret
        now: NOW,
      }),
    ).toThrowError(GatewayStoreError);

    store.close();

    // Bump PRAGMA user_version to simulate a newer binary's DB; older binary must refuse downgrade.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`PRAGMA user_version = ${GATEWAY_SCHEMA_VERSION + 1}`);
    raw.close();

    await expect(GatewayStore.open(dbPath)).rejects.toMatchObject({
      code: 'SCHEMA_DOWNGRADE_REFUSED',
    });
  });

  it('GW-AT-001 & GW-AT-002: denies unsigned inbound before Host action and deduplicates duplicate webhooks', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      store.upsertConnector({
        id: 'conn-discord-1',
        provider: 'discord',
        providerAccountId: 'guild-100',
        secretRef: 'keychain://extalia/gateway/discord-1',
        status: 'connected',
        now: NOW,
      });
      const routing = new GatewayRoutingService(store);
      const workspaces = new Set(['ws-alpha']);
      const route = routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-200',
        workspaceId: 'ws-alpha',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      routing.createBinding({
        routeId: route.id,
        routeRevision: route.policyRevision,
        threadId: 'thread-300',
        sessionId: 'sess-alpha-1',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });

      // Link principal via challenge-confirmed flow.
      const issued = routing.principalLinks.issueChallenge({
        connectorId: 'conn-discord-1',
        extaliaPrincipalId: 'user-owner-1',
        permissionBands: ['submit_prompt', 'read_status'],
        now: NOW,
      });
      expect(
        routing.principalLinks.submitExternalProof({
          connectorId: 'conn-discord-1',
          providerAccountId: 'guild-100',
          externalActorId: 'discord-user-42',
          actorKind: 'human',
          code: issued.code,
          now: NOW,
        }).ok,
      ).toBe(true);
      expect(
        routing.principalLinks.confirmLink({
          challengeId: issued.challengeId,
          extaliaPrincipalId: 'user-owner-1',
          now: NOW,
        }).ok,
      ).toBe(true);

      // GW-AT-001: unsigned / forged inbound denied before inbox/action write.
      const unsigned = routing.admitInboundEvent({
        rawEvent: makeInbound({ providerEventId: 'evt-unsigned', authenticatedTransportReceipt: 'forged' }),
        verifyTransportReceipt: ev => ev.authenticatedTransportReceipt.startsWith('sig:valid-'),
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      expect(unsigned.ok).toBe(false);
      if (!unsigned.ok) expect(unsigned.code).toBe('UNAUTHENTICATED_TRANSPORT');
      const inboxCountAfterUnsigned = store.database.prepare('SELECT count(*) as c FROM gateway_inbox').get() as { c: number };
      expect(inboxCountAfterUnsigned.c).toBe(0);

      // GW-AT-002: duplicate webhook admits exactly one inbox and one Host action.
      const first = routing.admitInboundEvent({
        rawEvent: makeInbound({ providerEventId: 'evt-dup-1' }),
        verifyTransportReceipt: () => true,
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.status).toBe('admitted');

      const second = routing.admitInboundEvent({
        rawEvent: makeInbound({ providerEventId: 'evt-dup-1' }),
        verifyTransportReceipt: () => true,
        registeredWorkspaceIds: workspaces,
        now: LATER,
      });
      expect(second.ok).toBe(true);
      if (second.ok && first.ok) {
        expect(second.status).toBe('duplicate');
        expect(second.actionId).toBe(first.actionId);
      }

      const actionCount = store.database.prepare('SELECT count(*) as c FROM gateway_actions').get() as { c: number };
      expect(actionCount.c).toBe(1);

      // Bot/webhook self-echo is suppressed without creating any action.
      const echo = routing.admitInboundEvent({
        rawEvent: makeInbound({ providerEventId: 'evt-echo-1', actorKind: 'webhook' }),
        verifyTransportReceipt: () => true,
        registeredWorkspaceIds: workspaces,
        now: LATER,
      });
      expect(echo).toEqual({ ok: true, status: 'ignored-echo' });
    } finally {
      store.close();
    }
  });

  it('GW-AT-004..007: rejects forwarded/replayed link codes, anonymous admins, display-name spoofing, and revoked links', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      store.upsertConnector({
        id: 'conn-tg-1',
        provider: 'telegram',
        providerAccountId: 'bot-999',
        secretRef: 'keychain://extalia/gateway/tg-1',
        status: 'connected',
        now: NOW,
      });
      const routing = new GatewayRoutingService(store);
      const workspaces = new Set(['ws-mobile']);
      routing.createRoute({
        connectorId: 'conn-tg-1',
        providerAccountId: 'bot-999',
        channelId: 'chat-77',
        workspaceId: 'ws-mobile',
        mode: 'reuse-pinned',
        audience: 'private',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });

      // Anonymous admin refused.
      const chalAnon = routing.principalLinks.issueChallenge({
        connectorId: 'conn-tg-1',
        extaliaPrincipalId: 'user-1',
        permissionBands: ['submit_prompt'],
        now: NOW,
      });
      const anonRes = routing.principalLinks.submitExternalProof({
        connectorId: 'conn-tg-1',
        providerAccountId: 'bot-999',
        externalActorId: 'tg-anon-group',
        actorKind: 'human',
        isAnonymousAdmin: true,
        code: chalAnon.code,
        now: NOW,
      });
      expect(anonRes.ok).toBe(false);

      // GW-AT-006: forwarded code invalidates one-time challenge.
      const chalFwd = routing.principalLinks.issueChallenge({
        connectorId: 'conn-tg-1',
        extaliaPrincipalId: 'user-1',
        permissionBands: ['submit_prompt'],
        now: NOW,
      });
      expect(
        routing.principalLinks.submitExternalProof({
          connectorId: 'conn-tg-1',
          providerAccountId: 'bot-999',
          externalActorId: 'tg-actor-A',
          actorKind: 'human',
          code: chalFwd.code,
          now: NOW,
        }).ok,
      ).toBe(true);
      const forwarded = routing.principalLinks.submitExternalProof({
        connectorId: 'conn-tg-1',
        providerAccountId: 'bot-999',
        externalActorId: 'tg-actor-attacker',
        actorKind: 'human',
        code: chalFwd.code,
        now: NOW,
      });
      expect(forwarded.ok).toBe(false);
      // Confirming the invalidated challenge now fails.
      expect(
        routing.principalLinks.confirmLink({
          challengeId: chalFwd.challengeId,
          extaliaPrincipalId: 'user-1',
          now: NOW,
        }).ok,
      ).toBe(false);

      // Fresh valid link -> replay after consumption fails.
      const chalOk = routing.principalLinks.issueChallenge({
        connectorId: 'conn-tg-1',
        extaliaPrincipalId: 'user-1',
        permissionBands: ['submit_prompt'],
        now: NOW,
      });
      routing.principalLinks.submitExternalProof({
        connectorId: 'conn-tg-1',
        providerAccountId: 'bot-999',
        externalActorId: 'tg-actor-real',
        actorKind: 'human',
        code: chalOk.code,
        now: NOW,
      });
      const confirmed = routing.principalLinks.confirmLink({
        challengeId: chalOk.challengeId,
        extaliaPrincipalId: 'user-1',
        now: NOW,
      });
      expect(confirmed.ok).toBe(true);

      const replay = routing.principalLinks.submitExternalProof({
        connectorId: 'conn-tg-1',
        providerAccountId: 'bot-999',
        externalActorId: 'tg-actor-real',
        actorKind: 'human',
        code: chalOk.code,
        now: NOW,
      });
      expect(replay.ok).toBe(false);

      // GW-AT-005: a different externalActorId cannot inherit privileges (no display-name lookup).
      expect(
        routing.principalLinks.resolveActivePrincipal({
          connectorId: 'conn-tg-1',
          providerAccountId: 'bot-999',
          externalActorId: 'tg-actor-impersonator',
          now: NOW,
        }),
      ).toBeUndefined();

      // GW-AT-007: revoking link immediately denies subsequent callbacks/actions.
      if (confirmed.ok) {
        expect(
          routing.principalLinks.revokeLink({
            linkId: confirmed.link.id,
            actor: 'user-1',
            reason: 'device-lost',
            now: LATER,
          }),
        ).toBe(true);
      }
      const afterRevoke = routing.admitInboundEvent({
        rawEvent: makeInbound({
          connectorId: 'conn-tg-1',
          provider: 'telegram',
          providerAccountId: 'bot-999',
          providerEventId: 'upd-101',
          channelId: 'chat-77',
          threadId: undefined,
          externalActorId: 'tg-actor-real',
          kind: 'callback',
        }),
        verifyTransportReceipt: () => true,
        registeredWorkspaceIds: workspaces,
        resolvedSessionId: 'sess-mobile-1',
        now: LATER,
      });
      expect(afterRevoke.ok).toBe(false);
      if (!afterRevoke.ok) expect(afterRevoke.code).toBe('UNLINKED_PRINCIPAL');
    } finally {
      store.close();
    }
  });

  it('GW-AT-008, GW-AT-009, GW-AT-011 & reply-by-receipt: enforces route precedence, stale revision block, workspace isolation, and receipt-only replies', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      store.upsertConnector({
        id: 'conn-discord-1',
        provider: 'discord',
        providerAccountId: 'guild-100',
        secretRef: 'keychain://extalia/gateway/discord-1',
        status: 'connected',
        now: NOW,
      });
      const routing = new GatewayRoutingService(store);
      const workspaces = new Set(['ws-a', 'ws-b']);

      // GW-AT-009: unregistered workspace ID fails closed.
      expect(() =>
        routing.createRoute({
          connectorId: 'conn-discord-1',
          providerAccountId: 'guild-100',
          channelId: 'chan-unreg',
          workspaceId: '/Users/someone/arbitrary-root',
          mode: 'explicit-only',
          audience: 'private',
          registeredWorkspaceIds: workspaces,
          now: NOW,
        }),
      ).toThrow();

      // Parent channel -> ws-a; exact thread -> ws-b; DM default -> ws-a.
      const parentRoute = routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        workspaceId: 'ws-a',
        mode: 'thread-new-session',
        audience: 'team',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        threadId: 'thread-b',
        workspaceId: 'ws-b',
        mode: 'explicit-only',
        audience: 'team',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      routing.createRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'dm-1',
        workspaceId: 'ws-a',
        mode: 'reuse-pinned',
        audience: 'private',
        isDmDefault: true,
        linkedPrincipalId: 'user-owner',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });

      // Exact thread beats parent channel.
      const threadMatch = routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        threadId: 'thread-b',
        registeredWorkspaceIds: workspaces,
      });
      expect(threadMatch.ok && threadMatch.matchedBy === 'exact-thread-route' && threadMatch.route.workspaceId === 'ws-b').toBe(true);

      // Unbound thread falls back to parent channel route.
      const parentMatch = routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        threadId: 'thread-new',
        registeredWorkspaceIds: workspaces,
      });
      expect(parentMatch.ok && parentMatch.matchedBy === 'parent-channel-route' && parentMatch.route.workspaceId === 'ws-a').toBe(true);

      // Unmatched channel fails closed — zero cross-workspace fallback!
      const noMatch = routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-unknown',
        registeredWorkspaceIds: workspaces,
      });
      expect(noMatch.ok).toBe(false);
      if (!noMatch.ok) expect(noMatch.code).toBe('NO_ROUTE');

      // GW-AT-008: updating route increments policyRevision and blocks stale binding/revision.
      const binding = routing.createBinding({
        routeId: parentRoute.id,
        routeRevision: parentRoute.policyRevision,
        threadId: 'thread-pinned',
        sessionId: 'sess-a-1',
        registeredWorkspaceIds: workspaces,
        now: NOW,
      });
      expect(binding.policyRevision).toBe(1);

      const updatedRoute = routing.updateRoute({
        routeId: parentRoute.id,
        audience: 'private',
        registeredWorkspaceIds: workspaces,
        actor: 'user-owner',
        now: LATER,
      });
      expect(updatedRoute.policyRevision).toBe(2);

      const staleRes = routing.resolveRoute({
        connectorId: 'conn-discord-1',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        threadId: 'thread-pinned',
        registeredWorkspaceIds: workspaces,
      });
      expect(staleRes.ok).toBe(false);
      if (!staleRes.ok) expect(staleRes.code).toBe('STALE_ROUTE_REVISION');

      // Reply-to-worker resolves strictly by stored remote message receipt.
      routing.recordRemoteReceipt({
        provider: 'discord',
        connectorId: 'conn-discord-1',
        remoteMessageId: 'wh-msg-555',
        providerAccountId: 'guild-100',
        channelId: 'chan-shared',
        threadId: 'thread-b',
        workspaceId: 'ws-b',
        sessionId: 'sess-b-1',
        agentId: 'worker-qa',
        taskId: 'task-99',
        senderSnapshot: { name: 'QA Worker', workspaceId: 'ws-b' },
        acceptedAt: NOW,
      });

      const foundReply = routing.resolveReplyTarget({
        connectorId: 'conn-discord-1',
        replyToRemoteMessageId: 'wh-msg-555',
        expectedWorkspaceId: 'ws-b',
      });
      expect(foundReply.ok).toBe(true);
      if (foundReply.ok) {
        expect(foundReply.receipt.agentId).toBe('worker-qa');
        expect(foundReply.receipt.taskId).toBe('task-99');
        expect(foundReply.delegateViaLead).toBe(true);
      }

      // Cross-workspace reply receipt refused.
      const crossWsReply = routing.resolveReplyTarget({
        connectorId: 'conn-discord-1',
        replyToRemoteMessageId: 'wh-msg-555',
        expectedWorkspaceId: 'ws-a',
      });
      expect(crossWsReply.ok).toBe(false);
      if (!crossWsReply.ok) expect(crossWsReply.code).toBe('CROSS_WORKSPACE_REPLY_REFUSED');

      // Missing receipt refused — never falls back to display name.
      const missingReply = routing.resolveReplyTarget({
        connectorId: 'conn-discord-1',
        replyToRemoteMessageId: 'wh-msg-missing',
        expectedWorkspaceId: 'ws-b',
      });
      expect(missingReply.ok).toBe(false);
      if (!missingReply.ok) expect(missingReply.code).toBe('REPLY_RECEIPT_MISSING');
    } finally {
      store.close();
    }
  });

  it('GW-AT-015: redacts mass mentions, credentials, and private paths, and rejects unknown inbound fields', () => {
    const raw =
      'Ping @everyone and @here! Token sk-proj-abcdefghijklmnopqrstuvwx123456 at /Users/someone/secret/config.json'; // extalia-allow-secret
    const sanitized = sanitizeGatewayText(raw);
    expect(sanitized.text).not.toContain('@everyone');
    expect(sanitized.text).not.toContain('@here');
    expect(sanitized.text).not.toContain('sk-proj-');
    expect(sanitized.text).not.toContain('/Users/someone/');
    expect(sanitized.mentionsStripped).toBe(2);
    expect(sanitized.redactedCount).toBeGreaterThanOrEqual(2);

    // Schema validator rejects unexpected extra fields (e.g. forged workspaceId).
    const forged = validateGatewayInboundEvent({
      ...makeInbound(),
      workspaceId: 'ws-injected',
    });
    expect(forged.ok).toBe(false);
  });

  it('GW-AT-010, GW-AT-014 & outbox semantics: enforces P0-P3 priority, 429 retry_after, 403 block, unknown timeout quarantine, monotonic receipts, and 5D health', async () => {
    const store = await GatewayStore.open(createTempDbPath());
    try {
      store.upsertConnector({
        id: 'conn-discord-1',
        provider: 'discord',
        providerAccountId: 'guild-100',
        secretRef: 'keychain://extalia/gateway/discord-1',
        status: 'connected',
        now: NOW,
      });
      const outbox = new GatewayOutboxService(store);

      // Enqueue P3 heartbeat first, then P0 attention; P0 must be claimed first.
      const p3 = outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: 'bnd-1',
        targetBindingRevision: 1,
        reportOrSourceEventId: 'ev-hb-1',
        senderKind: 'gateway-system',
        format: 'milestone',
        messageClass: 'heartbeat',
        rawText: 'Still running',
        now: NOW,
      });
      const p0 = outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: 'bnd-1',
        targetBindingRevision: 1,
        reportOrSourceEventId: 'ev-att-1',
        senderKind: 'gateway-system',
        format: 'detailed',
        messageClass: 'attention',
        rawText: 'Approval needed @everyone',
        now: NOW,
      });

      const firstClaim = outbox.claimNextReady({ leaseOwner: 'worker-1', now: NOW });
      expect(firstClaim?.intent.id).toBe(p0.intent.id);
      expect(firstClaim?.approved.safeText).not.toContain('@everyone');

      // 429 retry_after puts intent back to pending with backoff and blocks bucket until retry_after.
      const rateLimited = outbox.recordSendResult({
        kind: 'rate-limited',
        intentId: firstClaim!.intent.id,
        fencingToken: firstClaim!.approved.fencingToken,
        leaseOwner: 'worker-1',
        providerRequestKey: firstClaim!.approved.providerRequestKey,
        retryAfterSeconds: 30,
        now: NOW,
      });
      expect(rateLimited.intent.state).toBe('pending');
      expect(rateLimited.intent.retryAfterAt).toBe('2026-11-24T12:00:30.000Z');

      // Bucket is blocked at NOW, so nothing on bnd-1 can be claimed until 12:00:30Z.
      expect(outbox.claimNextReady({ leaseOwner: 'worker-1', now: NOW })).toBeUndefined();

      // After retry_after passes, same intent is claimed and experiences ambiguous timeout -> quarantined as `unknown`.
      const retryClaim = outbox.claimNextReady({ leaseOwner: 'worker-1', now: LATER });
      expect(retryClaim?.intent.id).toBe(p0.intent.id);

      const unknownRes = outbox.recordSendResult({
        kind: 'ambiguous-timeout',
        intentId: retryClaim!.intent.id,
        fencingToken: retryClaim!.approved.fencingToken,
        leaseOwner: 'worker-1',
        providerRequestKey: retryClaim!.approved.providerRequestKey,
        errorMessage: 'Socket timed out waiting for response headers',
        now: LATER,
      });
      expect(unknownRes.intent.state).toBe('unknown');

      // Quarantined `unknown` intent is NEVER blindly reclaimed; next claim gets P3 instead.
      const nextClaim = outbox.claimNextReady({ leaseOwner: 'worker-1', now: '2026-11-24T12:02:00.000Z' });
      expect(nextClaim?.intent.id).toBe(p3.intent.id);

      // Permanent 403 halts delivery with `blocked` and zero destination fallback.
      const blockedRes = outbox.recordSendResult({
        kind: 'permanent-blocked',
        intentId: nextClaim!.intent.id,
        fencingToken: nextClaim!.approved.fencingToken,
        leaseOwner: 'worker-1',
        providerRequestKey: nextClaim!.approved.providerRequestKey,
        httpStatus: 403,
        errorMessage: 'Bot blocked by recipient',
        now: '2026-11-24T12:02:01.000Z',
      });
      expect(blockedRes.intent.state).toBe('blocked');

      // Reconcile unknown intent as confirmed-accepted, then test monotonic accepted -> delivered -> read.
      const reconciled = outbox.reconcileUnknownIntent({
        intentId: p0.intent.id,
        resolution: 'confirmed-accepted',
        remoteMessageId: 'rm-777',
        reason: 'Verified remote message via channel history lookup',
        actor: 'operator-1',
        now: '2026-11-24T12:02:10.000Z',
      });
      expect(reconciled.state).toBe('accepted');

      const delivered = outbox.reconcileDeliveryState({
        connectorId: 'conn-discord-1',
        remoteMessageId: 'rm-777',
        nextState: 'delivered',
        at: '2026-11-24T12:02:11.000Z',
      });
      expect(delivered).toEqual({ updated: true, currentState: 'delivered', outOfOrder: false });

      const read = outbox.reconcileDeliveryState({
        connectorId: 'conn-discord-1',
        remoteMessageId: 'rm-777',
        nextState: 'read',
        at: '2026-11-24T12:02:12.000Z',
      });
      expect(read).toEqual({ updated: true, currentState: 'read', outOfOrder: false });

      // Out-of-order late `delivered` callback must NOT regress `read`.
      const outOfOrder = outbox.reconcileDeliveryState({
        connectorId: 'conn-discord-1',
        remoteMessageId: 'rm-777',
        nextState: 'delivered',
        at: '2026-11-24T12:02:13.000Z',
      });
      expect(outOfOrder).toEqual({ updated: false, currentState: 'read', outOfOrder: true });

      // GW-AT-014: permission revoked between preview and send blocks pending intent.
      const revokedPending = outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: 'bnd-2',
        targetBindingRevision: 1,
        reportOrSourceEventId: 'ev-rev-1',
        senderKind: 'gateway-system',
        format: 'report',
        messageClass: 'terminal',
        rawText: 'Summary',
        now: NOW,
      });
      const reval = outbox.revalidateBeforeSend({
        intentId: revokedPending.intent.id,
        isAuthorized: false,
        reason: 'User permission revoked',
        now: LATER,
      });
      expect(reval.ok).toBe(false);
      expect(outbox.getIntent(revokedPending.intent.id)?.state).toBe('blocked');

      // GW-AT-010: destination removal cancels pending intents without fallback.
      const pendingOnRemoved = outbox.enqueue({
        connectorId: 'conn-discord-1',
        targetBindingId: 'bnd-removed',
        targetBindingRevision: 1,
        reportOrSourceEventId: 'ev-rem-1',
        senderKind: 'gateway-system',
        format: 'report',
        messageClass: 'terminal',
        rawText: 'Done',
        now: NOW,
      });
      expect(
        outbox.cancelPendingForBinding({
          targetBindingId: 'bnd-removed',
          reason: 'Channel deleted',
          actor: 'host',
          now: LATER,
        }),
      ).toBe(1);
      expect(outbox.getIntent(pendingOnRemoved.intent.id)?.state).toBe('blocked');

      // 5-dimension health aggregation & honest silence classification.
      const health = aggregateConnectorHealth({
        connectorId: 'conn-discord-1',
        provider: 'discord',
        connectorState: 'connected',
        transport: { status: 'healthy', observedAt: NOW },
        host: { status: 'healthy', observedAt: NOW },
        runtime: { status: 'healthy', observedAt: NOW },
        progress: { status: 'verification_insufficient', detail: 'Long build active with valid lease' },
        notification: { status: 'degraded', detail: 'One intent quarantined as unknown' },
        lastTransportHeartbeatAt: NOW,
        lastHostHeartbeatAt: NOW,
        lastRuntimeLeaseAt: NOW,
        checkedAt: LATER,
      });
      expect(health.transport.status).toBe('healthy');
      expect(health.notification.status).toBe('degraded');

      expect(
        classifyExecutionHealth({
          runtimeReachable: true,
          hasValidRuntimeLease: true,
          lastProgressEventAt: '2026-11-24T11:40:00.000Z',
          stallThresholdSeconds: 600,
          now: NOW,
        }),
      ).toBe('suspected_stalled');
    } finally {
      store.close();
    }
  });
});
