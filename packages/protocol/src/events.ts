/**
 * Extalia Protocol v0 event model.
 *
 * Runtime adapters translate native output into these events; every view (Chat,
 * Console, Office, …) consumes only these events. Nothing here may reference a
 * specific runtime, provider, UI framework or host platform.
 */

export const PROTOCOL_VERSION = 'extalia.v0';
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * How an event reached Extalia.
 * - `stream`: output of a runtime Extalia drives (managed session).
 * - `hook`: callback installed in an independently running agent app (observed session).
 * - `transcript`: read-only reading of an agent app's own session log (observed session).
 * - `mcp`: the agent reported through Extalia's MCP tools.
 * - `bridge`, `import`, `user`, `system`: Extalia itself.
 */
export type EventChannel = 'stream' | 'hook' | 'transcript' | 'mcp' | 'bridge' | 'import' | 'user' | 'system';
export const EVENT_CHANNELS: readonly EventChannel[] = ['stream', 'hook', 'transcript', 'mcp', 'bridge', 'import', 'user', 'system'];

/**
 * Who controls a session. Extalia can prompt and steer `managed` sessions; it
 * only watches `observed` sessions that run in their own app.
 */
export type SessionControl = 'managed' | 'observed';

/** Visible agent state. The office maps these to avatar behavior. */
export type AgentState = 'idle' | 'thinking' | 'working' | 'waiting' | 'delegating' | 'blocked' | 'offline';
export const AGENT_STATES: readonly AgentState[] = ['idle', 'thinking', 'working', 'waiting', 'delegating', 'blocked', 'offline'];

/** Coarse category of what an agent is doing, independent of the native tool name. */
export type ActivityKind = 'edit' | 'command' | 'test' | 'search' | 'read' | 'web' | 'delegate' | 'knowledge' | 'think' | 'tool';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['edit', 'command', 'test', 'search', 'read', 'web', 'delegate', 'knowledge', 'think', 'tool'];

export type FileChangeKind = 'add' | 'update' | 'delete';
export type InterventionAction = 'steer' | 'pause' | 'resume' | 'cancel';
export type ApprovalDecision = 'granted' | 'rejected';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Where the event came from. `runtime` is an open identifier such as `hermes` or `codex`. */
export interface EventSource {
  runtime: string;
  channel: EventChannel;
  adapter?: string;
  adapterVersion?: string;
}

export type EventBody =
  // Session lifecycle
  | { type: 'session.started'; control: SessionControl; title?: string; model?: string; cwd?: string }
  | { type: 'session.updated'; revision: string; messageCount: number }
  | { type: 'session.ended'; reason?: string }
  // Conversation
  | { type: 'prompt.submitted'; text: string; via: 'extalia' | 'native' }
  | { type: 'user.intervention'; action: InterventionAction; text?: string }
  | { type: 'model.thinking' }
  | { type: 'model.delta'; text: string }
  | { type: 'model.completed'; text: string; model?: string; usage?: Usage }
  | { type: 'turn.completed'; summary?: string; model?: string; usage?: Usage; costUsd?: number }
  | { type: 'turn.failed'; error: string }
  // Agents (envelope.agentId identifies the agent)
  | { type: 'agent.created'; name: string; role?: string; parentAgentId?: string }
  | { type: 'agent.state'; state: AgentState; activity?: ActivityKind; summary?: string; target?: string; progress?: number }
  | { type: 'agent.stopped'; reason?: string }
  | { type: 'agent.error'; message: string; recoverable?: boolean }
  | { type: 'subagent.spawned'; subagentId: string; role?: string; label?: string }
  | { type: 'subagent.state'; subagentId: string; state: AgentState; summary?: string }
  // Tools, commands and files
  | { type: 'tool.started'; toolCallId?: string; tool: string; kind: ActivityKind; label: string; target?: string }
  | { type: 'tool.output'; toolCallId?: string; text: string }
  | { type: 'tool.completed'; toolCallId?: string; tool: string; kind: ActivityKind; label: string; ok: boolean; target?: string; output?: string }
  | { type: 'command.started'; commandId?: string; command: string; cwd?: string }
  | { type: 'command.output'; commandId?: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'command.completed'; commandId?: string; exitCode: number; durationMs?: number }
  | { type: 'file.read'; path: string }
  | { type: 'file.written'; path: string; change: FileChangeKind }
  // Tasks (envelope.taskId identifies the task)
  | { type: 'task.created'; title: string; parentTaskId?: string }
  | { type: 'task.assigned'; assigneeAgentId: string }
  | { type: 'task.progress'; progress: number; summary?: string }
  | { type: 'task.completed'; ok: boolean; summary?: string }
  // Approvals
  | { type: 'approval.requested'; approvalId: string; action: string; detail?: string; risk?: RiskLevel }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalDecision; by: 'user' | 'policy' }
  // Git
  | { type: 'git.status'; changedFiles: number; branch?: string; ahead?: number; behind?: number }
  | { type: 'git.commit'; sha: string; message?: string }
  | { type: 'git.push'; ok: boolean; remote?: string; branch?: string }
  // Meetings
  | { type: 'meeting.started'; meetingId: string; participants: string[]; topic?: string }
  | { type: 'meeting.completed'; meetingId: string; decisions?: string[]; actionItems?: string[] };

export type EventType = EventBody['type'];
export type BodyOf<T extends EventType> = Extract<EventBody, { type: T }>;

export interface ExtaliaEvent<B extends EventBody = EventBody> {
  v: ProtocolVersion;
  /** Globally unique event id. */
  id: string;
  /** UTC ISO-8601 timestamp, millisecond precision at most. */
  at: string;
  /** Extalia session the event belongs to. */
  sessionId: string;
  /** Monotonic per-session sequence assigned by the store, when known. */
  seq?: number;
  agentId?: string;
  taskId?: string;
  /** Event that caused this one (for example the prompt behind a tool call). */
  parentId?: string;
  /** Groups events of one logical operation across sources. */
  correlationId?: string;
  source: EventSource;
  body: B;
}
