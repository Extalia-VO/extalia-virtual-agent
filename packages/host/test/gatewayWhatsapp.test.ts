import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateGatewayCapabilities } from '@extalia/platform';
import {
  evaluateWhatsAppSendPolicy,
  isWhatsAppOptOutText,
  isWhatsAppServiceWindowOpen,
  parseWhatsAppStatusWebhooks,
  reconcileWhatsAppStatusWebhook,
  sanitizeWhatsAppSignalText,
  sendWhatsAppCloudMessage,
  validateWhatsAppTemplateForSend,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  WHATSAPP_CAPABILITIES,
  WHATSAPP_PINNED_GRAPH_VERSION,
  type WhatsAppFetch,
  type WhatsAppRegisteredTemplate,
  type WhatsAppSendPolicyInput,
} from '../src/gateway/whatsapp.js';

const T_NOW = '2026-11-26T12:00:00.000Z';
const T_EXACT_24H_AGO = '2026-11-25T12:00:00.000Z';
const T_24H_PLUS_1MS_AGO = '2026-11-25T11:59:59.999Z';
const T_FUTURE = '2026-11-26T12:00:01.000Z';

const TEST_APP_SECRET = ['wa', 'test', 'app', 'secret'].join('-');
const TEST_VERIFY_TOKEN = ['wh', 'test', 'verify', 'token'].join('-');
const TEST_ACCESS_TOKEN = ['wa', 'test', 'access', 'token'].join('-');
const TEST_PHONE_ID = '15550100123';
const TEST_RECIPIENT = '15550100999';

const TEST_REGISTRY: WhatsAppRegisteredTemplate[] = [
  {
    name: 'extalia_run_attention',
    language: 'en_US',
    category: 'utility',
    approved: true,
    allowedSignalClasses: ['attention', 'terminal'],
  },
  {
    name: 'extalia_run_paused',
    language: 'en_US',
    category: 'utility',
    approved: false,
  },
  {
    name: 'extalia_promo_notice',
    language: 'en_US',
    category: 'marketing',
    approved: true,
  },
];

function basePolicy(overrides: Partial<WhatsAppSendPolicyInput> = {}): WhatsAppSendPolicyInput {
  return {
    waEnabled: true,
    complianceSignOffId: 'signoff-waba-2026-11',
    optInStatus: 'opted_in',
    signalClass: 'attention',
    lastInboundAtIso: '2026-11-26T10:00:00.000Z',
    nowIso: T_NOW,
    templateRegistry: TEST_REGISTRY,
    estimatedCost: 0.015,
    monthlySpent: 1.0,
    monthlyBudgetLimit: 5.0,
    workspaceSpent: 0.2,
    workspaceBudgetLimit: 1.0,
    ...overrides,
  };
}

