import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { redact, safeLabel, safeText } from '@extalia/core';
import { AGENT_APP_IDS, type AgentAppId } from '@extalia/platform';
import type { ActivityKind, AgentState, EventBody } from '@extalia/protocol';
import { DEFAULT_HOOK_PORT, readEndpoint, readToken } from '../connect/endpoint.js';
import { awaitObservedReply, isObservedReplyRequest } from '../observedReplyClient.js';
import { pollHookObservedInbox, pollObservedInbox, isObservedInboxRequest } from '../observedInboxClient.js';

/**
 * Optional MCP reporting tools (`report_intent`, `report_handoff`, `report_meeting`) that outside
 * agents can call (best effort) to report high-level intent and subagent
 * handoffs that raw tool hooks cannot see, plus a dependency-free JSON-RPC 2.0
 * stdio MCP server (`extalia mcp`) that forwards calls to the local hook ingest.
 */

export interface McpToolDefinition {
  name: 'report_intent' | 'report_handoff' | 'report_meeting' | 'report_followups' | 'await_reply' | 'poll_inbox';
  description: string;
  inputSchema: Record<string, unknown>;
}

export const EXTALIA_MCP_INSTRUCTION =
  'When Extalia MCP tools are available, call `report_intent` briefly when starting a distinct phase of work and `report_handoff` when delegating to or finishing a subagent. Use `report_meeting` only for an explicit meeting with already reported participants in this session; report its start, each contribution, and completion with the same meeting_id. At safe work boundaries, call `poll_inbox` with your `session_id` (or paired `{ url, token }`) to check for user messages queued from Extalia. Near finishing, the lead may call `report_followups` with up to three useful next prompts for this session, or an empty list when none are useful. These are suggestions for the user; never send or continue them automatically.';

export const EXTALIA_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'poll_inbox',
    description: 'Read a message from an observed session inbox or an inbox explicitly paired by the user. Poll at safe work boundaries using either { session_id } for the current watched session or { url, token } for a manual pairing. Acknowledge a message only after receiving its tool result; ack without waitMs acknowledges only. Messages never grant native approvals or permission changes. No background consumer or automatic retry.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        session_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$', description: 'Watched native session ID when polling via the local Extalia MCP hook connection.' },
        url: { type: 'string', description: 'User-paired loopback inbox URL.' },
        token: { type: 'string', description: 'Ephemeral pairing secret; never include in reports.' },
        ack: { type: 'string', description: 'Previously received message ID to acknowledge.' },
        waitMs: { type: 'integer', minimum: 0, maximum: 25000 },
      },
    },
  },
  {
    name: 'report_followups',
    description: 'Report up to three optional next prompts from this session’s lead near finishing. Suggestions do not send a prompt, continue work, or create an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' },
        agent_id: { type: 'string', const: 'primary' },
        prompts: { type: 'array', minItems: 0, maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } },
      },
      required: ['prompts'], additionalProperties: false,
    },
  },
  {
    name: 'report_meeting',
    description: 'Explicitly report a meeting lifecycle for already known agents in this calling session. This reports activity; it does not start agents, run a meeting, or write a note.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' },
        agent_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' },
        phase: { type: 'string', enum: ['start', 'contribution', 'complete'] },
        meeting_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' },
        room_id: { type: 'string', enum: ['meeting-a', 'meeting-b'] },
        topic: { type: 'string', minLength: 1, maxLength: 200 },
        participants: { type: 'array', minItems: 1, maxItems: 14, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' } },
        round: { type: 'integer', enum: [1, 2] },
        text: { type: 'string', minLength: 1, maxLength: 20000 },
        outcome: { type: 'string', enum: ['completed', 'cancelled', 'failed'] },
        note_path: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['phase', 'meeting_id'],
      additionalProperties: false,
      oneOf: [
        { properties: { phase: { const: 'start' } }, required: ['participants'], not: { anyOf: ['round', 'text', 'outcome', 'note_path'].map(key => ({ required: [key] })) } },
        { properties: { phase: { const: 'contribution' } }, required: ['agent_id', 'round', 'text'], not: { anyOf: ['participants', 'room_id', 'topic', 'outcome', 'note_path'].map(key => ({ required: [key] })) } },
        { properties: { phase: { const: 'complete' } }, not: { anyOf: ['participants', 'room_id', 'topic', 'round', 'text'].map(key => ({ required: [key] })) } },
      ],
    },
  },
  {
    name: 'await_reply',
    description: 'Wait for a cooperative Extalia reply and return it as a tool result in this calling chat. Use the URL and token explicitly paired by the user. Replies work only while this call waits; this does not answer native questions or system approvals.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'User-paired loopback reply URL.' },
        token: { type: 'string', description: 'Secret token from the same pairing; never include it in reports.' },
        question: { type: 'string', maxLength: 2000, description: 'Optional question shown in Extalia.' },
      },
      required: ['url', 'token'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_intent',
    description: 'Report what the agent is currently doing or about to do for the Extalia Virtual Office.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Optional native session identifier.' },
        intent: { type: 'string', description: 'Short summary of current intent (under 120 characters).' },
        activity: {
          type: 'string',
          enum: ['read', 'edit', 'command', 'test', 'search', 'web', 'delegate', 'other'],
          description: 'Optional activity classification.',
        },
        target: { type: 'string', description: 'Optional file or command target.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'report_handoff',
    description: 'Report a delegation or handoff to a subagent for the Extalia Virtual Office.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Optional native session identifier.' },
        subagent_id: { type: 'string', description: 'Identifier of the subagent receiving or completing the handoff.' },
        role: { type: 'string', description: 'Role or label of the subagent.' },
        summary: { type: 'string', description: 'Short description of the delegated task or outcome.' },
        state: {
          type: 'string',
          enum: ['thinking', 'working', 'waiting', 'idle', 'offline'],
          description: 'Current state of the subagent.',
        },
      },
      required: ['subagent_id'],
    },
  },
];

