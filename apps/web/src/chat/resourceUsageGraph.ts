import type { AgentTeam } from '@extalia/core';
import type { AgentState, EventBody, ExtaliaEvent } from '@extalia/protocol';
import type { ResourceUsageAgent, ResourceUsageGraph, ResourceUsageNode, ResourceUsageStatus } from './resourceUsageTypes';

export interface ResourceUsageOptions {
  scopeKey: string;
  sessionId: string;
  primaryLabel: string;
  primaryName?: string;
  teamLabel: string;
  team?: AgentTeam | null;
}
const EVENT_LIMIT = 20_000, NODE_LIMIT = 256, AGENT_LIMIT = 64, ACTIVE_CALL_LIMIT = 256;
const terminal = new Set(['turn.completed', 'turn.failed', 'session.ended', 'agent.stopped', 'meeting.completed']);
const clip = (value: string, limit = 240) => Array.from(value).slice(0, limit).join('');
const statusForAgent = (state: AgentState): ResourceUsageStatus => state === 'working' ? 'active'
  : state === 'waiting' ? 'waiting' : state === 'blocked' ? 'failed' : state === 'idle' ? 'completed' : 'unknown';
const explicitStop = (body: Extract<EventBody, { type: 'agent.state' | 'subagent.state' }>): ResourceUsageStatus | undefined =>
  body.phase === 'error' ? 'failed' : body.phase === 'interrupted' || body.phase === 'ended' || body.state === 'offline' ? 'unknown' : undefined;
type ToolEvent = Extract<EventBody, { type: 'tool.started' | 'tool.completed' }>;
const reportedToolName = (tool: string) => tool.split('__').at(-1)!.replace(/^(skill|knowledge)\./, '$1_');
const skillFile = (path: string | undefined): path is string => !!path && path.length <= 1024 && /(?:^|[\\/])SKILL\.md$/i.test(path);
const skillFileLabel = (path: string) => path.split(/[\\/]/).slice(-2).join('/');

