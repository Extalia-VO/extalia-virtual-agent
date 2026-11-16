import type { ActivityKind, AgentState, ExtaliaEvent, FileChangeKind, RiskLevel, SkillLoadReport, Usage } from '@extalia/protocol';
import { promptAttachmentMetadata, type AttachmentMetadata } from './attachments';
import { historicalSessionFilePath, type SessionFileRoots, type SessionFileScope } from './sessionFileScopes';

/**
 * Pure projection of a session's protocol events into what Chat shows. It
 * never mutates its input, tolerates duplicates (history and live events
 * overlap) and keeps independently observed child lifetimes separate from the lead.
 */

export type ToolStatus = 'running' | 'ok' | 'failed' | 'stopped';
export type ApprovalStatus = 'pending' | 'granted' | 'rejected' | 'expired';
export interface FileChange { path: string; change: FileChangeKind }
export interface CommandRun {
  command: string;
  /** Consecutive chunks of the same stream are merged. */
  output: { stream: 'stdout' | 'stderr'; text: string }[];
  exitCode?: number;
  durationMs?: number;
}

export interface UserItem { kind: 'user'; id: string; text: string; at: string; /** Files attached to the prompt (names, kinds, sizes; never contents). */ attachments?: AttachmentMetadata[] }
export interface AssistantItem { kind: 'assistant'; id: string; text: string; streaming: boolean; model?: string }
export interface ToolItem {
  kind: 'tool';
  id: string;
  callId?: string;
  tool: string;
  activity: ActivityKind;
  label: string;
  target?: string;
  status: ToolStatus;
  output?: string;
  /** Passive result media, resolved only through this session’s preview loader. */
  attachments?: AttachmentMetadata[];
  command?: CommandRun;
  files: FileChange[];
}
export interface ApprovalItem { kind: 'approval'; id: string; approvalId: string; action: string; detail?: string; risk?: RiskLevel; status: ApprovalStatus; by?: 'user' | 'policy'; choice?: 'once' | 'session' | 'reject' }
export interface FilesItem { kind: 'files'; id: string; files: FileChange[] }
export interface NoticeItem { kind: 'notice'; id: string; reason: 'cancelled' | 'failed' | 'agent-error'; text?: string }
export interface UsageItem { kind: 'usage'; id: string; usage?: Usage; model?: string; costUsd?: number; summary?: string }
/** Instructions prepared by the host, distinct from a model-issued tool call. */
export interface SkillLoadItem extends SkillLoadReport {
  kind: 'skills';
  id: string;
  owner: 'primary' | 'worker' | 'agent';
  agentId?: string;
  agentLabel?: string;
}
/** A worker invocation the primary delegated to; its recorded activity stays inside this card. */
export interface WorkerItem {
  kind: 'worker';
  id: string;
  subagentId: string;
  /** First recorded working-state summary, retained when progress changes. */
  task?: string;
  /** Actual worker-scoped activity for this invocation, separate from the lead. */
  preview?: TranscriptItem[];
  /** Task tier (`complex`, `standard`, `quick`) or another role. */
  tier?: string;
  label?: string;
  state: AgentState;
  status: ToolStatus;
  summary?: string;
  /** Label of the worker's latest tool call. */
  activity?: string;
  toolCalls: number;
  /** At most ten distinct result attachments, in source order, inside this worker’s card. */
  attachments?: AttachmentMetadata[];
  /** The primary's delegate call that started the worker. */
  callId?: string;
}

/** Edge of a conversation carried over from another agent (`import` channel events). */
export interface HandoffItem { kind: 'handoff'; id: string; edge: 'start' | 'end'; runtime: string }

export type TranscriptItem = (UserItem | AssistantItem | ToolItem | ApprovalItem | FilesItem | NoticeItem | UsageItem | WorkerItem | HandoffItem | SkillLoadItem) & {
  /** Absent follows the current workspace; null disables ambiguous historical file links. */
  fileScope?: SessionFileScope | null;
};