const ACTIVITIES = new Set<ActivityKind>(['read', 'edit', 'command', 'test', 'search', 'web', 'delegate']);
const STATES = new Set<AgentState>(['thinking', 'working', 'delegating', 'waiting', 'idle', 'offline']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isApp = (value: unknown): value is AgentAppId =>
  typeof value === 'string' && (AGENT_APP_IDS as readonly string[]).includes(value);

/** Map an explicit cooperative MCP report to Extalia Protocol event bodies. */
export function normalizeMcpReport(
  toolName: string,
  rawInput: unknown,
  options: { labelsOnly?: boolean } = {},
): { steps: { body: EventBody; agentId: string }[]; followupPrompts?: string[] } | undefined {
  const input = isObject(rawInput) ? rawInput : {};
  const steps: { body: EventBody; agentId: string }[] = [];

  if (toolName === 'report_followups') {
    if (!isObject(rawInput) || Object.keys(input).some(key => !['session_id', 'agent_id', 'prompts'].includes(key))) return undefined;
    if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !SESSION_PATTERN.test(input.session_id))) return undefined;
    if (input.agent_id !== undefined && input.agent_id !== 'primary') return undefined;
    if (!Array.isArray(input.prompts) || input.prompts.length > 3) return undefined;
    const prompts: string[] = [];
    for (const value of input.prompts) {
      if (typeof value !== 'string' || value.length > 240 || !value.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return undefined;
      const prompt = redact(value.trim()).trim();
      if (!prompt || prompt.length > 240 || prompts.includes(prompt)) return undefined;
      prompts.push(prompt);
    }
    return { steps, ...(!options.labelsOnly ? { followupPrompts: prompts } : {}) };
  }

  if (toolName === 'report_meeting') {
    if (!isObject(rawInput)) return undefined;
    const common = ['session_id', 'agent_id', 'phase', 'meeting_id'];
    const fields = input.phase === 'start' ? ['participants', 'room_id', 'topic'] : input.phase === 'contribution' ? ['round', 'text'] : input.phase === 'complete' ? ['outcome', 'note_path'] : undefined;
    if (!fields || Object.keys(input).some(key => !common.includes(key) && !fields.includes(key))) return undefined;
    if (typeof input.meeting_id !== 'string' || !ID_PATTERN.test(input.meeting_id)) return undefined;
    if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !SESSION_PATTERN.test(input.session_id))) return undefined;
    if (input.agent_id !== undefined && (typeof input.agent_id !== 'string' || !ID_PATTERN.test(input.agent_id))) return undefined;
    const agentId = typeof input.agent_id === 'string' ? input.agent_id : 'primary';
    const boundedText = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
    if (input.phase === 'start') {
      const capacity = input.room_id === 'meeting-a' ? 10 : 14;
      if (!Array.isArray(input.participants) || !input.participants.length || input.participants.length > capacity || input.participants.some(value => typeof value !== 'string' || !ID_PATTERN.test(value)) || new Set(input.participants).size !== input.participants.length) return undefined;
      if (input.room_id !== undefined && input.room_id !== 'meeting-a' && input.room_id !== 'meeting-b') return undefined;
      if (input.topic !== undefined && (!boundedText(input.topic, 200) || /[\r\n]/.test(input.topic as string))) return undefined;
      steps.push({ agentId, body: { type: 'meeting.started', meetingId: input.meeting_id, participants: input.participants as string[], ...(input.room_id ? { roomId: input.room_id } : {}), ...(!options.labelsOnly && input.topic ? { topic: safeLabel(input.topic, 200) } : {}) } });
    } else if (input.phase === 'contribution') {
      if (input.agent_id === undefined || (input.round !== 1 && input.round !== 2) || !boundedText(input.text, 20000)) return undefined;
      if (!options.labelsOnly) steps.push({ agentId, body: { type: 'meeting.contribution', meetingId: input.meeting_id, round: input.round, text: safeText(input.text as string, 20000) } });
    } else {
      if (input.outcome !== undefined && input.outcome !== 'completed' && input.outcome !== 'cancelled' && input.outcome !== 'failed') return undefined;
      if (input.note_path !== undefined && (!boundedText(input.note_path, 2000) || /[\r\n]/.test(input.note_path as string))) return undefined;
      steps.push({ agentId, body: { type: 'meeting.completed', meetingId: input.meeting_id, ...(input.outcome ? { outcome: input.outcome } : {}), ...(!options.labelsOnly && input.note_path ? { notePath: safeLabel(input.note_path, 2000) } : {}) } });
    }
    return { steps };
  }

  if (toolName === 'report_intent') {
    const summary = safeLabel(input.intent ?? input.summary, 200);
    if (!summary) return undefined;
    const rawActivity = typeof input.activity === 'string' ? input.activity.trim().toLowerCase() : '';
    const activity = ACTIVITIES.has(rawActivity as ActivityKind) ? (rawActivity as ActivityKind) : undefined;
    const target = safeLabel(input.target, 120) || undefined;
    const agentId = typeof input.agent_id === 'string' && ID_PATTERN.test(input.agent_id.trim()) ? input.agent_id.trim() : 'primary';
    steps.push({
      agentId,
      body: {
        type: 'agent.state',
        state: activity === 'delegate' ? 'delegating' : activity ? 'working' : 'thinking',
        summary,
        ...(activity ? { activity } : {}),
        ...(target ? { target } : {}),
      },
    });
    return { steps };
  }

  if (toolName === 'report_handoff') {
    const rawSubId = typeof input.subagent_id === 'string' ? input.subagent_id.trim() : typeof input.subagentId === 'string' ? input.subagentId.trim() : '';
    if (!ID_PATTERN.test(rawSubId)) return undefined;
    const role = safeLabel(input.role ?? input.label, 80) || undefined;
    const summary = safeLabel(input.summary ?? input.intent, 200) || undefined;
    const rawState = typeof input.state === 'string' ? input.state.trim().toLowerCase() : '';
    const state: AgentState = STATES.has(rawState as AgentState) ? (rawState as AgentState) : 'working';

    if (state !== 'offline' && state !== 'idle') {
      steps.push({
        agentId: 'primary',
        body: {
          type: 'subagent.spawned',
          subagentId: rawSubId,
          ...(role ? { role } : {}),
          ...(summary ? { label: summary } : role ? { label: role } : {}),
        },
      });
    }
    steps.push({
      agentId: 'primary',
      body: {
        type: 'subagent.state',
        subagentId: rawSubId,
        state,
        ...(summary ? { summary } : {}),
      },
    });
    return { steps };
  }

  return undefined;
}

