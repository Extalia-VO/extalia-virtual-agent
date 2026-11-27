import type * as React from 'react';
import {
  AGENT_HOST_METHODS,
  EXECUTION_SAFETY_HOST_METHODS,
  type AgentHostApi,
  type CommandSandboxStatus,
  type ExactApprovalState,
  type ExactApprovalView,
  type HostState,
  type WorkerLeaseView,
} from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionSafetyPanel, ExecutionSafetyView } from '../src/approvals/ExecutionSafetyPanel';
import { ChatSessionInfo } from '../src/chat/ChatSessionInfo';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { SettingsPage } from '../src/pages/SettingsPage';
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
      return `es-test-${hooks.index++}`;
    },
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

function makeApproval(state: ExactApprovalState, index = 0): ExactApprovalView {
  return {
    approvalId: `appr-${state}-${index}`,
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    toolName: state === 'pending' || state === 'granted' ? 'run_command' : 'edit_file',
    access: state === 'pending' || state === 'granted' ? 'execute' : 'write',
    target: `src/file-${state}.ts`,
    generation: index + 1,
    actionDigest: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    state,
    issuedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_900_000,
    ...(state === 'revoked' ? { revokedAt: 1_760_000_120_000, revokeReason: 'revoked by user' } : {}),
  };
}

function makeLease(status: WorkerLeaseView['status'], settlement: WorkerLeaseView['settlement']): WorkerLeaseView {
  return {
    leaseId: status === 'quarantined' ? 'wl-a1b2c3d4e5f6' : 'wl-001122334455',
    ownerId: 'worker-owner-1',
    taskId: `task-${status}`,
    sessionId: 'session-1',
    fencingToken: status === 'quarantined' ? 7 : 6,
    status,
    settlement,
    ...(status === 'quarantined' ? { quarantineReason: 'Worker exited without settlement receipt.' } : {}),
    acquiredAt: '2026-11-27T08:00:00.000Z',
    heartbeatAt: '2026-11-27T08:02:00.000Z',
    leaseExpiresAt: '2026-11-27T08:05:00.000Z',
  };
}

beforeEach(() => {
  hooks.enabled = false;
  hooks.index = 0;
  hooks.values = [];
  hooks.pending = [];
});

afterEach(() => {
  hooks.enabled = false;
});