function signPayload(rawBody: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

describe('Gateway M4 WhatsApp Conditional Monitoring Adapter (GW-AT-057..077)', () => {
  it('validates WHATSAPP_CAPABILITIES and pinned Graph API version', () => {
    const validated = validateGatewayCapabilities(WHATSAPP_CAPABILITIES);
    expect(validated.ok).toBe(true);
    expect(WHATSAPP_PINNED_GRAPH_VERSION).toBe('v21.0');
    expect(WHATSAPP_CAPABILITIES).toMatchObject({
      provider: 'whatsapp',
      revision: 1,
      requiresComplianceGate: true,
      receiveCommands: false,
      createOrResumeSession: false,
      perAgentWebhookPortraits: false,
      editMessages: false,
      replyReceipts: true,
      threadsOrTopics: false,
      attachments: false,
      deliveryCallbacks: true,
      supportsCancel: false,
      maxMessageLength: 1024,
    });
  });

  it('GW-AT-057: fails closed when waEnabled=false or complianceSignOffId is missing with zero fetch calls', async () => {
    let fetchCalls = 0;
    const mockFetch: WhatsAppFetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    };

    const disabledRes = await sendWhatsAppCloudMessage({
      policy: basePolicy({ waEnabled: false }),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'ATTENTION: Project A needs approval.',
      fetchImpl: mockFetch,
    });
    expect(disabledRes).toMatchObject({
      kind: 'permanent-blocked',
      errorCode: 'adapter_disabled',
    });

    const unsignedPolicyRes = await sendWhatsAppCloudMessage({
      policy: basePolicy({ complianceSignOffId: '   ' }),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'ATTENTION: Project A needs approval.',
      fetchImpl: mockFetch,
    });
    expect(unsignedPolicyRes).toMatchObject({
      kind: 'permanent-blocked',
      errorCode: 'missing_compliance_signoff',
    });
    expect(fetchCalls).toBe(0);
  });

  it('GW-AT-058: validates Meta GET webhook challenge and raw-body X-Hub-Signature-256 fail-closed', () => {
    expect(
      verifyWhatsAppWebhookChallenge(
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': TEST_VERIFY_TOKEN,
          'hub.challenge': 'challenge-12345',
        },
        TEST_VERIFY_TOKEN,
      ),
    ).toEqual({ ok: true, challenge: 'challenge-12345' });

    expect(
      verifyWhatsAppWebhookChallenge(
        {
          'hub.mode': 'unsubscribe',
          'hub.verify_token': TEST_VERIFY_TOKEN,
          'hub.challenge': 'challenge-12345',
        },
        TEST_VERIFY_TOKEN,
      ),
    ).toMatchObject({ ok: false, status: 403 });

    expect(
      verifyWhatsAppWebhookChallenge(
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'challenge-12345',
        },
        TEST_VERIFY_TOKEN,
      ),
    ).toMatchObject({ ok: false, status: 403 });

    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const validSig = signPayload(rawBody, TEST_APP_SECRET);

    expect(verifyWhatsAppWebhookSignature(rawBody, validSig, TEST_APP_SECRET)).toBe(true);
    expect(verifyWhatsAppWebhookSignature(Buffer.from(rawBody, 'utf8'), validSig, TEST_APP_SECRET)).toBe(true);
    expect(verifyWhatsAppWebhookSignature(rawBody, undefined, TEST_APP_SECRET)).toBe(false);
    expect(verifyWhatsAppWebhookSignature(rawBody, 'sha256=deadbeef', TEST_APP_SECRET)).toBe(false);
    expect(verifyWhatsAppWebhookSignature(rawBody, validSig.slice(0, -2) + '00', TEST_APP_SECRET)).toBe(false);
    expect(verifyWhatsAppWebhookSignature(`${rawBody} `, validSig, TEST_APP_SECRET)).toBe(false);
    expect(verifyWhatsAppWebhookSignature(rawBody, validSig, '')).toBe(false);
  });

  it('GW-AT-062: enforces exact 24-hour customer-service window boundaries', () => {
    expect(isWhatsAppServiceWindowOpen(T_EXACT_24H_AGO, T_NOW)).toBe(true);
    expect(isWhatsAppServiceWindowOpen(T_24H_PLUS_1MS_AGO, T_NOW)).toBe(false);
    expect(isWhatsAppServiceWindowOpen(T_FUTURE, T_NOW)).toBe(false);
    expect(isWhatsAppServiceWindowOpen(undefined, T_NOW)).toBe(false);
    expect(isWhatsAppServiceWindowOpen('not-a-date', T_NOW)).toBe(false);

    const outOfWindowNoTemplate = evaluateWhatsAppSendPolicy(
      basePolicy({ lastInboundAtIso: T_24H_PLUS_1MS_AGO }),
    );
    expect(outOfWindowNoTemplate).toMatchObject({
      allowed: false,
      code: 'window_closed_no_template',
    });
  });

  it('GW-AT-063 & GW-AT-064: permits approved utility template outside 24h window and rejects unapproved/mismatched/marketing templates', () => {
    const validOutsideWindow = evaluateWhatsAppSendPolicy(
      basePolicy({
        lastInboundAtIso: T_24H_PLUS_1MS_AGO,
        signalClass: 'attention',
        template: {
          name: 'extalia_run_attention',
          language: 'en_US',
          category: 'utility',
        },
      }),
    );
    expect(validOutsideWindow).toMatchObject({
      allowed: true,
      mode: 'utility-template',
    });

    const unapproved = validateWhatsAppTemplateForSend(
      { name: 'extalia_run_paused', language: 'en_US', category: 'utility' },
      TEST_REGISTRY,
    );
    expect(unapproved.ok).toBe(false);

    const wrongLanguage = validateWhatsAppTemplateForSend(
      { name: 'extalia_run_attention', language: 'id', category: 'utility' },
      TEST_REGISTRY,
    );
    expect(wrongLanguage.ok).toBe(false);

    const marketingBlocked = evaluateWhatsAppSendPolicy(
      basePolicy({
        lastInboundAtIso: T_24H_PLUS_1MS_AGO,
        template: {
          name: 'extalia_promo_notice',
          language: 'en_US',
          category: 'marketing',
        },
      }),
    );
    expect(marketingBlocked).toMatchObject({
      allowed: false,
      code: 'template_not_utility',
    });

    const unapprovedAtSendTime = evaluateWhatsAppSendPolicy(
      basePolicy({
        lastInboundAtIso: T_24H_PLUS_1MS_AGO,
        template: {
          name: 'extalia_run_paused',
          language: 'en_US',
          category: 'utility',
        },
      }),
    );
    expect(unapprovedAtSendTime).toMatchObject({
      allowed: false,
      code: 'template_invalid',
    });
  });

  it('GW-AT-060 & GW-AT-061: blocks non-opted-in recipients and recognizes STOP/UNSUBSCRIBE/BERHENTI opt-outs', () => {
    expect(isWhatsAppOptOutText('STOP')).toBe(true);
    expect(isWhatsAppOptOutText('  unsubscribe please ')).toBe(true);
    expect(isWhatsAppOptOutText('Berhenti')).toBe(true);
    expect(isWhatsAppOptOutText('opt out')).toBe(true);
    expect(isWhatsAppOptOutText('OPTOUT')).toBe(true);
    expect(isWhatsAppOptOutText('please do not stop')).toBe(false);

    const revoked = evaluateWhatsAppSendPolicy(basePolicy({ optInStatus: 'opted_out' }));
    expect(revoked).toMatchObject({
      allowed: false,
      code: 'recipient_not_opted_in',
    });
  });

  it('enforces 4-signal class restriction and redacts paths, stack lines, tool feeds, and synthetic credentials', () => {
    for (const allowedSignal of ['accepted', 'heartbeat', 'attention', 'terminal']) {
      const res = evaluateWhatsAppSendPolicy(basePolicy({ signalClass: allowedSignal }));
      expect(res.allowed).toBe(true);
    }

    for (const forbiddenSignal of ['milestone', 'system-report', 'chat']) {
      const res = evaluateWhatsAppSendPolicy(basePolicy({ signalClass: forbiddenSignal }));
      expect(res).toMatchObject({
        allowed: false,
        code: 'signal_class_not_allowed',
      });
    }

    const fakeSecret = ['sk', 'proj', 'synthetic1234567890abcdef'].join('-');
    const fakeMetaToken = ['EAA', 'SyntheticToken1234567890'].join('');
    const windowsPath = ['C:', 'Users', 'alice', 'repo', 'secret.env'].join('\\');
    const raw = [
      'TERMINAL: Project A finished.',
      `Path unix: /Users/alice/workspace/extalia/config.json and /etc/passwd`,
      `Path win: ${windowsPath}`,
      `Token: ${fakeSecret} ${fakeMetaToken}`,
      '    at runTask (/opt/extalia/runner.ts:42:9)',
      '[tool:bash] cat /var/log/private.log',
      'Details at https://app.example.com/runs/42',
    ].join('\n');

    const sanitized = sanitizeWhatsAppSignalText(raw);
    expect(sanitized.length).toBeLessThanOrEqual(1024);
    expect(sanitized).not.toContain('/Users/alice');
    expect(sanitized).not.toContain('/etc/passwd');
    expect(sanitized).not.toContain('secret.env');
    expect(sanitized).not.toContain(fakeSecret);
    expect(sanitized).not.toContain(fakeMetaToken);
    expect(sanitized).not.toContain('/opt/extalia/runner.ts');
    expect(sanitized).not.toContain('/var/log/private.log');
    expect(sanitized).toContain('https://app.example.com/runs/42');

    const longText = sanitizeWhatsAppSignalText('A'.repeat(1500));
    expect(longText.length).toBeLessThanOrEqual(1024);
  });

  it('GW-AT-073 & GW-AT-074: enforces hard monthly and per-workspace budgets without assuming zero cost', () => {
    const monthlyExceeded = evaluateWhatsAppSendPolicy(
      basePolicy({
        estimatedCost: 0.5,
        monthlySpent: 4.8,
        monthlyBudgetLimit: 5.0,
      }),
    );
    expect(monthlyExceeded).toMatchObject({
      allowed: false,
      code: 'monthly_budget_exceeded',
    });

    const workspaceExceeded = evaluateWhatsAppSendPolicy(
      basePolicy({
        estimatedCost: 0.2,
        workspaceSpent: 0.9,
        workspaceBudgetLimit: 1.0,
      }),
    );
    expect(workspaceExceeded).toMatchObject({
      allowed: false,
      code: 'workspace_budget_exceeded',
    });

    const invalidCost = evaluateWhatsAppSendPolicy(
      basePolicy({ estimatedCost: Number.NaN }),
    );
    expect(invalidCost).toMatchObject({
      allowed: false,
      code: 'invalid_cost_budget',
    });
  });

  it('GW-AT-070 & GW-AT-072: maps Cloud API accepted (wamid), 429 rate-limited, 500 retryable, 400 permanent-blocked, and timeout -> unknown', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody = '';
    const acceptFetch: WhatsAppFetch = async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.authorization ?? '';
      seenBody = init?.body ?? '';
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            messaging_product: 'whatsapp',
            contacts: [{ input: TEST_RECIPIENT, wa_id: TEST_RECIPIENT }],
            messages: [{ id: 'wamid.HBgLMTU1NTAxMDA5OTkVAgARGBI5' }],
          };
        },
      };
    };

    const accepted = await sendWhatsAppCloudMessage({
      policy: basePolicy(),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'ATTENTION: Project A waiting approval at /Users/alice/repo/app.ts.',
      fetchImpl: acceptFetch,
    });
    expect(accepted).toEqual({
      kind: 'accepted',
      wamid: 'wamid.HBgLMTU1NTAxMDA5OTkVAgARGBI5',
      remoteMessageId: 'wamid.HBgLMTU1NTAxMDA5OTkVAgARGBI5',
      httpStatus: 200,
      mode: 'session-text',
    });
    expect(seenUrl).toBe(`https://graph.facebook.com/v21.0/${TEST_PHONE_ID}/messages`);
    expect(seenAuth).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(seenBody).not.toContain('/Users/alice');

    const rateLimited = await sendWhatsAppCloudMessage({
      policy: basePolicy(),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'HEARTBEAT: Run 42 still running.',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: { get: name => (name.toLowerCase() === 'retry-after' ? '12' : null) },
        async json() {
          return { error: { message: 'Too many requests', code: 130429 } };
        },
      }),
    });
    expect(rateLimited).toMatchObject({
      kind: 'rate-limited',
      retryAfterSeconds: 12,
      httpStatus: 429,
    });

    const retryable = await sendWhatsAppCloudMessage({
      policy: basePolicy(),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'HEARTBEAT: Run 42 still running.',
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        async json() {
          return { error: { message: 'Internal Graph failure', code: 2 } };
        },
      }),
    });
    expect(retryable).toMatchObject({
      kind: 'retryable',
      httpStatus: 500,
    });

    const blocked = await sendWhatsAppCloudMessage({
      policy: basePolicy(),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'HEARTBEAT: Run 42 still running.',
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async json() {
          return { error: { message: 'Recipient cannot receive message', code: 131026 } };
        },
      }),
    });
    expect(blocked).toMatchObject({
      kind: 'permanent-blocked',
      httpStatus: 400,
      errorCode: '131026',
    });

    const timeout = await sendWhatsAppCloudMessage({
      policy: basePolicy(),
      phoneNumberId: TEST_PHONE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      recipientPhone: TEST_RECIPIENT,
      messageText: 'TERMINAL: Run 42 finished.',
      fetchImpl: async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'AbortError';
        throw err;
      },
    });
    expect(timeout).toMatchObject({
      kind: 'ambiguous-timeout',
      state: 'unknown',
    });
  });

  it('GW-AT-059 & GW-AT-071: parses Cloud API status webhooks and enforces monotonic delivery reconciliation', () => {
    const webhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: TEST_PHONE_ID },
                statuses: [
                  {
                    id: 'wamid.1',
                    status: 'delivered',
                    timestamp: '1795694400',
                    recipient_id: TEST_RECIPIENT,
                  },
                  {
                    id: 'wamid.1',
                    status: 'sent',
                    timestamp: '1795694390',
                    recipient_id: TEST_RECIPIENT,
                  },
                  {
                    id: 'wamid.1',
                    status: 'read',
                    timestamp: '1795694410',
                    recipient_id: TEST_RECIPIENT,
                  },
                  {
                    id: 'wamid.2',
                    status: 'failed',
                    timestamp: '1795694420',
                    recipient_id: TEST_RECIPIENT,
                    errors: [{ code: 131047, title: 'Re-engagement message' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWhatsAppStatusWebhooks(webhookPayload);
    expect(parsed).toHaveLength(4);
    const [evtDelivered, evtSent, evtRead, evtFailed] = parsed;
    expect(evtDelivered).toBeDefined();
    expect(evtSent).toBeDefined();
    expect(evtRead).toBeDefined();
    expect(evtFailed).toBeDefined();
    if (!evtDelivered || !evtSent || !evtRead || !evtFailed) {
      throw new Error('Expected 4 parsed status webhook events.');
    }

    expect(evtDelivered).toMatchObject({
      wamid: 'wamid.1',
      status: 'delivered',
      recipientId: TEST_RECIPIENT,
      phoneNumberId: TEST_PHONE_ID,
    });
    expect(evtFailed.errors?.[0]).toEqual({
      code: 131047,
      title: 'Re-engagement message',
    });

    // delivered + stale sent -> stays delivered (outOfOrder=true)
    const staleSent = reconcileWhatsAppStatusWebhook('delivered', evtSent);
    expect(staleSent).toMatchObject({
      updated: false,
      state: 'delivered',
      outOfOrder: true,
      duplicate: false,
    });

    // duplicate delivered -> idempotent no-op
    const dupDelivered = reconcileWhatsAppStatusWebhook('delivered', evtDelivered);
    expect(dupDelivered).toMatchObject({
      updated: false,
      state: 'delivered',
      outOfOrder: false,
      duplicate: true,
    });

    // delivered + read -> advances to read
    const readAdvance = reconcileWhatsAppStatusWebhook('delivered', evtRead);
    expect(readAdvance).toMatchObject({
      updated: true,
      state: 'read',
      outOfOrder: false,
    });

    // accepted + failed -> records failed with errors
    const failedFromAccepted = reconcileWhatsAppStatusWebhook('accepted', evtFailed);
    expect(failedFromAccepted).toMatchObject({
      updated: true,
      state: 'failed',
      errors: [{ code: 131047, title: 'Re-engagement message' }],
    });

    // read + stale failed -> stays read
    const staleFailedAfterRead = reconcileWhatsAppStatusWebhook('read', evtFailed);
    expect(staleFailedAfterRead).toMatchObject({
      updated: false,
      state: 'read',
      outOfOrder: true,
    });
  });
});