export interface McpServerOptions {
  /** Extalia data directory (`EXTALIA_HOME`). */
  extaliaHome: string;
  /** Default agent app when not passed in tool arguments (`codex` by default). */
  app?: AgentAppId;
  /** Default native session id when not passed in tool arguments. */
  sessionId?: string;
  /** Explicit loopback port override. */
  port?: number;
  /** Server version reported during MCP initialize. */
  version?: string;
  /** Custom fetch for unit testing. */
  fetch?: typeof fetch;
  /** Custom liveness check for unit testing. */
  alive?: (pid: number) => boolean;
  /** Aborts a cooperative wait when its caller cancels or disconnects. */
  signal?: AbortSignal;
}

/**
 * Forward a cooperative MCP report to the local Extalia
 * hook ingest endpoint (`127.0.0.1:<port>/api/hooks/<app>`). Fails open so an
 * offline Extalia host never interrupts the calling agent.
 */
export async function forwardMcpReport(
  toolName: 'report_intent' | 'report_handoff' | 'report_meeting' | 'report_followups',
  rawArgs: unknown,
  options: McpServerOptions,
): Promise<{ delivered: boolean; status: number }> {
  const token = await readToken(options.extaliaHome);
  if (!token) return { delivered: false, status: 0 };
  const endpoint = await readEndpoint(options.extaliaHome, options.alive);
  const port = options.port ?? (endpoint?.alive ? endpoint.port : DEFAULT_HOOK_PORT);
  const args = isObject(rawArgs) ? rawArgs : {};
  if (toolName === 'report_followups' && options.sessionId && args.session_id !== undefined && args.session_id !== options.sessionId) return { delivered: false, status: 0 };
  const app: AgentAppId = isApp(args.app) ? args.app : options.app ?? 'codex';
  const argSession = typeof args.session_id === 'string' && SESSION_PATTERN.test(args.session_id.trim())
    ? args.session_id.trim()
    : undefined;
  const sessionId = argSession ?? (options.sessionId && SESSION_PATTERN.test(options.sessionId) ? options.sessionId : `mcp-${app}`);
  const body = JSON.stringify({
    hook_event_name: toolName,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: args,
    ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (app === 'hermes') {
    headers['x-hermes-signature-256'] = `sha256=${createHmac('sha256', token).update(body).digest('hex')}`;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/hooks/${app}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(1500),
    });
    return { delivered: response.status >= 200 && response.status < 300, status: response.status };
  } catch {
    return { delivered: false, status: 0 };
  }
}