/** A bounded view of recorded preparation/access, never a claim that an LLM followed a procedure. */
export function projectResourceUsage(input: readonly ExtaliaEvent[], options: ResourceUsageOptions): ResourceUsageGraph {
  const bounded: ExtaliaEvent[] = [];
  let horizonExceeded = false;
  for (let index = input.length - 1; index >= 0; index--) if (input[index]!.sessionId === options.sessionId) {
    if (bounded.length === EVENT_LIMIT) { horizonExceeded = true; break; }
    bounded.push(input[index]!);
  }
  bounded.reverse();
  // Authoritative refreshes can enrich an existing id; deduplicate without counting it twice.
  const events = [...new Map(bounded.map(event => [event.id, event])).values()];
  const childIds = new Set<string>(options.team?.members.map(member => member.id) ?? []);
  for (const { body, agentId } of events) {
    if (body.type === 'subagent.spawned') childIds.add(body.subagentId);
    if (body.type === 'agent.created' && body.parentAgentId && agentId) childIds.add(agentId);
  }
  // Host import/hook/native publishers normalize the lead to this canonical id.
  // Missing parent metadata never authorizes promoting an arbitrary worker.
  const primary = 'primary';
  const ownerOf = (event: ExtaliaEvent) => event.agentId ?? primary;
  const main = (event: ExtaliaEvent) => ownerOf(event) === primary;
  let start = 0, run = 'history', running = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (!main(event)) continue;
    if ((event.body.type === 'prompt.submitted' || event.body.type === 'meeting.started') && !running) {
      start = index; run = event.id; running = true;
    }
    if (terminal.has(event.body.type) || event.body.type === 'agent.error' && event.body.recoverable !== true
      || event.body.type === 'agent.state' && explicitStop(event.body)) running = false;
  }
  const scopeKey = JSON.stringify([options.scopeKey, options.sessionId, run]);
  const agents = new Map<string, ResourceUsageAgent>(), nodes = new Map<string, ResourceUsageNode>();
  const inFlight = new Map<string, { node: ResourceUsageNode; owner: string; tool: string; target?: string }>();
  const approvals = new Map<string, Set<string>>();
  const settledCalls = new Map<string, ResourceUsageNode>();
  const identities = new Map<string, { label: string; parentId?: string }>();
  for (const event of events) {
    if (event.body.type === 'agent.created' && event.agentId) identities.set(event.agentId, { label: clip(event.body.name), ...(event.body.parentAgentId ? { parentId: event.body.parentAgentId } : {}) });
    if (event.body.type === 'subagent.spawned') identities.set(event.body.subagentId, { label: clip(event.body.label ?? identities.get(event.body.subagentId)?.label ?? event.body.subagentId), ...(ownerOf(event) !== event.body.subagentId ? { parentId: ownerOf(event) } : {}) });
  }
  const teamMembers = new Map(options.team?.members.map(member => [member.id, member]) ?? []);
  let truncated = horizonExceeded;
  const agent = (id: string): ResourceUsageAgent | undefined => {
    let value = agents.get(id);
    if (!value) {
      if (agents.size >= AGENT_LIMIT) { truncated = true; return; }
      const member = teamMembers.get(id);
      value = { id, role: id === primary ? 'primary' : childIds.has(id) || identities.get(id)?.parentId ? 'subagent' : 'unknown',
        label: id === primary && options.primaryName ? clip(options.primaryName) : identities.get(id)?.label ?? (id === primary ? options.primaryLabel : member?.name ?? clip(id)), status: 'unknown',
        ...(identities.get(id)?.parentId && identities.get(id)!.parentId !== id ? { parentId: identities.get(id)!.parentId } : {}),
        ...(member ? { teamId: 'session-team' } : {}) };
      agents.set(id, value);
    }
    return value;
  };
  const record = (event: ExtaliaEvent, kind: ResourceUsageNode['kind'], identity: string, label: string,
    state: ResourceUsageStatus, resourceKey?: string, source?: string, detail?: string): ResourceUsageNode | undefined => {
    const owner = ownerOf(event);
    if (!agent(owner)) return;
    const id = JSON.stringify([scopeKey, owner, kind, identity]);
    let node = nodes.get(id);
    if (!node) {
      if (nodes.size >= NODE_LIMIT) { truncated = true; return; }
      node = { id, agentId: owner, kind, label: clip(label), status: state, count: 0, lastAt: event.at, evidenceIds: [],
        ...(resourceKey ? { resourceKey } : {}), ...(source ? { source: clip(source) } : {}) };
      nodes.set(id, node);
    }
    node.count++; node.lastAt = event.at;
    if (detail) node.detail = clip(detail, 512);
    if (!node.evidenceIds.includes(event.id)) node.evidenceIds = [...node.evidenceIds.slice(-7), event.id];
    if (![...inFlight.values()].some(call => call.node === node)) node.status = state;
    return node;
  };
  const refresh = (node: ResourceUsageNode, settled: ResourceUsageStatus) => {
    const calls = [...inFlight.values()].filter(call => call.node === node);
    node.status = calls.length ? 'active' : settled;
  };
  const settleOwner = (id: string, state: ResourceUsageStatus, event: ExtaliaEvent) => {
    const value = agent(id); if (value) value.status = state;
    for (const [key, call] of inFlight) if (call.owner === id) {
      inFlight.delete(key);
      // Late/refreshed receipts for the same invocation cannot restart a settled pulse.
      settledCalls.set(key, call.node);
      refresh(call.node, state === 'failed' ? 'failed' : 'unknown');
      call.node.lastAt = event.at;
      if (!call.node.evidenceIds.includes(event.id)) call.node.evidenceIds = [...call.node.evidenceIds.slice(-7), event.id];
    }
    approvals.delete(id);
  };
  const describeTool = (body: ToolEvent, event: ExtaliaEvent) => {
    if (body.kind === 'read' && skillFile(body.target)) return { kind: 'skill' as const, identity: `file:${body.target}`, label: skillFileLabel(body.target),
      resourceKey: JSON.stringify(['skill-file', event.source.runtime, body.target]), source: body.tool };
    const owner = ownerOf(event), skill = reportedToolName(body.tool) === 'skill_read' && body.target && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.target);
    if (skill) {
      const prepared = [...nodes.values()].filter(node => node.agentId === owner && node.kind === 'skill' && node.label === body.target);
      if (prepared.length === 1) return { kind: 'skill' as const, identity: JSON.parse(prepared[0]!.id)[3] as string,
        label: body.target!, resourceKey: prepared[0]!.resourceKey, source: prepared[0]!.source };
      return { kind: 'skill' as const, identity: `read:${body.target}`, label: body.target!,
        resourceKey: JSON.stringify(['skill_read', event.source.runtime, body.target]), source: body.tool };
    }
    // Discovery/curation operations are not evidence of reading a specific skill.
    const kind = 'knowledge' as const;
    const target = body.target && body.target.length <= 1024 ? body.target : undefined;
    return { kind, identity: JSON.stringify([body.tool, target ?? null]), label: target || body.label || body.tool,
      ...(target ? { resourceKey: JSON.stringify([event.source.runtime, body.tool, target]) } : {}), source: body.tool };
  };
  for (const event of events.slice(start)) {
    const body = event.body, owner = ownerOf(event);
    if (body.type === 'agent.created') {
      const value = agent(owner);
      if (value) { value.label = owner === primary && options.primaryName ? clip(options.primaryName) : clip(body.name); if (body.parentAgentId && body.parentAgentId !== owner) value.parentId = body.parentAgentId; }
    } else if (body.type === 'subagent.spawned') {
      const value = agent(body.subagentId);
      if (value) { value.label = clip(body.label ?? teamMembers.get(body.subagentId)?.name ?? body.subagentId); value.status = 'unknown';
        if (owner !== body.subagentId) value.parentId = owner;
        agent(owner);
      }
    } else if (body.type === 'file.read' && skillFile(body.path)) {
      record(event, 'skill', `file:${body.path}`, skillFileLabel(body.path), 'completed', JSON.stringify(['skill-file', event.source.runtime, body.path]), body.type, body.path);
    } else if (body.type === 'skills.loaded') {
      for (const entry of body.skills) {
        const identity = JSON.stringify(['prepared', entry.source, entry.name, entry.revisionId ?? null]);
        record(event, 'skill', identity, entry.name, entry.status === 'loaded' ? 'loaded' : 'skipped',
          JSON.stringify(['skill', entry.source, entry.name, entry.revisionId ?? null]), entry.source, entry.revisionId ?? entry.intent ?? entry.reason);
      }
    } else if ((body.type === 'tool.started' || body.type === 'tool.completed') && (body.kind === 'knowledge' || body.kind === 'read' && skillFile(body.target) || /^(skill_|knowledge_|project_knowledge_|work_memory_|observed_memory_)/.test(reportedToolName(body.tool)))) {
      const callKey = body.toolCallId ? JSON.stringify([owner, body.toolCallId]) : undefined;
      if (reportedToolName(body.tool).startsWith('skill_')) {
        if (reportedToolName(body.tool) !== 'skill_read') continue;
        const validTarget = body.target && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.target);
        // Completion receipts may omit start metadata; a known call still closes its pulse.
        const knownCompletion = body.type === 'tool.completed' && (callKey
          ? inFlight.has(callKey) || settledCalls.has(callKey)
          : [...inFlight.values()].some(call => call.owner === owner && call.tool === body.tool && (body.target === undefined || call.target === body.target)));
        if (!validTarget && !knownCompletion) continue;
      }
      const duplicate = callKey ? inFlight.get(callKey)?.node ?? settledCalls.get(callKey) : undefined;
      if (duplicate && (body.type === 'tool.started' || settledCalls.has(callKey!))) {
        if (!duplicate.evidenceIds.includes(event.id)) duplicate.evidenceIds = [...duplicate.evidenceIds.slice(-7), event.id];
        continue;
      }
      const exact = callKey ? inFlight.get(callKey) : undefined;
      const candidates = callKey ? [] : [...inFlight.entries()].filter(([, call]) => call.owner === owner && call.tool === body.tool && (body.target === undefined || call.target === body.target));
      const oneResource = candidates.length > 0 && candidates.every(([, call]) => call.node === candidates[0]![1].node);
      const pendingKey = exact ? callKey : candidates.length === 1 || oneResource ? candidates[0]![0] : undefined;
      if (body.type === 'tool.completed' && !pendingKey && candidates.length > 1) {
        // Without a call id or unique target, no specific pending resource is proven active anymore.
        for (const [key, call] of candidates) { inFlight.delete(key); refresh(call.node, 'unknown'); call.node.lastAt = event.at; call.node.evidenceIds = [...call.node.evidenceIds.slice(-7), event.id]; }
      }
      const pending = pendingKey ? inFlight.get(pendingKey) : undefined;
      const description = describeTool(body, event);
      if (body.type === 'tool.started') {
        if (inFlight.size >= ACTIVE_CALL_LIMIT) { truncated = true; continue; }
        const node = record(event, description.kind, description.identity, description.label, 'active', description.resourceKey, description.source, body.label);
        if (node) { inFlight.set(callKey ?? JSON.stringify([owner, event.id]), { node, owner, tool: body.tool, ...(body.target ? { target: body.target } : {}) }); refresh(node, 'active'); }
        const value = agent(owner); if (value) value.status = 'active';
      } else {
        const node = pending?.node ?? record(event, description.kind, description.identity, description.label,
          body.ok ? 'completed' : 'failed', description.resourceKey, description.source, body.label);
        if (node) {
          if (pendingKey) inFlight.delete(pendingKey);
          if (callKey) settledCalls.set(callKey, node);
          node.lastAt = event.at;
          if (!node.evidenceIds.includes(event.id)) node.evidenceIds = [...node.evidenceIds.slice(-7), event.id];
          refresh(node, body.ok ? 'completed' : 'failed');
        }
      }
    } else if (body.type === 'approval.requested') {
      const waiting = approvals.get(owner) ?? new Set<string>(); waiting.add(body.approvalId); approvals.set(owner, waiting);
      const value = agent(owner); if (value) value.status = 'waiting';
      // Existing background accesses continue; an unrelated approval does not pause them.
    } else if (body.type === 'approval.resolved') {
      approvals.get(owner)?.delete(body.approvalId);
      const value = agent(owner);
      if (value) value.status = approvals.get(owner)?.size ? 'waiting' : [...inFlight.values()].some(call => call.owner === owner) ? 'active' : 'unknown';
      for (const call of inFlight.values()) if (call.owner === owner) refresh(call.node, 'active');
    } else if (body.type === 'agent.error') {
      // Native delegation owns turn lifecycle at the lead; worker failures arrive here.
      if (body.recoverable !== true) settleOwner(owner, 'failed', event);
    } else if (body.type === 'agent.state' || body.type === 'subagent.state') {
      const id = body.type === 'subagent.state' ? body.subagentId : owner, value = agent(id);
      const stop = explicitStop(body);
      if (stop) settleOwner(id, stop, event);
      else if (value && !(value.status === 'failed' && body.state === 'idle')) value.status = statusForAgent(body.state);
      // Generic idle/blocked and recoverable errors do not settle independent background calls.
    } else if (terminal.has(body.type)) {
      const state = body.type === 'turn.failed' ? body.reason === 'interrupted' ? 'unknown' : 'failed'
        : body.type === 'meeting.completed' && body.outcome === 'failed' ? 'failed'
          : body.type === 'agent.stopped' || body.type === 'session.ended' || body.type === 'meeting.completed' && body.outcome === 'cancelled' ? 'unknown' : 'completed';
      // Lead turns may finish while observed children keep working independently.
      if (main(event) && body.type === 'session.ended') for (const id of agents.keys()) settleOwner(id, state, event);
      else settleOwner(owner, state, event);
    }
  }
  // Keep only owners and explicit ancestors; no disconnected saved roster is invented.
  const used = new Set([...nodes.values()].map(node => node.agentId));
  for (const id of [...used]) {
    const seen = new Set<string>(); let current = agents.get(id);
    while (current?.parentId && !seen.has(current.parentId)) { seen.add(current.parentId); used.add(current.parentId); current = agent(current.parentId); }
  }
  const visibleAgents = [...agents.values()].filter(value => used.has(value.id));
  return { scopeKey, agents: visibleAgents, nodes: [...nodes.values()], truncated,
    teams: visibleAgents.some(value => value.teamId === 'session-team') ? [{ id: 'session-team', label: options.teamLabel }] : [] };
}

const VIEW_EVENTS = new Set(['file.read', 'skills.loaded', 'tool.started', 'tool.completed', 'prompt.submitted', 'turn.completed', 'turn.failed',
  'agent.created', 'agent.state', 'agent.error', 'agent.stopped', 'subagent.spawned', 'subagent.state', 'approval.requested', 'approval.resolved', 'session.ended', 'meeting.started', 'meeting.completed']);

/** Text token/output updates do not need another graph projection or a new canvas layout. */
export function createResourceUsageProjection(options: ResourceUsageOptions) {
  let previous: readonly ExtaliaEvent[] | undefined, snapshot: ResourceUsageGraph | undefined;
  return (events: readonly ExtaliaEvent[]): ResourceUsageGraph => {
    const appendOnly = previous && previous.length <= events.length && previous.every((event, index) => events[index] === event);
    const changed = !appendOnly || events.slice(previous!.length).some(event => event.sessionId === options.sessionId && VIEW_EVENTS.has(event.body.type));
    if (!snapshot || changed) snapshot = projectResourceUsage(events, options);
    previous = events;
    return snapshot;
  };
}
