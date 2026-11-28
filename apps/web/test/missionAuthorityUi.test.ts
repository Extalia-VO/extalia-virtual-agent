import type * as React from 'react';
import {
  MISSION_RECONCILIATION_DECISIONS,
  MISSION_WAIVER_DEFAULT_TTL_MS,
  type AgentHostApi,
  type HostMissionRun,
  type MissionAuthorityOverview,
  type MissionReconciliationPreview,
  type MissionReconciliationReceipt,
  type SessionSummary,
} from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { MissionAuthorityPanel, MissionAuthorityView } from '../src/missions/MissionAuthorityPanel';
import { MissionMonitor } from '../src/missions/MissionMonitor';
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
    useId: () => {
      if (!hooks.enabled) return actual.useId();
      hooks.index++;
      return 'mission-authority-test';
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

vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: [] }) }));

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
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const at = '2026-11-28T12:00:00.000Z';

function sampleRun(): HostMissionRun {
  return {
    id: '90000000-0000-4000-8000-000000000001',
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    title: 'Recover mission test',
    state: 'recovering',
    createdAt: at,
    updatedAt: at,
    transient: false,
    recovery: { source: 'host-restart', at },
    tasks: [
      {
        id: 'build',
        taskId: '90000000-0000-4000-8000-000000000101',
        agentId: '90000000-0000-4000-8000-000000000201',
        title: 'Build package',
        connectionId: 'conn-1',
        model: 'mock-model',
        state: 'completed',
        verification: 'unverified',
        evidenceIds: ['ev-observed-1'],
      },
      {
        id: 'release',
        taskId: '90000000-0000-4000-8000-000000000102',
        agentId: '90000000-0000-4000-8000-000000000202',
        title: 'Release artifacts',
        dependsOn: ['build'],
        connectionId: 'conn-1',
        model: 'mock-model',
        state: 'unknown',
        evidenceIds: [],
      },
    ],
  };
}

function sampleOverview(): MissionAuthorityOverview {
  const run = sampleRun();
  return {
    missionId: run.id,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    reviewDigest: 'abcd1234'.repeat(8),
    verifiedComplete: false,
    evidence: [
      {
        evidenceId: 'ev-observed-1',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[0]!.taskId,
        sourceKind: 'observed-claim',
        validation: 'passed',
        acceptance: 'unverified',
        contentSha256: 'e'.repeat(64),
        summary: 'Agent claimed build succeeded.',
        recordedAt: at,
        verifiedByHost: false,
      },
      {
        evidenceId: 'ev-host-1',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[1]!.taskId,
        sourceKind: 'test-report',
        validation: 'failed',
        acceptance: 'rejected',
        contentSha256: 'f'.repeat(64),
        artifactPath: 'reports/release.json',
        summary: 'Release verification failed.',
        recordedAt: at,
        verifiedByHost: true,
      },
    ],
    waivers: [
      {
        waiverId: 'wv-1234567890ab',
        missionId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        taskId: run.tasks[0]!.taskId,
        actor: 'operator',
        reason: 'Manual verification done',
        policyVersion: 'v1',
        scope: 'dependency-release',
        reviewDigest: 'abcd1234'.repeat(8),
        grantedAt: at,
        expiresAt: '2026-11-28T13:00:00.000Z',
      },
    ],
    taskGates: [
      {
        id: 'build',
        taskId: run.tasks[0]!.taskId,
        title: 'Build package',
        state: 'completed',
        executionOutcome: 'succeeded',
        validation: 'not_run',
        acceptance: 'waived',
        legacyUnverified: true,
        evidenceCount: 1,
        activeWaiverId: 'wv-1234567890ab',
        dependencyBlockedBy: [],
        dependencyReleaseEligible: true,
      },
      {
        id: 'release',
        taskId: run.tasks[1]!.taskId,
        title: 'Release artifacts',
        state: 'unknown',
        executionOutcome: 'unknown',
        validation: 'failed',
        acceptance: 'rejected',
        legacyUnverified: false,
        evidenceCount: 1,
        dependencyBlockedBy: ['build'],
        dependencyReleaseEligible: false,
      },
    ],
  };
}

function samplePreview(): MissionReconciliationPreview {
  const run = sampleRun();
  return {
    missionId: run.id,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    currentState: 'recovering',
    recoverySource: 'host-restart',
    reviewDigest: 'abcd1234'.repeat(8),
    taskSummaries: [],
    activeLeaseIds: [],
    quarantinedLeaseIds: ['wl-q1'],
    eligibleDecisions: [...MISSION_RECONCILIATION_DECISIONS],
    warnings: ['Quarantined worker lease present.'],
  };
}

