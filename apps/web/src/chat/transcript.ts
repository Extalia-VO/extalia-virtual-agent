import type { ActivityKind, AgentState, ExtaliaEvent, FileChangeKind, RiskLevel, Usage } from '@extalia/protocol';

/**
 * Pure projection of a session's protocol events into what Chat shows. It
 * never mutates its input, tolerates duplicates (history and live events
 * overlap) and treats any unfinished work as stopped once a turn ends.
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

export interface UserItem { kind: 'user'; id: string; text: string; at: string }
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
  command?: CommandRun;
  files: FileChange[];
}
export interface ApprovalItem { kind: 'approval'; id: string; approvalId: string; action: string; detail?: string; risk?: RiskLevel; status: ApprovalStatus; by?: 'user' | 'policy' }
export interface FilesItem { kind: 'files'; id: string; files: FileChange[] }
export interface NoticeItem { kind: 'notice'; id: string; reason: 'cancelled' | 'failed' | 'agent-error'; text?: string }
export interface UsageItem { kind: 'usage'; id: string; usage?: Usage; model?: string; costUsd?: number; summary?: string }
/** A worker agent the primary delegated to; its own tool calls only update this card. */
export interface WorkerItem {
  kind: 'worker';
  id: string;
  subagentId: string;
  /** Task tier (`complex`, `standard`, `quick`) or another role. */
  tier?: string;
  label?: string;
  state: AgentState;
  status: ToolStatus;
  summary?: string;
  /** Label of the worker's latest tool call. */
  activity?: string;
  toolCalls: number;
  /** The primary's delegate call that started the worker. */
  callId?: string;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | ApprovalItem | FilesItem | NoticeItem | UsageItem | WorkerItem;

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

export function projectTranscript(events: readonly ExtaliaEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const seen = new Set<string>();
  const toolsByCall = new Map<string, ToolItem>();
  const approvals = new Map<string, ApprovalItem>();
  const workers = new Map<string, WorkerItem>();
  let streaming: AssistantItem | undefined;
  let turn: Turn | undefined;

  const currentTurn = (): Turn => (turn ??= { cancelled: false, tools: [], workers: [], approvals: [] });
  const settleStream = () => { if (streaming) streaming.streaming = false; streaming = undefined; };
  const runningTool = () => [...currentTurn().tools].reverse().find(tool => tool.status === 'running');
  const toolFor = (callId: string | undefined) => (callId ? toolsByCall.get(callId) : undefined) ?? runningTool();
  const endTurn = () => {
    settleStream();
    if (!turn) return;
    for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'stopped';
    for (const approval of turn.approvals) if (approval.status === 'pending') approval.status = 'expired';
    for (const worker of turn.workers) if (worker.status === 'running') worker.status = 'stopped';
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

  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const body = event.body;
    const worker = event.agentId ? workers.get(event.agentId) : undefined;
    if (worker) {
      // Worker activity stays inside its card instead of joining the primary's tool cards.
      if (body.type === 'tool.started') { worker.toolCalls++; worker.activity = body.label; }
      continue;
    }
    switch (body.type) {
      case 'prompt.submitted':
        endTurn();
        items.push({ kind: 'user', id: event.id, text: body.text, at: event.at });
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
        if (item) { item.status = body.decision; item.by = body.by; }
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
        settleStream();
        const active = currentTurn();
        const item: WorkerItem = { kind: 'worker', id: event.id, subagentId: body.subagentId, state: 'working', status: 'running', toolCalls: 0 };
        if (body.role) item.tier = body.role;
        if (body.label) item.label = body.label;
        const delegate = [...active.tools].reverse().find(tool => tool.status === 'running' && tool.activity === 'delegate');
        if (delegate?.callId) item.callId = delegate.callId;
        workers.set(body.subagentId, item);
        active.workers.push(item);
        items.push(item);
        break;
      }
      case 'subagent.state': {
        const item = workers.get(body.subagentId);
        if (!item) break;
        item.state = body.state;
        if (body.summary) item.summary = body.summary;
        if (item.status === 'running' || item.status === 'ok') {
          item.status = body.state === 'idle' || body.state === 'offline' ? 'ok' : body.state === 'blocked' ? 'failed' : 'running';
        }
        break;
      }
      case 'tool.completed': {
        const tool = (body.toolCallId ? toolsByCall.get(body.toolCallId) : undefined)
          ?? [...currentTurn().tools].reverse().find(item => item.status === 'running' && item.tool === body.tool)
          ?? startTool({ kind: 'tool', id: event.id, tool: body.tool, activity: body.kind, label: body.label, status: 'running', files: [], ...(body.toolCallId ? { callId: body.toolCallId } : {}) });
        tool.status = body.ok ? 'ok' : 'failed';
        if (body.output !== undefined) tool.output = body.output;
        if (body.target && !tool.target) tool.target = body.target;
        // A finished delegate call also settles the workers it started.
        for (const item of currentTurn().workers) {
          if (item.callId && item.callId === tool.callId && item.status === 'running') item.status = body.ok ? 'ok' : 'failed';
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
        const change = { path: body.path, change: body.change };
        const active = currentTurn();
        const tool = runningTool();
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
        if (body.action === 'cancel') {
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
        endTurn();
        break;
      }
      case 'turn.failed':
        settleStream();
        // A cancelled turn already shows why it stopped.
        if (!turn?.cancelled) items.push({ kind: 'notice', id: event.id, reason: 'failed', text: body.error });
        endTurn();
        break;
      default:
        break;
    }
  }
  return items;
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
  for (const event of events) {
    const body = event.body;
    if (body.type === 'subagent.spawned') subagents.add(body.subagentId);
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
  return added.length ? [...existing, ...added] : existing as ExtaliaEvent[];
}
