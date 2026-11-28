import type * as React from 'react';
import {
  BRIDGE_CLIENT_SCOPES,
  type BridgeClientGrantView,
  type BridgePairingChallengeView,
} from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgePairing, BRIDGE_TOKEN_HEADER, createBridgeConnection } from '../src/host/bridgeHost';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { BridgeClientsCard, BridgeClientsView } from '../src/pages/settings/BridgeClientsCard';
import { MessagesContext } from '../src/ui/messages';

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
    useRef: (initial: unknown) => {
      if (!hooks.enabled) return actual.useRef(initial);
      const index = hooks.index++;
      return hooks.values[index] ??= { current: initial };
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
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SAMPLE_CLIENTS: BridgeClientGrantView[] = [
  {
    clientId: 'bc-000000000001',
    name: 'Local companion',
    scopes: ['read', 'events'],
    state: 'active',
    issuedAt: '2026-11-28T09:00:00.000Z',
    lastUsedAt: '2026-11-28T10:00:00.000Z',
  },
  {
    clientId: 'bc-000000000002',
    name: 'Revoked CLI',
    scopes: ['read', 'chat'],
    state: 'revoked',
    issuedAt: '2026-11-27T08:00:00.000Z',
    revokedAt: '2026-11-27T09:30:00.000Z',
  },
  {
    clientId: 'bc-000000000003',
    name: 'Expired script',
    scopes: ['read'],
    state: 'expired',
    issuedAt: '2026-11-26T08:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
  },
];

const SAMPLE_CHALLENGE: BridgePairingChallengeView = {
  challengeId: 'bpc-00000001',
  clientName: 'Desk dashboard',
  requestedScopes: ['read', 'events'],
  code: 'PAIR0001',
  expiresAt: '2026-11-28T12:00:00.000Z',
};

const SAMPLE_TOKEN = `extb_bc-000000000004_${'0'.repeat(64)}`;

beforeEach(() => {
  hooks.enabled = false;
  hooks.index = 0;
  hooks.values = [];
  hooks.pending = [];
});

afterEach(() => {
  hooks.enabled = false;
});

describe('Scoped Bridge pairing UI & transport', () => {
  it('renders active, revoked, and expired clients in EN and ID with Revoke only on active grants', () => {
    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const m = t.bridgePairing;
      const html = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(BridgeClientsView, {
            t,
            language,
            clients: SAMPLE_CLIENTS,
            name: 'Desk dashboard',
            scopes: ['read', 'events'],
            challenge: SAMPLE_CHALLENGE,
            issuedToken: {
              client: {
                clientId: 'bc-000000000004',
                name: 'Desk dashboard',
                scopes: ['read', 'events'],
                state: 'active',
                issuedAt: '2026-11-28T11:00:00.000Z',
              },
              token: SAMPLE_TOKEN,
            },
          }),
        ),
      );

      const plain = html.replace(/&amp;/g, '&');

      expect(plain).toContain(m.title);
      expect(plain).toContain(m.lead);
      for (const scope of BRIDGE_CLIENT_SCOPES) {
        expect(plain).toContain(m.scopes[scope]);
      }

      // Challenge box renders 8-char code and Confirm / Cancel buttons
      expect(plain).toContain('PAIR0001');
      expect(plain).toContain(m.challenge.confirmButton);
      expect(plain).toContain(m.challenge.cancelButton);

      // One-time issued token banner renders token, warning, and dismiss button
      expect(plain).toContain(SAMPLE_TOKEN);
      expect(plain).toContain(m.issuedToken.warning);
      expect(plain).toContain(m.issuedToken.dismiss);

      // Client badges & Revoke button ONLY for active client
      expect(plain).toContain('bc-000000000001');
      expect(plain).toContain('bc-000000000002');
      expect(plain).toContain('bc-000000000003');
      expect(plain).toContain(m.states.active);
      expect(plain).toContain(m.states.revoked);
      expect(plain).toContain(m.states.expired);
      const revokeButtonMatches = html.match(new RegExp(`>${m.clients.revokeButton}<`, 'g')) ?? [];
      expect(revokeButtonMatches).toHaveLength(1);
    }
  });

  it('disables Issue Challenge button when name or scopes are empty and renders empty state', () => {
    const t = MESSAGES.en;
    const tree = BridgeClientsView({
      t,
      language: 'en',
      clients: [],
      name: '   ',
      scopes: [],
      challenge: null,
      issuedToken: null,
    });
    const all = elements(tree);
    const submitBtn = all.find(el => el.type === 'button' && el.props.type === 'submit')!;
    expect(submitBtn.props.disabled).toBe(true);
    expect(textContent(tree)).toContain(t.bridgePairing.empty);
  });

  it('sends pairing transport requests to Bridge endpoints with x-extalia-token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ clients: [SAMPLE_CLIENTS[0]] }))
      .mockResolvedValueOnce(jsonResponse({ challenge: SAMPLE_CHALLENGE }, 201))
      .mockResolvedValueOnce(jsonResponse({ client: SAMPLE_CLIENTS[0], token: SAMPLE_TOKEN }, 201))
      .mockResolvedValueOnce(jsonResponse({ client: { ...SAMPLE_CLIENTS[0]!, state: 'revoked' } }));

    const connection = createBridgeConnection('bridge-secret-token');
    const pairing = bridgePairing(connection, { fetch });

    const listed = await pairing.listClients();
    expect(listed).toEqual([SAMPLE_CLIENTS[0]]);

    const challenge = await pairing.issueChallenge({ name: 'Desk dashboard', scopes: ['read', 'events'] });
    expect(challenge).toEqual(SAMPLE_CHALLENGE);

    const confirmed = await pairing.confirmChallenge({ challengeId: challenge.challengeId, code: challenge.code });
    expect(confirmed).toEqual({ client: SAMPLE_CLIENTS[0], token: SAMPLE_TOKEN });

    const revoked = await pairing.revokeClient('bc-000000000001', 'Rotated');
    expect(revoked.state).toBe('revoked');

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET', new Headers(init?.headers).get(BRIDGE_TOKEN_HEADER)])).toEqual([
      ['/api/bridge/clients', 'GET', 'bridge-secret-token'],
      ['/api/bridge/pair/challenge', 'POST', 'bridge-secret-token'],
      ['/api/bridge/pair/confirm', 'POST', 'bridge-secret-token'],
      ['/api/bridge/clients/revoke', 'POST', 'bridge-secret-token'],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ name: 'Desk dashboard', scopes: ['read', 'events'] });
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({ challengeId: 'bpc-00000001', code: 'PAIR0001' });
    expect(JSON.parse(String(fetch.mock.calls[3]![1]?.body))).toEqual({ clientId: 'bc-000000000001', reason: 'Rotated' });
  });

  it('exposes capabilities.bridgePairing on mock ready platform and runs challenge -> confirm -> list -> revoke', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const pairing = platform.capabilities.bridgePairing;
    expect(pairing).toBeDefined();

    const initial = await pairing!.listClients();
    expect(initial).toHaveLength(1);
    expect(initial[0]!.clientId).toBe('bc-000000000001');
    expect(initial[0]!.state).toBe('active');

    const challenge = await pairing!.issueChallenge({ name: 'Companion CLI', scopes: ['read', 'chat'] });
    expect(challenge.code).toHaveLength(8);
    expect(challenge.clientName).toBe('Companion CLI');
    expect(challenge.requestedScopes).toEqual(['read', 'chat']);

    const minted = await pairing!.confirmChallenge({ challengeId: challenge.challengeId, code: challenge.code });
    expect(minted.client.name).toBe('Companion CLI');
    expect(minted.client.state).toBe('active');
    expect(minted.token).toMatch(/^extb_bc-[0-9a-f]{12}_[0-9a-f]{64}$/);

    const afterConfirm = await pairing!.listClients();
    expect(afterConfirm.some(client => client.clientId === minted.client.clientId && client.state === 'active')).toBe(true);

    const revoked = await pairing!.revokeClient(minted.client.clientId, 'No longer needed');
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokeReason).toBe('No longer needed');

    const afterRevoke = await pairing!.listClients();
    expect(afterRevoke.find(client => client.clientId === minted.client.clientId)?.state).toBe('revoked');
  });

  it('drives stateful BridgeClientsCard lifecycle through list -> issue -> confirm -> revoke', async () => {
    hooks.enabled = true;
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const pairing = platform.capabilities.bridgePairing!;
    const t = MESSAGES.en;

    const draw = () => {
      hooks.index = 0;
      const viewEl = BridgeClientsCard({ t, language: 'en', pairing }) as ReactElement<Parameters<typeof BridgeClientsView>[0]>;
      const rendered = BridgeClientsView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };

    draw();
    await flushMicrotasks();
    let tree = draw();
    expect(textContent(tree)).toContain('bc-000000000001');

    // Fill client name and issue challenge
    const input = elements(tree).find(el => el.type === 'input' && el.props.type === 'text')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'CI runner' } });
    tree = draw();
    const form = elements(tree).find(el => el.type === 'form')!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await flushMicrotasks();
    tree = draw();
    expect(textContent(tree)).toContain(t.bridgePairing.challenge.heading);
    expect(textContent(tree)).toContain('PAIR');

    // Confirm challenge -> clears challenge, reveals issued token, refreshes list
    const confirmBtn = elements(tree).find(el => el.type === 'button' && textContent(el) === t.bridgePairing.challenge.confirmButton)!;
    (confirmBtn.props.onClick as () => void)();
    await flushMicrotasks();
    tree = draw();
    expect(textContent(tree)).not.toContain(t.bridgePairing.challenge.heading);
    expect(textContent(tree)).toContain(t.bridgePairing.issuedToken.heading);
    expect(textContent(tree)).toContain('CI runner');

    // Revoke newly created client
    const revokeBtns = elements(tree).filter(el => el.type === 'button' && textContent(el) === t.bridgePairing.clients.revokeButton);
    expect(revokeBtns).toHaveLength(2);
    (revokeBtns[0]!.props.onClick as () => void)();
    await flushMicrotasks();
    tree = draw();
    const remainingRevokeBtns = elements(tree).filter(el => el.type === 'button' && textContent(el) === t.bridgePairing.clients.revokeButton);
    expect(remainingRevokeBtns).toHaveLength(1);
  });
});