function sampleReceipt(): MissionReconciliationReceipt {
  const run = sampleRun();
  return {
    receiptId: 'rcpt-001122334455',
    missionId: run.id,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    reviewDigest: 'abcd1234'.repeat(8),
    decisionKey: 'dk-1',
    decision: 'mark-failed',
    previousState: 'recovering',
    resultingState: 'failed',
    actor: 'operator',
    reason: 'Verified shutdown',
    committedAt: at,
    worktreesReleased: false,
    replayedTasks: false,
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

describe('Mission Authority UI & Mock Host (V2-04 / V2-06)', () => {
  it('renders EN and ID copy symmetrically without cross-locale leakage', () => {
    const run = sampleRun();
    const overview = sampleOverview();
    const preview = samplePreview();
    const receipt = sampleReceipt();

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const m = t.missionAuthority;
      const html = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(MissionAuthorityView, {
            t,
            language,
            run,
            overview,
            preview,
            reconciliationForm: { decision: 'mark-failed', actor: 'operator', reason: 'Confirmed stopped' },
            committedReceipt: null,
            staleDigestBanner: true,
            waiverForm: {
              actor: 'operator',
              reason: '',
              policyVersion: 'v1',
              scope: 'dependency-release',
              ttlMs: MISSION_WAIVER_DEFAULT_TTL_MS,
            },
            canPreviewReconciliation: true,
            canCommitReconciliation: true,
            canGrantWaiver: true,
            canRevokeWaiver: true,
          }),
        ),
      );
      const plain = html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

      expect(plain).toContain(m.title);
      expect(plain).toContain(m.unverified);
      expect(plain).toContain(m.reviewDigestLabel);
      expect(plain).toContain(overview.reviewDigest.slice(0, 12));
      expect(plain).toContain(m.reconciliation.heading);
      expect(plain).toContain(m.reconciliation.disclaimer);
      expect(plain).toContain(m.reconciliation.staleBanner);
      expect(plain).toContain(m.reconciliation.decisions['mark-failed']);
      expect(plain).toContain(m.reconciliation.decisions['mark-cancelled']);
      expect(plain).toContain(m.reconciliation.decisions['retain-quarantine']);
      expect(plain).toContain(m.tasks.legacyUnverifiedNote);
      expect(plain).toContain(m.tasks.evidenceObservedUnverified);
      expect(plain).toContain(m.tasks.evidenceHostVerified);
      expect(plain).toContain(m.tasks.dependencyBlockedBy('build'));
      expect(plain).toContain(m.tasks.dependencyEligible);
      expect(plain).toContain(m.waivers.activeBadge);
      expect(plain).toContain(m.waivers.revoke);
      expect(plain).toContain(m.waivers.grantToggle);

      const other = MESSAGES[language === 'en' ? 'id' : 'en'].missionAuthority;
      expect(plain).not.toContain(other.title);
      expect(plain).not.toContain(other.tasks.evidenceObservedUnverified);
      expect(plain).not.toContain(other.waivers.grantToggle);

      // Receipt rendering check
      const receiptHtml = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(MissionAuthorityView, {
            t,
            language,
            run: { ...run, state: 'failed' },
            overview: { ...overview, reconciliationReceipt: receipt },
            preview,
            reconciliationForm: { decision: 'mark-failed', actor: 'operator', reason: 'Confirmed stopped' },
            committedReceipt: receipt,
            idempotentReplay: true,
            waiverForm: {
              actor: 'operator',
              reason: '',
              policyVersion: 'v1',
              scope: 'dependency-release',
              ttlMs: MISSION_WAIVER_DEFAULT_TTL_MS,
            },
          }),
        ),
      );
      const receiptPlain = receiptHtml.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
      expect(receiptPlain).toContain(m.reconciliation.receiptHeading);
      expect(receiptPlain).toContain(m.reconciliation.receiptIdempotent);
      expect(receiptPlain).toContain(receipt.receiptId);
      expect(receiptPlain).toContain('worktreesReleased: false · replayedTasks: false');
    }
  });

  it('enforces AR-07 stale digest refusal, AR-08 idempotent replay, AR-13 observed non-verification, and AR-12 dependency gates in mockHost', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop', missions: true });
    const agents = platform.capabilities.agents!;
    const state = await agents.getState();
    const session = state.sessions.find(item => item.control === 'managed' && !item.runtime)!;
    const runs = await agents.listNativeMissions(session.id);
    const recovering = runs.find(item => item.state === 'recovering')!;
    expect(recovering).toBeDefined();

    const initialOverview = await agents.missionAuthorityOverview!(session.id, recovering.id);
    expect(initialOverview.verifiedComplete).toBe(false);
    expect(initialOverview.evidence[0]?.sourceKind).toBe('observed-claim');
    expect(initialOverview.evidence[0]?.verifiedByHost).toBe(false);
    expect(initialOverview.evidence[0]?.acceptance).toBe('unverified');
    expect(initialOverview.taskGates[0]?.legacyUnverified).toBe(true);
    expect(initialOverview.taskGates[1]?.dependencyBlockedBy).toEqual(['verify-build']);
    expect(initialOverview.taskGates[1]?.dependencyReleaseEligible).toBe(false);

    // AR-13: recording another observed-claim with validation='passed' still never verifies or unblocks downstream.
    const afterObserved = await agents.recordMissionEvidence!({
      sessionId: session.id,
      missionId: recovering.id,
      taskId: recovering.tasks[0]!.taskId,
      sourceKind: 'observed-claim',
      validation: 'passed',
      contentSha256: '1'.repeat(64),
      summary: 'Observed agent self-report.',
    });
    expect(afterObserved.taskGates[0]?.acceptance).toBe('unverified');
    expect(afterObserved.taskGates[0]?.legacyUnverified).toBe(true);
    expect(afterObserved.taskGates[1]?.dependencyReleaseEligible).toBe(false);

    // AR-07: committing reconciliation with the old digest fails with stale-review-digest.
    const staleCommit = await agents.commitMissionReconciliation!({
      sessionId: session.id,
      missionId: recovering.id,
      expectedReviewDigest: initialOverview.reviewDigest,
      decisionKey: 'reconcile-stale-check',
      decision: 'mark-failed',
      actor: 'operator',
      reason: 'Stale test',
    });
    expect(staleCommit.ok).toBe(false);
    if (!staleCommit.ok) {
      expect(staleCommit.code).toBe('stale-review-digest');
      expect(staleCommit.currentReviewDigest).toBe(afterObserved.reviewDigest);
    }

    // AR-12: failed host-verified evidence rejects the task and keeps downstream blocked.
    const afterFailedEvidence = await agents.recordMissionEvidence!({
      sessionId: session.id,
      missionId: recovering.id,
      taskId: recovering.tasks[0]!.taskId,
      sourceKind: 'test-report',
      validation: 'failed',
      contentSha256: '2'.repeat(64),
      summary: 'Smoke test failed.',
    });
    expect(afterFailedEvidence.taskGates[0]?.acceptance).toBe('rejected');
    expect(afterFailedEvidence.taskGates[1]?.dependencyBlockedBy).toEqual(['verify-build']);
    expect(afterFailedEvidence.taskGates[1]?.dependencyReleaseEligible).toBe(false);

    // Waiver grant unlocks downstream dependency release, and revoke restores blocked state.
    const afterWaiver = await agents.grantMissionWaiver!({
      sessionId: session.id,
      missionId: recovering.id,
      taskId: recovering.tasks[0]!.taskId,
      expectedReviewDigest: afterFailedEvidence.reviewDigest,
      actor: 'operator',
      reason: 'Accepted known smoke failure',
      policyVersion: 'v1',
      scope: 'dependency-release',
      ttlMs: MISSION_WAIVER_DEFAULT_TTL_MS,
    });
    expect(afterWaiver.taskGates[0]?.acceptance).toBe('waived');
    expect(afterWaiver.taskGates[1]?.dependencyReleaseEligible).toBe(true);
    expect(afterWaiver.verifiedComplete).toBe(false);

    const waiverId = afterWaiver.waivers[0]!.waiverId;
    const afterRevoke = await agents.revokeMissionWaiver!(session.id, recovering.id, waiverId);
    expect(afterRevoke.waivers[0]?.revokedAt).toBeDefined();
    expect(afterRevoke.taskGates[0]?.acceptance).toBe('rejected');
    expect(afterRevoke.taskGates[1]?.dependencyReleaseEligible).toBe(false);

    // AR-08: commit reconciliation with latest digest, replay idempotently, and refuse conflicting decision.
    const preview = await agents.previewMissionReconciliation!(session.id, recovering.id);
    expect(preview.reviewDigest).toBe(afterRevoke.reviewDigest);
    expect(preview.eligibleDecisions).toEqual(['mark-failed', 'mark-cancelled', 'retain-quarantine']);

    const commit = await agents.commitMissionReconciliation!({
      sessionId: session.id,
      missionId: recovering.id,
      expectedReviewDigest: preview.reviewDigest,
      decisionKey: 'reconcile-key-1',
      decision: 'mark-failed',
      actor: 'operator',
      reason: 'Verified worker stop',
    });
    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.idempotentReplay).toBe(false);
      expect(commit.receipt.worktreesReleased).toBe(false);
      expect(commit.receipt.replayedTasks).toBe(false);
      expect(commit.run.state).toBe('failed');
    }

    const replay = await agents.commitMissionReconciliation!({
      sessionId: session.id,
      missionId: recovering.id,
      expectedReviewDigest: preview.reviewDigest,
      decisionKey: 'reconcile-key-1',
      decision: 'mark-failed',
      actor: 'operator',
      reason: 'Verified worker stop',
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.idempotentReplay).toBe(true);
    }

    const conflict = await agents.commitMissionReconciliation!({
      sessionId: session.id,
      missionId: recovering.id,
      expectedReviewDigest: preview.reviewDigest,
      decisionKey: 'reconcile-key-2',
      decision: 'mark-cancelled',
      actor: 'operator',
      reason: 'Different decision',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe('already-reconciled');
    }
  });

  it('drives MissionAuthorityPanel lifecycle: load, waiver grant/revoke, reconciliation commit, and stale async guard', async () => {
    hooks.enabled = true;
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop', missions: true });
    const agents = platform.capabilities.agents!;
    const state = await agents.getState();
    const session = state.sessions.find(item => item.control === 'managed' && !item.runtime)!;
    let currentRun = (await agents.listNativeMissions(session.id)).find(item => item.state === 'recovering')!;
    const onRunUpdated = vi.fn((next: HostMissionRun) => {
      currentRun = next;
    });

    let pendingOp: Promise<unknown> = Promise.resolve();
    const track = <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) =>
      vi.fn((...args: Args) => {
        const promise = fn(...args);
        pendingOp = promise;
        return promise;
      });
    const overviewSpy = track(agents.missionAuthorityOverview!.bind(agents));
    const previewSpy = track(agents.previewMissionReconciliation!.bind(agents));
    const grantSpy = track(agents.grantMissionWaiver!.bind(agents));
    const revokeSpy = track(agents.revokeMissionWaiver!.bind(agents));
    const commitSpy = track(agents.commitMissionReconciliation!.bind(agents));
    agents.missionAuthorityOverview = overviewSpy;
    agents.previewMissionReconciliation = previewSpy;
    agents.grantMissionWaiver = grantSpy;
    agents.revokeMissionWaiver = revokeSpy;
    agents.commitMissionReconciliation = commitSpy;

    const draw = () => {
      hooks.index = 0;
      const viewEl = MissionAuthorityPanel({
        t: MESSAGES.en,
        language: 'en',
        agents,
        run: currentRun,
        onRunUpdated,
      }) as ReactElement<Parameters<typeof MissionAuthorityView>[0]>;
      const rendered = MissionAuthorityView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };

    const waitOp = async () => {
      await flushMicrotasks();
      await pendingOp;
      await flushMicrotasks();
    };

    draw();
    await waitOp();
    let tree = draw();

    expect(overviewSpy).toHaveBeenCalledWith(session.id, currentRun.id);
    expect(previewSpy).toHaveBeenCalledWith(session.id, currentRun.id);
    expect(textContent(tree)).toContain(MESSAGES.en.missionAuthority.tasks.evidenceObservedUnverified);

    // Open inline waiver form on first task, fill reason, submit -> active waiver & unblocked downstream
    const grantToggle = elements(tree).find(el => el.type === 'button' && textContent(el).includes(MESSAGES.en.missionAuthority.waivers.grantToggle))!;
    (grantToggle.props.onClick as () => void)();
    tree = draw();

    const waiverFormEl = elements(tree).find(el => el.type === 'form' && String(el.props.className).includes('mission-authority-waiver-form'))!;
    const reasonInput = elements(waiverFormEl).filter(el => el.type === 'input').at(-1)!;
    (reasonInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Manual check passed' } });
    tree = draw();

    const waiverFormAfter = elements(tree).find(el => el.type === 'form' && String(el.props.className).includes('mission-authority-waiver-form'))!;
    (waiverFormAfter.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await waitOp();
    tree = draw();
    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(textContent(tree)).toContain(MESSAGES.en.missionAuthority.waivers.activeBadge);
    expect(textContent(tree)).toContain(MESSAGES.en.missionAuthority.waivers.revoke);

    // Revoke the waiver
    const revokeBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(MESSAGES.en.missionAuthority.waivers.revoke))!;
    (revokeBtn.props.onClick as () => void)();
    await waitOp();
    tree = draw();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(textContent(tree)).toContain(MESSAGES.en.missionAuthority.waivers.revokedBadge);

    // Commit reconciliation
    const reconcileForm = elements(tree).find(el => el.type === 'form' && String(el.props.className).includes('mission-authority-form'))!;
    const reconcileInputs = elements(reconcileForm).filter(el => el.type === 'input' && el.props.type === 'text');
    (reconcileInputs[1]!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Confirmed stopped after restart' } });
    tree = draw();

    const reconcileFormAfter = elements(tree).find(el => el.type === 'form' && String(el.props.className).includes('mission-authority-form'))!;
    (reconcileFormAfter.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await waitOp();
    tree = draw();
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(onRunUpdated).toHaveBeenCalledTimes(1);
    expect(currentRun.state).toBe('failed');
    expect(textContent(tree)).toContain(MESSAGES.en.missionAuthority.reconciliation.receiptHeading);

    // Stale async response guard test
    hooks.index = 0;
    hooks.values = [];
    hooks.pending = [];
    let resolveFirst!: (value: MissionAuthorityOverview) => void;
    let resolveSecond!: (value: MissionAuthorityOverview) => void;
    let call = 0;
    const baseOverview = sampleOverview();
    const guardAgents: AgentHostApi = {
      ...agents,
      missionAuthorityOverview: vi.fn(() => new Promise<MissionAuthorityOverview>(resolve => {
        call += 1;
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      })),
      previewMissionReconciliation: undefined,
    };
    const drawGuard = () => {
      hooks.index = 0;
      const viewEl = MissionAuthorityPanel({
        t: MESSAGES.en,
        language: 'en',
        agents: guardAgents,
        run: sampleRun(),
      }) as ReactElement<Parameters<typeof MissionAuthorityView>[0]>;
      const rendered = MissionAuthorityView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };

    let guardTree = drawGuard();
    const refreshBtn = elements(guardTree).find(el => el.type === 'button' && el.props['aria-label'] === MESSAGES.en.missionAuthority.refresh)!;
    (refreshBtn.props.onClick as () => void)();
    drawGuard();

    resolveSecond({ ...baseOverview, reviewDigest: 'b'.repeat(64) });
    await flushMicrotasks();
    guardTree = drawGuard();
    expect(textContent(guardTree)).toContain('bbbbbbbbbbbb');

    resolveFirst({ ...baseOverview, reviewDigest: 'c'.repeat(64) });
    await flushMicrotasks();
    guardTree = drawGuard();
    expect(textContent(guardTree)).toContain('bbbbbbbbbbbb');
    expect(textContent(guardTree)).not.toContain('cccccccccccc');
  });

  it('degrades cleanly on legacy hosts without missionAuthorityOverview', () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const legacyAgents = { ...platform.capabilities.agents! };
    delete legacyAgents.missionAuthorityOverview;

    hooks.enabled = true;
    hooks.index = 0;
    expect(MissionAuthorityPanel({ t: MESSAGES.en, language: 'en', agents: legacyAgents, run: sampleRun() })).toBeNull();

    hooks.enabled = false;
    const html = renderToStaticMarkup(
      createElement(
        MessagesContext.Provider,
        { value: MESSAGES.en },
        createElement(MissionMonitor, {
          t: MESSAGES.en,
          language: 'en',
          agents: legacyAgents,
          session: { id: 'session-1' } as SessionSummary,
          connections: [],
          initial: sampleRun(),
          onBack: () => {},
          onChanged: () => {},
        }),
      ),
    );
    expect(html).not.toContain(MESSAGES.en.missionAuthority.title);
  });
});
