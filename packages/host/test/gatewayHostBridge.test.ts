import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConnectorHealth } from '@extalia/platform';
import { GatewayHostBridge } from '../src/gateway/index.js';
import { GeneralScheduleManager } from '../src/schedules.js';
import { createAgentHost, type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const answer = (text = 'Scheduled task completed.') =>
  Response.json({
    model: 'mock-agent',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  });

const tempDirs: string[] = [];
const runtimes: AgentHostRuntime[] = [];
const managers: GeneralScheduleManager[] = [];
const bridges: GatewayHostBridge[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (runtimes.length) {
    await runtimes.pop()!.close();
  }
  while (managers.length) {
    await managers.pop()!.close();
  }
  while (bridges.length) {
    bridges.pop()!.close();
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitIdle(runtime: AgentHostRuntime): Promise<void> {
  for (let i = 0; i < 250 && runtime.isBusy(); i++) {
    await pause(20);
  }
  expect(runtime.isBusy()).toBe(false);
}

async function setupHost(fetchImpl?: NonNullable<AgentHostOptions['fetch']>) {
  const root = await makeTempDir('extalia-gw-host-');
  const projectA = path.join(root, 'project-alpha');
  const projectB = path.join(root, 'project-beta');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const extaliaHome = path.join(root, 'extalia-home');
  const homeDir = path.join(root, 'home');
  await mkdir(homeDir, { recursive: true });

  const fetchSpy = vi.fn(fetchImpl ?? (async () => answer()));
  const runtime = await createAgentHost({
    kind: 'bridge',
    version: '0.0.0-test',
    homeDirectory: homeDir,
    importHome: homeDir,
    observationIntervalMs: 60_000,
    env: {
      EXTALIA_HOME: extaliaHome,
      EXTALIA_SECRET_STORE: 'memory',
      EXTALIA_HERMES_BIN: path.join(root, 'not-installed'),
    },
    fetch: fetchSpy,
  });
  runtimes.push(runtime);

  const connState = await runtime.host.saveConnection({
    name: 'Mock Provider',
    preset: 'custom',
    api: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'mock-agent',
    credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true },
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  const connection = connState.connections[0]!;

  const noHistoryConnState = await runtime.host.saveConnection({
    name: 'Mock No History',
    preset: 'custom',
    api: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'mock-agent',
    credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: false },
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  const noHistoryConnection = noHistoryConnState.connections.find(c => c.name === 'Mock No History')!;

  const wsAState = await runtime.host.saveWorkspace({
    name: 'Workspace Alpha',
    projectLocation: projectA,
    connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' },
  });
  const workspaceA = wsAState.workspaces.find(w => w.name === 'Workspace Alpha')!;

  const wsBState = await runtime.host.saveWorkspace({
    name: 'Workspace Beta',
    projectLocation: projectB,
    connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' },
  });
  const workspaceB = wsBState.workspaces.find(w => w.name === 'Workspace Beta')!;

  return {
    root,
    runtime,
    fetchSpy,
    connection,
    noHistoryConnection,
    workspaceA,
    workspaceB,
  };
}

describe('GatewayHostBridge & Host Gateway RPCs (Tahap 3: WP-SCH-09..11, GW-WP-13/17)', () => {
  it('supports connector CRUD, raw-secret refusal, 5-dimension ConnectorHealth, principal link lifecycle, route CRUD with workspace guard, and audit log', async () => {
    const { runtime, workspaceA } = await setupHost();
    const { host } = runtime;

    // Initial overview is clean and empty.
    const initial = await host.gatewayOverview!();
    expect(initial.connectors).toEqual([]);
    expect(initial.routes).toEqual([]);
    expect(initial.links).toEqual([]);

    // Raw credentials & webhook URLs are strictly refused.
    await expect(
      host.saveGatewayConnector!({
        provider: 'discord',
        providerAccountId: 'guild-100',
        secretRef: 'https://discord.com/api/webhooks/123456789/raw-webhook-secret-value',
        status: 'connected',
      }),
    ).rejects.toThrow(/opaque secret store reference/i);

    await expect(
      host.saveGatewayConnector!({
        provider: 'telegram',
        providerAccountId: 'tg-bot-1',
        secretRef: '1234567890:AAH_synthetic_raw_bot_token_value_12345',
        status: 'connected',
      }),
    ).rejects.toThrow(/opaque secret store reference/i);

    // Save connector with opaque secretRef.
    const afterSave = await host.saveGatewayConnector!({
      id: 'conn-discord-main',
      provider: 'discord',
      providerAccountId: 'guild-100',
      secretRef: 'keychain:extalia-discord-main',
      status: 'disabled',
    });
    expect(afterSave.connectors).toHaveLength(1);
    const savedConn = afterSave.connectors[0]!;
    expect(savedConn.id).toBe('conn-discord-main');
    expect(savedConn.secretRef).toBe('keychain:extalia-discord-main');
    expect(savedConn.status).toBe('disabled');
    expect(savedConn.health).toBeDefined();
    expect(validateConnectorHealth(savedConn.health).ok).toBe(true);
    expect(savedConn.health!.transport.status).toBe('disconnected');
    expect(savedConn.health!.host.status).toBe('healthy');
    expect(savedConn.health!.notification.status).toBe('disconnected');

    // Update status -> connected and verify 5-dimension ConnectorHealth updates independently.
    const afterStatus = await host.setGatewayConnectorStatus!('conn-discord-main', 'connected');
    const activeConn = afterStatus.connectors[0]!;
    expect(activeConn.status).toBe('connected');
    expect(validateConnectorHealth(activeConn.health).ok).toBe(true);
    expect(activeConn.health!.transport.status).toBe('healthy');
    expect(activeConn.health!.host.status).toBe('healthy');
    expect(activeConn.health!.runtime.status).toBe('healthy');
    expect(activeConn.health!.progress.status).toBe('healthy');
    expect(activeConn.health!.notification.status).toBe('healthy');

    // Principal link lifecycle: challenge -> confirm -> replay refused -> revoke.
    const challenge = await host.issueGatewayLinkChallenge!({
      connectorId: 'conn-discord-main',
      ttlSeconds: 300,
    });
    expect(challenge.challengeId).toMatch(/^chl_/);
    expect(challenge.code.length).toBeGreaterThanOrEqual(16);
    expect(challenge.connectorId).toBe('conn-discord-main');

    const afterConfirm = await host.confirmGatewayPrincipalLink!({
      challengeId: challenge.challengeId,
      providerAccountId: 'guild-100',
      externalActorId: 'discord-user-42',
      permissionBands: ['read_status', 'view_reports', 'submit_prompt'],
      ttlSeconds: 3600,
    });
    expect(afterConfirm.links).toHaveLength(1);
    const link = afterConfirm.links[0]!;
    expect(link.state).toBe('active');
    expect(link.externalActorId).toBe('discord-user-42');
    expect(link.permissionBands).toEqual(['read_status', 'view_reports', 'submit_prompt']);

    // Replaying the consumed challenge fails cleanly.
    await expect(
      host.confirmGatewayPrincipalLink!({
        challengeId: challenge.challengeId,
        providerAccountId: 'guild-100',
        externalActorId: 'discord-user-99',
        permissionBands: ['read_status'],
      }),
    ).rejects.toThrow(/not awaiting confirmation/i);

    const afterRevoke = await host.revokeGatewayPrincipalLink!(link.id, 'rotated-operator');
    expect(afterRevoke.links[0]!.state).toBe('revoked');
    expect(afterRevoke.links[0]!.revocationReason).toBe('rotated-operator');

    // Route save rejects unregistered workspaces.
    await expect(
      host.saveGatewayRoute!({
        connectorId: 'conn-discord-main',
        providerAccountId: 'guild-100',
        channelId: 'chan-unregistered',
        workspaceId: 'ws-does-not-exist',
      }),
    ).rejects.toThrow(/workspace/i);

    // Route create -> update (bumps policyRevision) -> delete.
    const afterRouteCreate = await host.saveGatewayRoute!({
      id: 'rte-alpha-1',
      connectorId: 'conn-discord-main',
      providerAccountId: 'guild-100',
      channelId: 'chan-ops',
      workspaceId: workspaceA.id,
      mode: 'explicit-only',
      audience: 'private',
      inboundEnabled: true,
      outboundEnabled: true,
    });
    expect(afterRouteCreate.routes).toHaveLength(1);
    expect(afterRouteCreate.routes[0]!.policyRevision).toBe(1);

    const afterRouteUpdate = await host.saveGatewayRoute!({
      id: 'rte-alpha-1',
      connectorId: 'conn-discord-main',
      providerAccountId: 'guild-100',
      channelId: 'chan-ops',
      workspaceId: workspaceA.id,
      mode: 'reuse-pinned',
      audience: 'team',
      inboundEnabled: false,
      outboundEnabled: true,
    });
    expect(afterRouteUpdate.routes).toHaveLength(1);
    expect(afterRouteUpdate.routes[0]!.policyRevision).toBe(2);
    expect(afterRouteUpdate.routes[0]!.mode).toBe('reuse-pinned');
    expect(afterRouteUpdate.routes[0]!.inboundEnabled).toBe(false);

    const afterRouteDelete = await host.deleteGatewayRoute!('rte-alpha-1');
    expect(afterRouteDelete.routes).toEqual([]);

    // Audit log recorded the lifecycle operations without leaking raw secrets.
    const actions = afterRouteDelete.recentAudit.map(entry => entry.action);
    expect(actions).toContain('connector.created');
    expect(actions).toContain('connector.status.changed');
    expect(actions).toContain('principal.challenge.issued');
    expect(actions).toContain('principal.link.confirmed');
    expect(actions).toContain('principal.link.revoked');
    expect(actions).toContain('route.created');
    expect(actions).toContain('route.updated');
    expect(actions).toContain('route.deleted');
  });

  it('fans out settled schedule run to last-eligible same-workspace Chat + persists ScheduleDeliveryV1, enforces GW-AT-083 workspace isolation and GW-AT-088 zero feedback loop', async () => {
    const { runtime, fetchSpy, workspaceA, workspaceB } = await setupHost(async () =>
      answer('Daily health check succeeded.'),
    );
    const { host } = runtime;

    // Create a managed Native session in Workspace A (eligible destination).
    const sessionA = await host.createSession(workspaceA.id);
    await pause(25);
    // Create a newer managed Native session in Workspace B -> must NEVER receive Workspace A's report (GW-AT-083).
    const sessionB = await host.createSession(workspaceB.id);

    // Configure an active Discord connector + outbound route and a WhatsApp connector + route (fail-closed) for Workspace A.
    await host.saveGatewayConnector!({
      id: 'conn-disc-a',
      provider: 'discord',
      providerAccountId: 'guild-alpha',
      secretRef: 'keychain:discord-alpha',
      status: 'connected',
    });
    await host.saveGatewayRoute!({
      id: 'rte-disc-a',
      connectorId: 'conn-disc-a',
      providerAccountId: 'guild-alpha',
      channelId: 'chan-alpha-reports',
      workspaceId: workspaceA.id,
      outboundEnabled: true,
    });

    await host.saveGatewayConnector!({
      id: 'conn-wa-a',
      provider: 'whatsapp',
      providerAccountId: 'waba-alpha',
      secretRef: 'keychain:whatsapp-alpha',
      status: 'connected',
    });
    await host.saveGatewayRoute!({
      id: 'rte-wa-a',
      connectorId: 'conn-wa-a',
      providerAccountId: 'waba-alpha',
      channelId: 'wa-chan-alpha',
      workspaceId: workspaceA.id,
      outboundEnabled: true,
    });

    // Save a schedule in Workspace A targeting sessionA and run it now.
    const catalog = await host.saveSchedule!({
      workspaceId: workspaceA.id,
      name: 'Alpha Daily Check',
      prompt: 'Summarize repository status.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: sessionA.id },
      assignment: { teamMode: 'solo' },
      missedPolicy: 'skip',
    });
    const schedule = catalog.schedules[0]!;

    await host.runScheduleNow!(schedule.id, schedule.revision);
    await waitIdle(runtime);

    // Schedule run settled cleanly in SQLite ledger with persisted deliveries.
    const runPage = await host.listScheduleRuns!({ workspaceId: workspaceA.id, scheduleId: schedule.id });
    expect(runPage.total).toBe(1);
    const settledRun = runPage.runs[0]!;
    expect(settledRun.state).toBe('completed');

    const detail = await host.scheduleRunDetail!(settledRun.id);
    expect(detail.run.state).toBe('completed');
    expect(detail.deliveries).toHaveLength(2);
    const discordDelivery = detail.deliveries.find(d => d.destinationBindingId === 'rte-disc-a');
    const waDelivery = detail.deliveries.find(d => d.destinationBindingId === 'rte-wa-a');
    expect(discordDelivery?.state).toBe('pending');
    expect(discordDelivery?.targetChannelId).toBe('chan-alpha-reports');
    // WhatsApp defaults fail-closed (waEnabled: false) -> blocked/failed delivery receipt without sending.
    expect(waDelivery?.state).toBe('failed');
    expect(waDelivery?.lastErrorCode).toBe('policy_blocked');

    // Canonical WorkspaceSystemReport projected to Workspace A's eligible Chat.
    const wsAReports = await host.listWorkspaceReports!(workspaceA.id);
    expect(wsAReports.reports).toHaveLength(1);
    const report = wsAReports.reports[0]!;
    expect(report.source).toBe('schedule-run');
    expect(report.sourceRunId).toBe(settledRun.id);
    expect(report.workspaceId).toBe(workspaceA.id);
    expect(report.targetChatId).toBe(sessionA.id);
    expect(report.outcome).toBe('completed');
    expect(wsAReports.projections).toHaveLength(1);
    expect(wsAReports.projections[0]!.chatId).toBe(sessionA.id);

    const sessionAReports = await host.listSessionSystemReports!(workspaceA.id, sessionA.id);
    expect(sessionAReports.reports).toHaveLength(1);
    expect(sessionAReports.reports[0]!.id).toBe(report.id);

    // GW-AT-083: Workspace B (despite having a newer session) received ZERO reports.
    const wsBReports = await host.listWorkspaceReports!(workspaceB.id);
    expect(wsBReports.reports).toEqual([]);
    expect(wsBReports.projections).toEqual([]);
    const sessionBReports = await host.listSessionSystemReports!(workspaceB.id, sessionB.id);
    expect(sessionBReports.reports).toEqual([]);

    // GW-AT-088: Zero feedback loop — report projection submitted zero extra prompts, zero extra LLM completions, and zero learning jobs.
    const completionCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));
    expect(completionCalls).toHaveLength(1);
    const eventsA = await host.sessionEvents(sessionA.id);
    const submittedPrompts = eventsA.filter(e => e.body.type === 'prompt.submitted');
    expect(submittedPrompts).toHaveLength(1);
    const learningSnapshot = await host.learningSchedule!();
    expect(learningSnapshot.jobs).toEqual([]);
  });

  it('GW-AT-091: delivery/fanout failure inside onRunSettled never alters or reverts the settled schedule run state', async () => {
    const root = await makeTempDir('extalia-gw-at091-');
    const configDir = path.join(root, 'config');
    const stateDir = path.join(root, 'state');
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const onRunSettled = vi.fn(async () => {
      throw new Error('Simulated gateway/delivery subsystem outage');
    });

    const manager = new GeneralScheduleManager({
      directory: configDir,
      stateDirectory: stateDir,
      callbacks: {
        validateWorkspace: () => undefined,
        resolveSession: async () => ({ sessionId: 's_fixture123' }),
        dispatchPrompt: async () => ({
          correlationId: 'corr-at091',
          runtimeId: 'extalia-native',
          executionGeneration: 'gen-1',
        }),
        onRunSettled,
      },
    });
    managers.push(manager);
    await manager.initialize();

    const catalog = await manager.save({
      workspaceId: 'ws-at091',
      name: 'Isolated Settlement Check',
      prompt: 'Run nightly diagnostics.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'existing', sessionId: 's_fixture123' },
      assignment: { teamMode: 'solo' },
      missedPolicy: 'skip',
    });
    const schedule = catalog.schedules[0]!;
    await manager.runNow(schedule.id, schedule.revision);

    const dispatchedPage = await manager.listScheduleRuns({ workspaceId: 'ws-at091', scheduleId: schedule.id });
    const run = dispatchedPage.runs[0]!;
    expect(run.state).toBe('dispatched');

    // Settling the turn succeeds even though onRunSettled throws.
    const settled = await manager.recordTurnSettled(
      { sessionId: 's_fixture123', correlationId: 'corr-at091', executionGeneration: 'gen-1' },
      'completed',
    );
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(settled.state).toBe('completed');

    // Persisted ledger state remains durably `completed` and completedRunCount incremented.
    const detail = await manager.scheduleRunDetail(run.id);
    expect(detail?.run.state).toBe('completed');
    expect((await manager.list()).schedules[0]?.completedRunCount).toBe(1);
  });

  it('fans out learning outcome strictly within source workspace, excludes unsaved/observed sessions, and preserves zero feedback loops', async () => {
    const root = await makeTempDir('extalia-gw-learn-');
    const registered = new Set(['ws-alpha', 'ws-beta']);
    const bridge = await GatewayHostBridge.open({
      dbPath: path.join(root, 'state', 'gateway.sqlite'),
      validateWorkspace: id => {
        if (!registered.has(id)) throw new Error(`Unknown workspace ${id}`);
      },
      listRegisteredWorkspaceIds: () => registered,
      now: () => '2026-11-26T12:00:00.000Z',
    });
    bridges.push(bridge);

    const res = bridge.fanoutLearningOutcome({
      workspaceId: 'ws-alpha',
      sourceJobId: 'learn-job-1',
      sourceSessionId: 's_alpha_saved',
      learningResult: {
        knowledge: {
          status: 'saved',
          path: 'Learning/ws-alpha/pattern.md',
          indexed: true,
        },
        skill: {
          id: 'notice-1',
          profileId: 'default',
          workspaceId: 'ws-alpha',
          sessionId: 's_alpha_saved',
          runId: 'run-1',
          createdAt: '2026-11-26T11:59:00.000Z',
          kind: 'skill-candidate',
          packageId: 'pkg-alpha',
          revisionId: 'rev-1',
          state: 'review-required',
          change: 'new',
          activationPerformed: false,
        },
      },
      sessions: [
        // Newer session in ws-beta -> rejected (wrong-workspace).
        {
          id: 's_beta_newest',
          workspaceId: 'ws-beta',
          lastActiveAt: '2026-11-26T11:59:59.000Z',
          historyEnabled: true,
          isNative: true,
        },
        // Newer observed session in ws-alpha -> rejected (observed-immutable-transcript).
        {
          id: 's_alpha_obs',
          workspaceId: 'ws-alpha',
          lastActiveAt: '2026-11-26T11:59:50.000Z',
          historyEnabled: false,
          isObserved: true,
          isNative: false,
        },
        // Newer unsaved session in ws-alpha -> rejected (history-disabled).
        {
          id: 's_alpha_unsaved',
          workspaceId: 'ws-alpha',
          lastActiveAt: '2026-11-26T11:59:40.000Z',
          historyEnabled: false,
          isNative: true,
        },
        // Eligible managed Native session in ws-alpha.
        {
          id: 's_alpha_saved',
          workspaceId: 'ws-alpha',
          lastActiveAt: '2026-11-26T11:50:00.000Z',
          historyEnabled: true,
          isNative: true,
        },
      ],
      audienceScopeId: 'profile:default',
      nowIso: '2026-11-26T12:00:00.000Z',
    });

    expect(res.triggeredPromptSubmitted).toBe(false);
    expect(res.triggeredLearning).toBe(false);
    expect(res.report.workspaceId).toBe('ws-alpha');
    expect(res.report.targetChatId).toBe('s_alpha_saved');
    expect(res.report.skills?.[0]?.activationPerformed).toBe(false);

    const alphaSessionReports = bridge.listSessionSystemReports('ws-alpha', 's_alpha_saved');
    expect(alphaSessionReports.reports).toHaveLength(1);
    const betaInbox = bridge.listWorkspaceReports('ws-beta');
    expect(betaInbox.reports).toEqual([]);
  });
});
