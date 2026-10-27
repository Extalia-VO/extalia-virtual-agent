import { describe, expect, it } from 'vitest';
import {
  approvalMatchesToolCall, ORCHESTRATION_SCHEMA_VERSION, parseEvent, parseOrchestration,
  PROTOCOL_VERSION, type OrchestrationContractKind, type OrchestrationContracts,
  type Task,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:01:00.000Z';
const end = '2026-01-01T00:02:00.000Z';
const version = { schemaVersion: ORCHESTRATION_SCHEMA_VERSION };
const capability = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: false, delegate: false };
const task: Task = { ...version, id: id(5), missionId: id(2), dependsOn: [], state: 'queued', attempt: 0, requirements: ['Build artifact'], evidenceIds: [] };
const mission = { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'draft', createdAt: at, updatedAt: at, version: 1 } as const;
const agent = { ...version, id: id(3), origin: 'native', role: 'lead', workspaceId: id(1), engineId: 'extalia-native', modelProfileId: id(6), capabilities: capability } as const;
const provider = { ...version, id: id(7), adapterId: 'provider-a', maxConcurrency: 3 };
const model = { ...version, id: id(6), providerId: id(7), model: 'model-a', toolCalling: true, streaming: true, vision: false, contextTokens: 32_000 };
const budget = { ...version, id: id(4), workspaceId: id(1), maxTokens: 20_000, spentTokens: 0, maxCostUsd: 10, spentCostUsd: 0, maxDurationMs: 60_000, maxActiveAgents: 3, maxDelegationDepth: 2 };
const toolCall = { ...version, id: id(8), workspaceId: id(1), taskId: id(5), attemptId: id(9), agentId: id(3), permissionId: id(10), tool: 'file.write', action: 'write', scope: 'src/example.ts', parametersDigest: 'a'.repeat(64), idempotencyKey: 'write-example-once', recovery: 'reconcile', state: 'proposed' } as const;
const approval = { ...version, id: id(11), workspaceId: id(1), actorId: id(3), permissionId: id(10), toolCallId: id(8), action: 'write', scope: 'src/example.ts', parametersDigest: 'a'.repeat(64), risk: 'high', requestedAt: at, expiresAt: end, status: 'pending' } as const;
const scope = { kind: 'mission', workspaceId: id(1), missionId: id(2) } as const;
const fixtures = {
  mission,
  task,
  taskGraph: { ...version, missionId: id(2), tasks: [task] },
  taskAttempt: { ...version, id: id(9), taskId: id(5), agentId: id(3), number: 1, state: 'unknown', startedAt: at, evidenceIds: [] },
  lease: { ...version, id: id(12), taskId: id(5), attemptId: id(9), holderAgentId: id(3), acquiredAt: at, heartbeatAt: later, expiresAt: end },
  engineCapabilities: capability,
  agentIdentity: agent,
  agentRegistry: { ...version, workspaceId: id(1), agents: [agent] },
  provider,
  modelProfile: { ...model, pricing: { version: '2026-01', effectiveAt: at, inputUsdPerMillion: 1.5, outputUsdPerMillion: 8, estimated: true } },
  budget,
  agentEvent: { ...version, id: id(13), workspaceId: id(1), sessionId: id(14), missionId: id(2), taskId: id(5), agentId: id(3), source: { runtime: 'extalia', channel: 'system' }, sourceTimestamp: at, observedAt: later, sequence: 1, confidence: 'observed', body: { type: 'task.state', state: 'unknown' } },
  toolCall,
  permission: { ...version, id: id(10), workspaceId: id(1), actorId: id(3), capability: 'file.write', action: 'write', scope: 'src/example.ts', decision: 'ask', risk: 'high' },
  approval,
  evidence: { ...version, id: id(15), workspaceId: id(1), taskId: id(5), kind: 'test', artifactId: id(16), digest: 'b'.repeat(64), recordedAt: at, verification: 'unverified' },
  adapterCapabilities: { ...capability, adapterId: 'external-observer', adapterVersion: '1.0.0' },
  observedSession: { ...version, id: id(14), workspaceId: id(1), agentId: id(17), externalSessionId: 'external-session-a', access: 'read-only', capabilities: { ...capability, adapterId: 'external-observer', adapterVersion: '1.0.0' }, freshness: 'unknown', observedAt: at, confidence: 'observed' },
  memoryScope: scope,
  experience: { ...version, id: id(18), workspaceId: id(1), missionId: id(2), taskId: id(5), agentId: id(3), scope, eventIds: [id(13)], evidenceIds: [id(15)], outcome: 'unknown', recordedAt: at, redacted: true },
  skillCandidate: { ...version, id: id(19), scope, experienceIds: [id(18)], evidenceIds: [], counterexampleIds: [], confidence: 0.5, status: 'proposed', validation: 'pending', privileged: true, version: '1.0.0' },
  plan: { ...version, mission, graph: { ...version, missionId: id(2), tasks: [task] }, registry: { ...version, workspaceId: id(1), agents: [agent] }, providers: [provider], models: [model], budget },
} satisfies OrchestrationContracts;