interface Turn {
  cancelled: boolean;
  tools: ToolItem[];
  workers: WorkerItem[];
  approvals: ApprovalItem[];
  messageUsage?: Usage;
  model?: string;
  /** Last item that file changes without a running tool are grouped into. */
  files?: FilesItem;
}

const addUsage = (sum: Usage | undefined, next: Usage | undefined): Usage | undefined => {
  if (!next) return sum;
  const total: Usage = { ...sum };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
  }
  return total;
};

const addFile = (files: FileChange[], change: FileChange) => {
  const existing = files.find(file => file.path === change.path);
  if (existing) existing.change = change.change;
  else files.push({ ...change });
};

export function projectTranscript(events: readonly ExtaliaEvent[], historicalRoots?: SessionFileRoots): TranscriptItem[] {
  interface Scope {
    items: TranscriptItem[];
    parent?: Scope;
    closed?: boolean;
    accept(event: ExtaliaEvent, receiptOwner?: WorkerItem): void;
    finish(): void;
  }
  interface WorkerProjection { item: WorkerItem; parent: Scope; parentAgentId?: string; scope: Scope; hasPrompt?: boolean }
  const workers = new Map<string, WorkerProjection>();
  const scopes: Scope[] = [];
  const seen = new Set<string>();
  const rootAgentIds = new Set(['primary']);
  let observed = false;
  const createScope = (workerOwner?: WorkerItem, parent?: Scope): Scope => {
    const items: TranscriptItem[] = [];
    const toolsByCall = new Map<string, ToolItem>();
    const approvals = new Map<string, ApprovalItem>();
    const children: WorkerItem[] = [];
    let streaming: AssistantItem | undefined;
    let turn: Turn | undefined;
    /** Runtime whose carried-over conversation is being shown. */
    let carrying: string | undefined;
    let primaryAgentId: string | undefined;

    const currentTurn = (): Turn => (turn ??= { cancelled: false, tools: [], workers: [], approvals: [] });
    const settleStream = () => { if (streaming) streaming.streaming = false; streaming = undefined; };
    const runningTool = () => [...currentTurn().tools].reverse().find(tool => tool.status === 'running');
    const toolFor = (callId: string | undefined) => (callId ? toolsByCall.get(callId) : undefined) ?? runningTool();
    const endTurn = (stopWorkers = true) => {
      settleStream();
      if (!turn) return;
      for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'stopped';
      for (const approval of turn.approvals) if (approval.status === 'pending') approval.status = 'expired';
      if (stopWorkers) for (const worker of turn.workers) if (worker.status === 'running') worker.status = 'stopped';
      turn = undefined;
    };
    const startTool = (tool: ToolItem) => {
      settleStream();
      const active = currentTurn();
      active.tools.push(tool);
      active.files = undefined;
      if (tool.callId) toolsByCall.set(tool.callId, tool);
      items.push(tool);
      return tool;
    };

    const scope: Scope = { items, parent, accept, finish };
    scopes.push(scope);
    function accept(event: ExtaliaEvent, receiptOwner?: WorkerItem) {
      const owner = receiptOwner ?? workerOwner;
      const body = event.body;
      const carried = event.source.channel === 'import';
      if (carried && carrying === undefined) {
        endTurn();
        carrying = event.source.runtime;
        items.push({ kind: 'handoff', id: `${event.id}:start`, edge: 'start', runtime: carrying });
      } else if (!carried && carrying !== undefined && body.type !== 'session.started') {
        endTurn();
        items.push({ kind: 'handoff', id: `${event.id}:end`, edge: 'end', runtime: carrying });
        carrying = undefined;
      }
      if (body.type === 'skills.loaded') {
        settleStream();
        items.push({ kind: 'skills', id: event.id, skills: body.skills.map(skill => ({ ...skill })),
          characters: body.characters, budgetCharacters: body.budgetCharacters,
          ...(body.omitted === undefined ? {} : { omitted: body.omitted }),
          owner: owner ? 'worker' : !event.agentId || event.agentId === primaryAgentId ? 'primary' : 'agent',
          ...(event.agentId ? { agentId: event.agentId } : {}), ...(owner ? { agentLabel: owner.label ?? owner.subagentId } : {}) });
        return;
      }
      switch (body.type) {
        case 'prompt.submitted':
          scope.closed = false;
          primaryAgentId = event.agentId;
          endTurn(!observed);
          {
            const attachments = promptAttachmentMetadata((body as { attachments?: unknown }).attachments);
            items.push({ kind: 'user', id: event.id, text: body.text, at: event.at, ...(attachments.length ? { attachments } : {}) });
          }
          currentTurn();
          break;
        case 'model.delta':
          if (!streaming) {
            streaming = { kind: 'assistant', id: event.id, text: '', streaming: true };
            items.push(streaming);
          }
          streaming.text += body.text;
          break;
        case 'model.completed': {
          const active = currentTurn();
          active.messageUsage = addUsage(active.messageUsage, body.usage);
          if (body.model) active.model = body.model;
          // The completed text is authoritative and replaces whatever was streamed.
          const text = body.text;
          if (streaming) {
            const item = streaming;
            settleStream();
            if (text.trim()) Object.assign(item, { text }, body.model ? { model: body.model } : {});
            else items.splice(items.indexOf(item), 1);
          } else if (text.trim()) {
            items.push({ kind: 'assistant', id: event.id, text, streaming: false, ...(body.model ? { model: body.model } : {}) });
          }
          break;
        }
        case 'approval.requested': {
          settleStream();
          const item: ApprovalItem = { kind: 'approval', id: event.id, approvalId: body.approvalId, action: body.action, status: 'pending' };
          if (body.detail) item.detail = body.detail;
          if (body.risk) item.risk = body.risk;
          approvals.set(body.approvalId, item);
          currentTurn().approvals.push(item);
          items.push(item);
          break;
        }
        case 'approval.resolved': {
          const item = approvals.get(body.approvalId);
          if (item) {
            item.status = body.decision; item.by = body.by;
            // Historical display metadata cannot change the actual granted/rejected decision.
            if (body.by === 'user' && ((body.decision === 'granted' && (body.choice === 'once' || body.choice === 'session')) || (body.decision === 'rejected' && body.choice === 'reject'))) item.choice = body.choice;
          }
          break;
        }
        case 'tool.started': {
          const tool: ToolItem = { kind: 'tool', id: event.id, tool: body.tool, activity: body.kind, label: body.label, status: 'running', files: [] };
          if (body.toolCallId) tool.callId = body.toolCallId;
          if (body.target) tool.target = body.target;
          startTool(tool);
          break;
        }
        case 'tool.output': {
          const tool = toolFor(body.toolCallId);
          if (tool) tool.output = (tool.output ?? '') + body.text;
          break;
        }
        case 'subagent.spawned': {
          // Do not reparent stable ids or let malformed self/ancestor announcements
          // turn a lead into its own descendant. Each recorded event is routed once.
          if (body.subagentId === event.agentId || rootAgentIds.has(body.subagentId)) break;
          const existing = workers.get(body.subagentId);
          if (existing && existing.parent !== scope && (existing.item.status === 'running' || existing.parentAgentId !== event.agentId)) break;
          if (existing?.item.status === 'running') {
            if (body.role) existing.item.tier = body.role;
            if (body.label) existing.item.label = body.label;
            break;
          }
          settleStream();
          const active = currentTurn();
          const item: WorkerItem = { kind: 'worker', id: event.id, subagentId: body.subagentId, state: 'working', status: 'running', toolCalls: 0 };
          if (body.role) item.tier = body.role;
          if (body.label) item.label = body.label;
          const delegate = [...active.tools].reverse().find(tool => tool.status === 'running' && tool.activity === 'delegate');
          if (delegate?.callId) item.callId = delegate.callId;
          const child = createScope(item, scope);
          workers.set(body.subagentId, { item, parent: scope, parentAgentId: event.agentId, scope: child });
          active.workers.push(item);
          children.push(item);
          items.push(item);
          break;
        }
        case 'tool.completed': {
          const tool = (body.toolCallId ? toolsByCall.get(body.toolCallId) : undefined)
            ?? [...currentTurn().tools].reverse().find(item => item.status === 'running' && item.tool === body.tool)
            ?? startTool({ kind: 'tool', id: event.id, tool: body.tool, activity: body.kind, label: body.label, status: 'running', files: [], ...(body.toolCallId ? { callId: body.toolCallId } : {}) });
          tool.status = body.ok ? 'ok' : 'failed';
          if (body.output !== undefined) tool.output = body.output;
          if (body.attachments !== undefined) tool.attachments = promptAttachmentMetadata(body.attachments);
          if (body.target && !tool.target) tool.target = body.target;
          // Managed delegate calls settle their workers. Observed spawn calls may
          // return an id while the independently observed child is still running.
          for (const item of currentTurn().workers) {
            if (!observed && item.callId && item.callId === tool.callId && item.status === 'running') item.status = body.ok ? 'ok' : 'failed';
          }
          break;
        }
        case 'command.started': {
          const tool = (body.commandId ? toolsByCall.get(body.commandId) : undefined) ?? runningTool()
            ?? startTool({ kind: 'tool', id: event.id, tool: 'command', activity: 'command', label: body.command, status: 'running', files: [], ...(body.commandId ? { callId: body.commandId } : {}) });
          tool.command = { command: body.command, output: [] };
          break;
        }
        case 'command.output': {
          const command = toolFor(body.commandId)?.command;
          if (!command) break;
          const last = command.output[command.output.length - 1];
          if (last && last.stream === body.stream) last.text += body.text;
          else command.output.push({ stream: body.stream, text: body.text });
          break;
        }
        case 'command.completed': {
          const tool = toolFor(body.commandId);
          if (!tool?.command) break;
          tool.command.exitCode = body.exitCode;
          if (body.durationMs !== undefined) tool.command.durationMs = body.durationMs;
          // A command that arrived without a surrounding tool call has nothing else to complete it.
          if (tool.tool === 'command' && tool.status === 'running') tool.status = body.exitCode === 0 ? 'ok' : 'failed';
          break;
        }
        case 'file.written': {
          const scope = historicalRoots?.get(event.id);
          const change = { path: scope ? historicalSessionFilePath(body.path, scope) ?? body.path : body.path, change: body.change };
          const active = currentTurn();
          const tool = body.toolCallId ? toolsByCall.get(body.toolCallId) : runningTool();
          if (tool) { addFile(tool.files, change); break; }
          if (!active.files) {
            settleStream();
            active.files = { kind: 'files', id: event.id, files: [] };
            items.push(active.files);
          }
          addFile(active.files.files, change);
          break;
        }
        case 'user.intervention':
          if (body.action === 'steer' && body.text) {
            // A current-run message does not settle tools, workers or approval cards.
            items.push({ kind: 'user', id: event.id, text: body.text, at: event.at });
          } else if (body.action === 'cancel') {
            settleStream();
            currentTurn().cancelled = true;
            items.push({ kind: 'notice', id: event.id, reason: 'cancelled' });
          }
          break;
        case 'agent.error':
          settleStream();
          items.push({ kind: 'notice', id: event.id, reason: 'agent-error', text: body.message });
          break;
        case 'turn.completed': {
          const active = currentTurn();
          const usage = body.usage ?? active.messageUsage;
          const model = body.model ?? active.model;
          if (usage || model || body.costUsd !== undefined) {
            const item: UsageItem = { kind: 'usage', id: event.id };
            if (usage) item.usage = usage;
            if (model) item.model = model;
            if (body.costUsd !== undefined) item.costUsd = body.costUsd;
            if (body.summary) item.summary = body.summary;
            settleStream();
            items.push(item);
          }
          endTurn(!observed);
          break;
        }
        case 'session.ended':
        case 'agent.stopped':
          scope.closed = true;
          for (const child of children) if (child.status === 'running') child.status = 'stopped';
          endTurn();
          break;
        case 'turn.failed':
          settleStream();
          // A cancelled turn already shows why it stopped.
          if (!turn?.cancelled) items.push({ kind: 'notice', id: event.id, reason: 'failed', text: body.error });
          endTurn(!observed);
          break;
        default:
          break;
      }
    }
    function finish() {
      if (carrying !== undefined) {
        endTurn();
        items.push({ kind: 'handoff', id: 'handoff:end', edge: 'end', runtime: carrying });
      }
      if (scope.parent?.closed || workerOwner?.status === 'stopped') scope.closed = true;
      if (scope.closed) for (const child of children) if (child.status === 'running') child.status = 'stopped';
      if (workerOwner && workerOwner.status !== 'running') {
        endTurn(!observed || workerOwner.status === 'stopped');
      }
      for (const item of items) {
        if (historicalRoots?.has(item.id)) item.fileScope = historicalRoots.get(item.id)!;
      }
      if (workerOwner && items.length) workerOwner.preview = items;
    }
    return scope;
  };
  const root = createScope();
  const updateState = (item: WorkerItem, body: Extract<ExtaliaEvent['body'], { type: 'agent.state' | 'subagent.state' }>) => {
    item.state = body.state;
    if (!item.task && body.state === 'working' && body.summary) item.task = body.summary;
    if (body.summary) item.summary = body.summary;
    if (body.phase === 'error') item.status = 'failed';
    else if (body.phase === 'interrupted') item.status = 'stopped';
    else if (item.status === 'running' || item.status === 'ok') {
      item.status = body.state === 'idle' || body.state === 'offline' ? 'ok' : body.state === 'blocked' ? 'failed' : 'running';
    }
    if (body.type === 'agent.state' && body.activity && body.summary) item.activity = body.summary;
  };
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const body = event.body;
    if (body.type === 'subagent.state') {
      const target = workers.get(body.subagentId);
      if (target) updateState(target.item, body);
      continue;
    }
    const worker = event.agentId ? workers.get(event.agentId) : undefined;
    if (!worker) {
      if (body.type === 'session.started') observed = body.control === 'observed';
      else if (event.source.channel === 'transcript' || event.source.channel === 'hook' || event.source.channel === 'mcp') observed = true;
      if (event.agentId && (body.type === 'prompt.submitted' || body.type === 'subagent.spawned')) rootAgentIds.add(event.agentId);
      root.accept(event);
      continue;
    }
    const item = worker.item;
    switch (body.type) {
      case 'prompt.submitted':
        if (!worker.hasPrompt) item.task = body.text;
        worker.hasPrompt = true;
        item.status = 'running';
        item.state = 'thinking';
        break;
      case 'agent.state': updateState(item, body); break;
      case 'tool.started': item.toolCalls++; item.activity = body.label; break;
      case 'agent.error': if (body.recoverable !== true) item.status = 'failed'; break;
      case 'turn.failed': item.status = body.reason === 'interrupted' ? 'stopped' : 'failed'; item.state = 'idle'; break;
      case 'turn.completed':
        if (item.status === 'running') item.status = 'ok';
        item.state = 'idle';
        if (body.summary) item.summary = body.summary;
        break;
      case 'session.ended':
        if (item.status === 'running') item.status = 'ok';
        item.state = 'offline';
        break;
      case 'agent.stopped': item.status = 'stopped'; item.state = 'offline'; break;
      case 'tool.completed':
        if (body.attachments?.length) {
          const current = item.attachments ?? [];
          const key = (file: AttachmentMetadata) => file.ref ?? `${file.kind}:${file.name}:${file.size}`;
          const known = new Set(current.map(key));
          const added = promptAttachmentMetadata(body.attachments).filter(file => {
            if (known.has(key(file))) return false;
            known.add(key(file)); return true;
          });
          item.attachments = [...current, ...added].slice(0, 10);
        }
        break;
    }
    // Keep existing host preparation receipts visible beside the worker card too.
    if (body.type === 'skills.loaded') worker.parent.accept(event, item);
    worker.scope.accept(event);
  }
  // Parents finish before children, so a stopped parent settles its own descendants.
  for (const scope of scopes) scope.finish();
  return root.items;
}

