import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { safeLabel } from '@extalia/core';
import { AGENT_APP_IDS, type AgentAppId } from '@extalia/platform';
import type { ActivityKind, AgentState, EventBody } from '@extalia/protocol';
import { DEFAULT_HOOK_PORT, readEndpoint, readToken } from '../connect/endpoint.js';

/**
 * Optional MCP reporting tools (`report_intent`, `report_handoff`) that outside
 * agents can call (best effort) to report high-level intent and subagent
 * handoffs that raw tool hooks cannot see, plus a dependency-free JSON-RPC 2.0
 * stdio MCP server (`extalia mcp`) that forwards calls to the local hook ingest.
 */

export interface McpToolDefinition {
  name: 'report_intent' | 'report_handoff';
  description: string;
  inputSchema: Record<string, unknown>;
}

export const EXTALIA_MCP_INSTRUCTION =
  'When Extalia MCP tools are available, call `report_intent` briefly when starting a distinct phase of work and `report_handoff` when delegating to or finishing a subagent.';

export const EXTALIA_MCP_TOOLS: readonly McpToolDefinition[] = [
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

/** Map an MCP `report_intent` or `report_handoff` call to Extalia Protocol event bodies. */
export function normalizeMcpReport(
  toolName: string,
  rawInput: unknown,
): { steps: { body: EventBody; agentId: string }[] } | undefined {
  const input = isObject(rawInput) ? rawInput : {};
  const steps: { body: EventBody; agentId: string }[] = [];

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
}

/**
 * Forward an MCP `report_intent` or `report_handoff` call to the local Extalia
 * hook ingest endpoint (`127.0.0.1:<port>/api/hooks/<app>`). Fails open so an
 * offline Extalia host never interrupts the calling agent.
 */
export async function forwardMcpReport(
  toolName: 'report_intent' | 'report_handoff',
  rawArgs: unknown,
  options: McpServerOptions,
): Promise<{ delivered: boolean; status: number }> {
  const token = await readToken(options.extaliaHome);
  if (!token) return { delivered: false, status: 0 };
  const endpoint = await readEndpoint(options.extaliaHome, options.alive);
  const port = options.port ?? (endpoint?.alive ? endpoint.port : DEFAULT_HOOK_PORT);
  const args = isObject(rawArgs) ? rawArgs : {};
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
    if (name !== 'report_intent' && name !== 'report_handoff') {
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
    if (!normalized) {
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
    const response = await handleMcpJsonRpc(parsed, options);
    if (response !== undefined) write(JSON.stringify(response));
  }
  return 0;
}