function invalid<K extends OrchestrationContractKind>(kind: K, raw: unknown, fragment?: string): void {
  const result = parseOrchestration(kind, raw);
  expect(result.ok).toBe(false);
  if (!result.ok && fragment) expect(result.errors.join('\n')).toContain(fragment);
}

describe('orchestration v1 wire contracts', () => {
  for (const kind of Object.keys(fixtures) as OrchestrationContractKind[]) {
    it(`accepts a typed ${kind} record and rejects unknown fields`, () => {
      expect(parseOrchestration(kind, fixtures[kind])).toEqual({ ok: true, value: fixtures[kind] });
      invalid(kind, { ...fixtures[kind], unexpected: true }, 'unknown field');
    });
    if (kind !== 'memoryScope') it(`rejects unsupported ${kind} schema versions`, () => {
      invalid(kind, { ...fixtures[kind], schemaVersion: 2 });
      const { schemaVersion: _schemaVersion, ...unversioned } = fixtures[kind] as { schemaVersion: number };
      invalid(kind, unversioned);
    });
  }
  it('rejects invalid identifiers, missing fields, non-JSON records and malformed UTC dates', () => {
    invalid('mission', null);
    invalid('mission', []);
    invalid('mission', new Date());
    invalid('mission', Object.create(fixtures.mission));
    invalid('mission', { ...mission, id: 'not-a-uuid' });
    invalid('mission', { ...mission, id: '10000000-ABCD-4ABC-8ABC-000000000001' });
    invalid('provider', { ...provider, adapterId: 'Provider A' });
    invalid('task', { ...task, requirements: ['two\nlines'] });
    invalid('mission', { ...mission, leadAgentId: undefined });
    invalid('mission', { ...mission, createdAt: '2026-02-30T00:00:00Z' });
    invalid('mission', { ...mission, updatedAt: '2025-12-31T23:59:59Z' }, 'start timestamp');
    invalid('mission', { ...mission, [Symbol('extra')]: true }, 'unknown field');
    invalid('provider', { ...provider, apiKey: 'example-secret' }, 'unknown field');
  });
  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])('rejects invalid count %s', value => {
    invalid('budget', { ...budget, maxTokens: value });
  });
  it('allows zero or exceeded cost ceilings without claiming budget enforcement', () => {
    expect(parseOrchestration('budget', { ...budget, maxCostUsd: 0, spentCostUsd: 1 }).ok).toBe(true);
    invalid('budget', { ...budget, maxCostUsd: NaN });
    invalid('modelProfile', { ...fixtures.modelProfile, pricing: { ...fixtures.modelProfile.pricing, estimated: false } });
    invalid('modelProfile', { ...fixtures.modelProfile, pricing: { ...fixtures.modelProfile.pricing, outputUsdPerMillion: Infinity } });
  });

  it('represents unknown model context capacity without inventing a token limit', () => {
    const { contextTokens: _contextTokens, ...unknownCapacity } = fixtures.modelProfile;
    expect(parseOrchestration('modelProfile', unknownCapacity)).toEqual({ ok: true, value: unknownCapacity });
    for (const contextTokens of [0, -1, NaN, Infinity, 1.5]) invalid('modelProfile', { ...unknownCapacity, contextTokens });
  });
  it('rejects oversized, sparse and duplicate arrays', () => {
    invalid('task', { ...task, evidenceIds: [id(1), id(1)] }, 'duplicate');
    invalid('task', { ...task, requirements: Array(1001).fill('requirement') });
    invalid('task', { ...task, evidenceIds: Array(1) });
    invalid('agentIdentity', { ...agent, capabilities: { ...capability, surprise: true } }, 'unknown field');
  });
});