export interface SessionActivity {
  running: boolean;
  state: AgentState;
  activity?: ActivityKind;
  summary?: string;
  target?: string;
  pendingApprovalId?: string;
  /** The user asked to stop and the turn has not ended yet. */
  stopping: boolean;
}

/** What the session is doing right now, for the status line and the composer. */
export function projectActivity(events: readonly ExtaliaEvent[]): SessionActivity {
  let running = false, stopping = false;
  let latest: Extract<ExtaliaEvent['body'], { type: 'agent.state' }> | undefined;
  const pending = new Set<string>();
  const subagents = new Set<string>();
  const primaryIds = new Set(['primary']);
  for (const event of events) {
    const body = event.body;
    // A conversation carried over from another agent is history, not work in progress.
    if (event.source.channel === 'import') continue;
    if (event.agentId && !subagents.has(event.agentId) && (body.type === 'prompt.submitted' || body.type === 'subagent.spawned')) primaryIds.add(event.agentId);
    if (body.type === 'subagent.spawned' && body.subagentId !== event.agentId && !primaryIds.has(body.subagentId)) subagents.add(body.subagentId);
    // Workers report their own state; the status line follows the primary agent.
    if (event.agentId && subagents.has(event.agentId)) continue;
    switch (body.type) {
      case 'prompt.submitted': running = true; stopping = false; latest = undefined; pending.clear(); break;
      case 'agent.state': latest = body; break;
      case 'approval.requested': pending.add(body.approvalId); break;
      case 'approval.resolved': pending.delete(body.approvalId); break;
      case 'user.intervention': if (body.action === 'cancel' && running) stopping = true; break;
      case 'turn.completed': case 'turn.failed': case 'session.ended':
        running = false; stopping = false; pending.clear(); break;
      default: break;
    }
  }
  const pendingApprovalId = [...pending].pop();
  const state: AgentState = !running ? (latest?.state === 'offline' ? 'offline' : 'idle')
    : pendingApprovalId ? 'waiting'
      : latest && latest.state !== 'idle' ? latest.state : 'thinking';
  const result: SessionActivity = { running, state, stopping };
  if (running && latest && latest.state === state) {
    if (latest.activity) result.activity = latest.activity;
    if (latest.summary) result.summary = latest.summary;
    if (latest.target) result.target = latest.target;
  }
  if (pendingApprovalId) result.pendingApprovalId = pendingApprovalId;
  return result;
}

/** Append events that are not known yet, keeping arrival order. */
export function mergeEvents(existing: readonly ExtaliaEvent[], incoming: readonly ExtaliaEvent[]): ExtaliaEvent[] {
  const ids = new Set(existing.map(event => event.id));
  const added = incoming.filter(event => !ids.has(event.id) && ids.add(event.id));
  if (!added.length) return existing as ExtaliaEvent[];
  const merged = [...existing, ...added];
  // A transcript row can arrive after later hook events; keep source order like the host's history does.
  const tail = existing.at(-1)?.at;
  if (tail && added.some(event => event.at < tail)) {
    return merged.map((event, index) => ({ event, index }))
      .sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : a.index - b.index))
      .map(item => item.event);
  }
  return merged;
}