describe('Execution Safety UI (Slice C)', () => {
  it('renders verified macos-seatbelt and fail-closed sandbox postures in EN and ID', () => {
    const verifiedSandbox: CommandSandboxStatus = {
      supported: true,
      kind: 'macos-seatbelt',
      platform: 'darwin',
      networkAccess: 'denied',
      verifiedAt: '2026-11-27T08:30:00.000Z',
    };
    const failClosedSandbox: CommandSandboxStatus = {
      supported: false,
      kind: 'none',
      platform: 'linux',
      networkAccess: 'denied',
      reason: 'Bubblewrap binary not found on host.',
    };

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const okHtml = renderToStaticMarkup(createElement(ExecutionSafetyView, {
        t,
        language,
        sandbox: verifiedSandbox,
        approvals: [],
        leases: [],
      }));
      expect(okHtml).toContain(t.executionSafety.sandbox.verified);
      expect(okHtml).toContain(t.executionSafety.sandbox.kindLabel['macos-seatbelt']);
      expect(okHtml).toContain(t.executionSafety.sandbox.networkDenied);
      expect(okHtml).toContain('darwin');
      expect(okHtml).not.toContain('execution-fail-closed');

      const failHtml = renderToStaticMarkup(createElement(ExecutionSafetyView, {
        t,
        language,
        sandbox: failClosedSandbox,
        approvals: [],
        leases: [],
      }));
      expect(failHtml).toContain(t.executionSafety.sandbox.failClosed);
      expect(failHtml).toContain(t.executionSafety.sandbox.kindLabel.none);
      expect(failHtml).toContain('role="status"');
      expect(failHtml).toContain('Bubblewrap binary not found on host.');
    }
  });

  it('renders abbreviated digest, generation, and Revoke button ONLY for pending and granted approvals', () => {
    const allStates: ExactApprovalState[] = ['pending', 'granted', 'rejected', 'consumed', 'revoked', 'expired'];
    const approvals = allStates.map((state, index) => makeApproval(state, index));
    const onRevoke = vi.fn();

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const tree = ExecutionSafetyView({
        t,
        language,
        sandbox: null,
        approvals,
        leases: [],
        onRevoke,
      });

      const revokeButtons = elements(tree).filter(
        el => el.type === 'button' && textContent(el.props.children as ReactNode).trim() === t.executionSafety.approvals.revoke,
      );
      expect(revokeButtons).toHaveLength(2);
      (revokeButtons[0]!.props.onClick as () => void)();
      (revokeButtons[1]!.props.onClick as () => void)();
      expect(onRevoke).toHaveBeenCalledWith('session-1', 'appr-pending-0');
      expect(onRevoke).toHaveBeenCalledWith('session-1', 'appr-granted-1');

      const html = renderToStaticMarkup(createElement(ExecutionSafetyView, {
        t,
        language,
        sandbox: null,
        approvals,
        leases: [],
        onRevoke,
      }));
      expect(html).toContain('sha256:abcdef123456…');
      expect(html).toContain(`title="${approvals[0]!.actionDigest}"`);
      expect(html).toContain(`${t.executionSafety.approvals.generation} 1`);
      for (const state of allStates) {
        expect(html).toContain(t.executionSafety.approvals.state[state]);
      }
    }
  });

  it('renders quarantined worker leases with fencing token, unknown settlement warning, and acknowledge action only while quarantined', () => {
    const quarantined = makeLease('quarantined', 'unknown');
    const settled = makeLease('settled', 'completed');
    const onAcknowledgeLease = vi.fn();

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const tree = ExecutionSafetyView({
        t,
        language,
        sandbox: null,
        approvals: [],
        leases: [quarantined, settled],
        onAcknowledgeLease,
      });

      const ackButtons = elements(tree).filter(
        el => el.type === 'button' && textContent(el.props.children as ReactNode).trim() === t.executionSafety.leases.acknowledge,
      );
      expect(ackButtons).toHaveLength(1);
      (ackButtons[0]!.props.onClick as () => void)();
      expect(onAcknowledgeLease).toHaveBeenCalledWith(quarantined.leaseId);

      const html = renderToStaticMarkup(createElement(ExecutionSafetyView, {
        t,
        language,
        sandbox: null,
        approvals: [],
        leases: [quarantined, settled],
        onAcknowledgeLease,
      }));
      expect(html).toContain('#7');
      expect(html).toContain(`execution-badge warn">${t.executionSafety.leases.settlement.unknown}`);
      expect(html).toContain('Worker exited without settlement receipt.');
      expect(html).toContain(t.executionSafety.leases.status.settled);
    }

    const compactEmptyLeasesHtml = renderToStaticMarkup(createElement(ExecutionSafetyView, {
      t: MESSAGES.en,
      language: 'en',
      sandbox: null,
      approvals: [],
      leases: [],
      compact: true,
    }));
    expect(compactEmptyLeasesHtml).not.toContain(MESSAGES.en.executionSafety.leases.title);

    const compactQuarantinedHtml = renderToStaticMarkup(createElement(ExecutionSafetyView, {
      t: MESSAGES.en,
      language: 'en',
      sandbox: null,
      approvals: [],
      leases: [quarantined],
      compact: true,
    }));
    expect(compactQuarantinedHtml).toContain(MESSAGES.en.executionSafety.leases.title);
  });

  it('keeps ChatSessionInfo backward compatible when agents is omitted and renders ExecutionSafetyPanel when provided', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const state: HostState = await agents.getState();
    const workspace = state.workspaces[0]!;
    const managedSession = state.sessions.find(item => item.control === 'managed' && !item.runtime)!;

    const legacyTree = ChatSessionInfo({
      t: MESSAGES.en,
      state,
      workspace,
      session: managedSession,
      status: 'Idle',
      files: [],
    });
    expect(elements(legacyTree).some(el => el.type === ExecutionSafetyPanel)).toBe(false);

    const wiredTree = ChatSessionInfo({
      t: MESSAGES.en,
      state,
      workspace,
      session: managedSession,
      status: 'Idle',
      files: [],
      agents,
      language: 'id',
    });
    const panel = elements(wiredTree).find(el => el.type === ExecutionSafetyPanel);
    expect(panel).toBeDefined();
    expect(panel!.props.compact).toBe(true);
    expect(panel!.props.language).toBe('id');
    expect(panel!.props.sessionId).toBe(managedSession.id);

    const observedTree = ChatSessionInfo({
      t: MESSAGES.en,
      state,
      workspace,
      session: { ...managedSession, control: 'observed' },
      status: 'Idle',
      files: [],
      agents,
      language: 'en',
    });
    expect(elements(observedTree).some(el => el.type === ExecutionSafetyPanel)).toBe(false);
  });

  it('wires ExecutionSafetyPanel in SettingsPage General tab only for managed hosts', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const hostState = await platform.capabilities.agents!.getState();

    const managedHtml = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState,
      onHostState: vi.fn(),
      updateStatus: null,
      section: 'general',
    }));
    expect(managedHtml).toContain('aria-labelledby="settings-execution-safety"');
    expect(managedHtml).toContain(MESSAGES.en.executionSafety.title);

    const observeHtml = renderToStaticMarkup(createElement(SettingsPage, {
      t: MESSAGES.en,
      platform,
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      hostState: { ...hostState, workflow: 'observe' },
      onHostState: vi.fn(),
      updateStatus: null,
      section: 'general',
    }));
    expect(observeHtml).not.toContain('settings-execution-safety');
  });

  it('implements listApprovals, revokeApproval, listWorkerLeases, reconcileWorkerLease, and commandSandboxStatus on mockHost', async () => {
    for (const method of EXECUTION_SAFETY_HOST_METHODS) {
      expect(AGENT_HOST_METHODS).toContain(method);
    }

    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(typeof agents.listApprovals).toBe('function');
    expect(typeof agents.revokeApproval).toBe('function');
    expect(typeof agents.listWorkerLeases).toBe('function');
    expect(typeof agents.reconcileWorkerLease).toBe('function');
    expect(typeof agents.commandSandboxStatus).toBe('function');

    const sandbox = await agents.commandSandboxStatus!();
    expect(sandbox).toMatchObject({ supported: true, kind: 'macos-seatbelt', networkAccess: 'denied' });

    const approvals = await agents.listApprovals!();
    const granted = approvals.find(item => item.state === 'granted')!;
    expect(granted).toBeDefined();
    expect(approvals.some(item => item.state === 'consumed')).toBe(true);
    expect((await agents.listApprovals!(granted.sessionId)).every(item => item.sessionId === granted.sessionId)).toBe(true);

    await agents.revokeApproval!(granted.sessionId, granted.approvalId);
    const updatedApprovals = await agents.listApprovals!(granted.sessionId);
    expect(updatedApprovals.find(item => item.approvalId === granted.approvalId)).toMatchObject({
      state: 'revoked',
      revokeReason: 'revoked by user',
    });

    const leases = await agents.listWorkerLeases!();
    const quarantined = leases.find(item => item.status === 'quarantined')!;
    expect(quarantined).toBeDefined();
    expect(quarantined.settlement).toBe('unknown');

    const reconciled = await agents.reconcileWorkerLease!(quarantined.leaseId, 'acknowledge');
    expect(reconciled.status).toBe('settled');
    expect(reconciled.settlement).toBe('unknown');
    expect(reconciled.settledAt).toBeTruthy();
  });

  it('ignores stale session approval loads and tolerates older hosts without execution safety RPCs', async () => {
    hooks.enabled = true;
    const legacyAgents = {} as AgentHostApi;
    const drawLegacy = () => {
      hooks.index = 0;
      const tree = ExecutionSafetyPanel({ t: MESSAGES.en, language: 'en', agents: legacyAgents });
      for (const effect of hooks.pending.splice(0)) effect();
      return tree;
    };
    drawLegacy();
    const legacyView = elements(drawLegacy()).find(el => el.type === ExecutionSafetyView)!;
    expect(legacyView.props.sandbox).toBeNull();
    expect(legacyView.props.approvals).toEqual([]);
    expect(legacyView.props.leases).toEqual([]);

    hooks.values = [];
    hooks.pending = [];
    let resolveSessionA!: (rows: ExactApprovalView[]) => void;
    const listApprovals = vi.fn((sessionId?: string) => {
      if (sessionId === 'session-a') {
        return new Promise<ExactApprovalView[]>(resolve => { resolveSessionA = resolve; });
      }
      return Promise.resolve([makeApproval('granted', 9)]);
    });
    const agents = {
      listApprovals,
      commandSandboxStatus: vi.fn(async () => ({
        supported: true,
        kind: 'macos-seatbelt' as const,
        platform: 'darwin',
        networkAccess: 'denied' as const,
      })),
      listWorkerLeases: vi.fn(async () => []),
    } as unknown as AgentHostApi;

    const drawSession = (sessionId: string) => {
      hooks.index = 0;
      const tree = ExecutionSafetyPanel({ t: MESSAGES.en, language: 'en', agents, sessionId, compact: true });
      for (const effect of hooks.pending.splice(0)) effect();
      return tree;
    };

    drawSession('session-a');
    drawSession('session-b');
    await flushMicrotasks();

    resolveSessionA([{ ...makeApproval('pending', 1), sessionId: 'session-a', approvalId: 'stale-approval-a' }]);
    await flushMicrotasks();

    const finalTree = drawSession('session-b');
    const view = elements(finalTree).find(el => el.type === ExecutionSafetyView)!;
    expect((view.props.approvals as ExactApprovalView[]).map(item => item.approvalId)).toEqual(['appr-granted-9']);
  });
});