describe('DAG, registry and closed plan consistency', () => {
  const graph = (tasks: Task[]) => ({ ...version, missionId: id(2), tasks });
  const child: Task = { ...task, id: id(20), dependsOn: [task.id], parentTaskId: task.id };
  it('accepts a bounded DAG and preserves the input', () => {
    const raw = graph([task, child]);
    expect(parseOrchestration('taskGraph', raw)).toEqual({ ok: true, value: raw });
    expect(raw.tasks[1]?.dependsOn).toEqual([task.id]);
  });
  it('rejects duplicates, missing references, wrong mission and both cycle types', () => {
    invalid('taskGraph', graph([task, task]), 'duplicate ID');
    invalid('taskGraph', graph([child]), 'unknown task reference');
    invalid('taskGraph', graph([{ ...task, missionId: id(99) }]), 'another mission');
    invalid('taskGraph', graph([{ ...task, dependsOn: [child.id] }, child]), 'cycle');
    invalid('taskGraph', graph([{ ...task, parentTaskId: child.id }, { ...child, dependsOn: [] }]), 'cycle');
    invalid('task', { ...task, dependsOn: [task.id] }, 'itself');
  });
  it('requires runnable dependencies and honest completion evidence', () => {
    invalid('task', { ...task, state: 'running' }, 'assignedAgentId');
    invalid('task', { ...task, state: 'running', assignedAgentId: agent.id }, 'lease');
    invalid('task', { ...task, state: 'completed' }, 'verification');
    invalid('task', { ...task, state: 'completed', verification: 'verified' }, 'cite evidence');
    invalid('taskGraph', graph([task, { ...child, state: 'completed', verification: 'unverified' }]), 'completed dependencies');
    expect(parseOrchestration('task', { ...task, state: 'completed', verification: 'unverified' }).ok).toBe(true);
    expect(parseOrchestration('taskGraph', graph([{ ...task, state: 'completed', verification: 'verified', evidenceIds: [id(15)] }, { ...child, state: 'running', assignedAgentId: agent.id, attempt: 1, leaseId: id(12) }])).ok).toBe(true);
  });
  it('rejects unknown supervisors, cross-workspace agents and reporting cycles', () => {
    invalid('agentRegistry', { ...fixtures.agentRegistry, agents: [{ ...agent, supervisorId: id(99) }] }, 'unknown supervisor');
    invalid('agentRegistry', { ...fixtures.agentRegistry, agents: [{ ...agent, workspaceId: id(99) }] }, 'another workspace');
    invalid('agentRegistry', { ...fixtures.agentRegistry, agents: [agent, agent] }, 'duplicate ID');
    invalid('agentRegistry', { ...fixtures.agentRegistry, agents: [{ ...agent, supervisorId: agent.id }] }, 'cycle');
  });
  it('validates plan mission, budget, lead, model/provider and assignee references', () => {
    const plan = fixtures.plan;
    invalid('plan', { ...plan, graph: { ...plan.graph, missionId: id(99), tasks: [] } }, 'references must agree');
    invalid('plan', { ...plan, budget: { ...budget, id: id(99) } }, 'references must agree');
    invalid('plan', { ...plan, registry: { ...plan.registry, agents: [] } }, 'native root');
    invalid('plan', { ...plan, registry: { ...plan.registry, agents: [{ ...agent, origin: 'observed' }] } }, 'native root');
    invalid('plan', { ...plan, providers: [] }, 'unknown model provider');
    invalid('plan', { ...plan, models: [] }, 'unknown agent model');
    invalid('plan', { ...plan, providers: [provider, provider] }, 'duplicate ID');
    invalid('plan', { ...plan, graph: graph([{ ...task, assignedAgentId: id(99) }]) }, 'assignee');
    invalid('plan', { ...plan, graph: graph([{ ...task, state: 'running', assignedAgentId: agent.id }]) }, 'lease');
  });
});