/**
 * Handle one JSON-RPC 2.0 MCP message. Notifications (requests without `id`)
 * return `undefined` so nothing is written to stdout.
 */
export async function handleMcpJsonRpc(
  rawMessage: unknown,
  options: McpServerOptions,
): Promise<Record<string, unknown> | undefined> {
  if (!isObject(rawMessage)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = 'id' in rawMessage && rawMessage.id !== undefined;
  const id = rawMessage.id ?? null;
  const method = typeof rawMessage.method === 'string' ? rawMessage.method : '';
  if (!hasId) return undefined;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'extalia-virtual-office', version: options.version ?? '0.0.19' },
        instructions: EXTALIA_MCP_INSTRUCTION,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: EXTALIA_MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const params = isObject(rawMessage.params) ? rawMessage.params : {};
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (name === 'poll_inbox') {
      const rawArgs = isObject(params.arguments) ? params.arguments : undefined;
      if (rawArgs && ('url' in rawArgs || 'token' in rawArgs)) {
        if (!isObservedInboxRequest(rawArgs)) return { jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'Invalid arguments for poll_inbox.' }], isError: true } };
        const result = await pollObservedInbox(rawArgs, { fetch: options.fetch, signal: options.signal });
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: result.status !== 'message' && result.status !== 'empty' } };
      }
      if (!rawArgs || Object.keys(rawArgs).some(key => !['session_id', 'ack', 'waitMs'].includes(key))
        || (options.sessionId && rawArgs.session_id !== undefined && rawArgs.session_id !== options.sessionId)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Invalid arguments for poll_inbox.' }], isError: true } };
      }
      const sessionId = typeof rawArgs.session_id === 'string' && SESSION_PATTERN.test(rawArgs.session_id.trim())
        ? rawArgs.session_id.trim()
        : (options.sessionId && SESSION_PATTERN.test(options.sessionId) ? options.sessionId : undefined);
      if (!sessionId) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Invalid arguments for poll_inbox.' }], isError: true } };
      }
      const token = await readToken(options.extaliaHome);
      if (!token) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable' }) }], isError: true } };
      }
      const endpoint = await readEndpoint(options.extaliaHome, options.alive);
      const port = options.port ?? (endpoint?.alive ? endpoint.port : DEFAULT_HOOK_PORT);
      const app: AgentAppId = options.app ?? 'codex';
      const result = await pollHookObservedInbox({
        port,
        app,
        token,
        sessionId,
        ...(typeof rawArgs.ack === 'string' ? { ack: rawArgs.ack } : {}),
        ...(typeof rawArgs.waitMs === 'number' ? { waitMs: rawArgs.waitMs } : {}),
      }, { fetch: options.fetch, signal: options.signal });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: result.status !== 'message' && result.status !== 'empty' } };
    }
    if (name === 'await_reply') {
      if (!isObservedReplyRequest(params.arguments)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Invalid arguments for await_reply.' }], isError: true } };
      }
      const result = await awaitObservedReply(params.arguments, { fetch: options.fetch, signal: options.signal });
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'unavailable' },
      };
    }
    if (name !== 'report_intent' && name !== 'report_handoff' && name !== 'report_meeting' && name !== 'report_followups') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        },
      };
    }
    const normalized = normalizeMcpReport(name, params.arguments);
    if (!normalized || name === 'report_followups' && options.sessionId && isObject(params.arguments) && params.arguments.session_id !== undefined && params.arguments.session_id !== options.sessionId) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Invalid arguments for ${name}.` }],
          isError: true,
        },
      };
    }
    const forwarded = await forwardMcpReport(name, params.arguments, options);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: forwarded.delivered ? 'Reported to Extalia Virtual Office.' : 'Accepted (Extalia host offline).' }],
        isError: false,
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

/** Run the newline-delimited JSON-RPC 2.0 MCP server over `input` and `output` streams. */
export async function runMcpStdioServer(
  options: McpServerOptions & { input?: NodeJS.ReadableStream; output?: (line: string) => void },
): Promise<number> {
  const input = options.input ?? process.stdin;
  const write = options.output ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const active = new Map<unknown, AbortController>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  const abortAll = () => { for (const controller of active.values()) controller.abort(); };
  const onClose = () => { closed = true; abortAll(); };
  rl.on('close', onClose);
  options.signal?.addEventListener('abort', abortAll);
  try {
    for await (const rawLine of rl) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        continue;
      }
      if (isObject(parsed) && parsed.method === 'notifications/cancelled') {
        const params = isObject(parsed.params) ? parsed.params : {};
        active.get(params.requestId)?.abort();
        continue;
      }
      const id = isObject(parsed) ? parsed.id : undefined;
      if (id !== undefined && (active.has(id) || active.size >= 32)) {
        write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Duplicate or excess active request.' } }));
        continue;
      }
      const controller = new AbortController();
      if (id !== undefined) active.set(id, controller);
      if (closed || options.signal?.aborted) controller.abort();
      const task = handleMcpJsonRpc(parsed, { ...options, signal: controller.signal }).then(response => {
        if (response !== undefined) write(JSON.stringify(response));
      }).catch(() => {
        write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Internal error' } }));
      }).finally(() => {
        if (id !== undefined) active.delete(id);
        pending.delete(task);
      });
      pending.add(task);
    }
  } finally {
    abortAll();
    options.signal?.removeEventListener('abort', abortAll);
    rl.removeListener('close', onClose);
    rl.close();
    await Promise.all(pending);
  }
  return 0;
}