describe('attempts, leases, approvals and provenance', () => {
  it('represents unknown recovery without fabricating completion', () => {
    expect(parseOrchestration('taskAttempt', fixtures.taskAttempt).ok).toBe(true);
    invalid('taskAttempt', { ...fixtures.taskAttempt, state: 'succeeded' }, 'endedAt');
    invalid('taskAttempt', { ...fixtures.taskAttempt, state: 'running', endedAt: later }, 'running');
    invalid('taskAttempt', { ...fixtures.taskAttempt, endedAt: '2025-12-31T00:00:00Z' });
    invalid('lease', { ...fixtures.lease, expiresAt: later }, 'after');
    invalid('lease', { ...fixtures.lease, heartbeatAt: '2025-12-31T00:00:00Z' });
  });
  it('matches exact approval parameters, actors, scope and validity window', () => {
    const granted = { ...approval, status: 'granted', decidedAt: later, decidedBy: id(21) } as const;
    expect(approvalMatchesToolCall(granted, toolCall, later)).toBe(true);
    expect(approvalMatchesToolCall(granted, toolCall, at)).toBe(false);
    expect(approvalMatchesToolCall(granted, toolCall, end)).toBe(false);
    expect(approvalMatchesToolCall(approval, toolCall, later)).toBe(false);
    expect(approvalMatchesToolCall(granted, toolCall, 'invalid')).toBe(false);
    for (const change of [{ parametersDigest: 'b'.repeat(64) }, { scope: 'other.ts' }, { action: 'delete' }, { agentId: id(22) }, { permissionId: id(22) }, { workspaceId: id(22) }, { id: id(22) }]) {
      expect(approvalMatchesToolCall(granted, { ...toolCall, ...change }, later)).toBe(false);
    }
    invalid('approval', { ...granted, decidedBy: agent.id }, 'own action');
    invalid('approval', { ...approval, status: 'granted' }, 'decision record');
    invalid('approval', { ...approval, decidedAt: later, decidedBy: id(21) }, 'pending');
    invalid('approval', { ...granted, decidedAt: end }, 'after');
    invalid('approval', { ...granted, parametersDigest: 'not-a-digest' });
  });
  it('keeps observed/source clocks distinct and validates inherited v0 bodies', () => {
    const event = fixtures.agentEvent;
    expect(parseOrchestration('agentEvent', { ...event, sourceTimestamp: end }).ok).toBe(true); // Source clocks can differ.
    expect(parseOrchestration('agentEvent', { ...event, body: { type: 'agent.state', state: 'working' } }).ok).toBe(true);
    invalid('agentEvent', { ...event, missionId: undefined }, 'UUID');
    const { missionId: _missionId, ...noMission } = event;
    invalid('agentEvent', noMission, 'mission context');
    const { agentId: _agentId, ...noAgent } = event;
    invalid('agentEvent', { ...noAgent, body: { type: 'agent.state', state: 'working' } }, 'agentId');
    invalid('agentEvent', { ...event, body: { type: 'agent.state', state: 'unknown' } });
    invalid('agentEvent', { ...event, source: { ...event.source, token: 'example' } });
    invalid('agentEvent', { ...event, body: { type: 'mission.state', state: 'running', secret: true } });
    // Legacy protocol and parser remain on v0, with open legacy IDs.
    expect(PROTOCOL_VERSION).toBe('extalia.v0');
    expect(parseEvent({ v: PROTOCOL_VERSION, id: 'legacy-event', at, sessionId: 'legacy-session', source: { runtime: 'extalia', channel: 'system' }, body: { type: 'model.thinking' } }).ok).toBe(true);
  });
  it('keeps observation read-only and requires truthful freshness provenance', () => {
    const session = fixtures.observedSession;
    invalid('observedSession', { ...session, access: 'managed' });
    invalid('observedSession', { ...session, capabilities: { ...session.capabilities, observe: false } }, 'observation capability');
    invalid('observedSession', { ...session, freshness: 'current' }, 'lastSeenAt');
    invalid('observedSession', { ...session, lastSeenAt: later }, 'start timestamp');
    expect(parseOrchestration('observedSession', { ...session, freshness: 'stale', lastSeenAt: at, observedAt: later }).ok).toBe(true);
    // Capability support alone never changes access to the observed process.
    expect(parseOrchestration('observedSession', { ...session, capabilities: { ...session.capabilities, control: true } }).ok).toBe(true);
  });
});

describe('scoped experience and candidate review', () => {
  it('rejects scope leakage and requires an explicit global export approval reference', () => {
    invalid('memoryScope', { kind: 'global' }, 'required');
    invalid('memoryScope', { kind: 'workspace', workspaceId: id(1), missionId: id(2) }, 'unknown field');
    invalid('experience', { ...fixtures.experience, scope: { kind: 'workspace', workspaceId: id(99) } }, 'another workspace');
    invalid('experience', { ...fixtures.experience, scope: { ...scope, missionId: id(99) } }, 'another mission');
    expect(parseOrchestration('experience', { ...fixtures.experience, scope: { kind: 'global', exportApprovalId: id(21) } }).ok).toBe(true);
  });
  it('requires review, validation and evidence before candidate approval', () => {
    const candidate = fixtures.skillCandidate;
    invalid('skillCandidate', { ...candidate, status: 'approved' }, 'review record');
    const reviewed = { ...candidate, status: 'approved', reviewedAt: later, reviewedBy: id(21), validation: 'passed', evidenceIds: [id(15)] } as const;
    invalid('skillCandidate', reviewed, 'activation approval');
    invalid('skillCandidate', { ...reviewed, privileged: false, validation: 'failed' }, 'passed validation');
    invalid('skillCandidate', { ...candidate, status: 'rejected', activationApprovalId: id(11) });
    expect(parseOrchestration('skillCandidate', { ...reviewed, activationApprovalId: id(11) }).ok).toBe(true);
    expect(parseOrchestration('skillCandidate', { ...candidate, status: 'rejected', reviewedAt: later, reviewedBy: id(21) }).ok).toBe(true);
    invalid('skillCandidate', { ...candidate, confidence: NaN });
    invalid('skillCandidate', { ...candidate, confidence: 1.01 });
    invalid('skillCandidate', { ...candidate, experienceIds: [] });
  });
});
