import { STOP_REASON_TEXT, safeLabel, type StopReason } from '@extalia/core';
import type { TranscriptStep } from '@extalia/importers';
import { classifyTool, createEvent, mcpToolName, type ActivityKind, type AgentPhase, type AgentState, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { createHash } from 'node:crypto';

/**
 * Extalia Protocol events of an observed session, derived from the structured
 * steps a native transcript states. Event ids hash the session, the step's
 * source position and the body, so reading an unchanged transcript again yields
 * the same ids (replays deduplicate) and the list only grows as the transcript
 * grows. A turn ends where the source marks it, where the next prompt starts,
 * or—for sources that do not mark final replies (older Codex, Claude without
 * `stop_reason`)—once a trailing assistant reply has settled for 30 s.
 */

export const IDLE_REPLY_SETTLE_MS = 30_000;

export interface ObservedTranscript {
  sessionId: string;
  runtime: string;
  title: string;
  createdAt: string;
  cwd?: string;
  steps: readonly TranscriptStep[];
  /** Drop prompt text, assistant reply text and tool output, keeping only activity labels. */
  labelsOnly?: boolean;
  /** Optional current time (epoch ms) to settle trailing replies that lack an explicit `final` flag. */
  nowMs?: number;
  /**
   * Keep a private copy of an image a prompt embeds and return its reference (the bytes' SHA-256), so the
   * app can show it; without this hook, or when it returns nothing, the file is listed by name only.
   */
  keepAttachment?: (data: string, mimeType: string) => string | undefined;
}

const OUTPUT_LIMIT = 4_000;
const TEST_COMMAND = /\b(?:vitest|jest|pytest|mocha|rspec|phpunit|ctest|tox)\b|\b(?:go|cargo|dotnet|mix|deno|bun) test\b|\b(?:npm|pnpm|yarn|bun)(?: run| exec)? (?:test|check|lint)\b|\bmake (?:test|check)\b/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ToolCallDescription {
  tool: string; kind: ActivityKind; label: string; target?: string;
  /** v0.0.38: the call writes a plan or to-do list (`planning`) or asks the user a question (`input`). */
  phase?: 'planning' | 'input';
}
type Call = ToolCallDescription;

/** Plan and to-do tools of Claude Code, Codex, Gemini CLI and Hermes. */
const PLAN_TOOL = /^(?:todowrite|todo_write|write_todos|update_plan|todo|exitplanmode|enterplanmode)$/;
/** Tools that ask the user and wait for the answer. */
const ASK_TOOL = /^(?:askuserquestion|ask_user|ask_user_question|ask_question|request_user_input|clarify|ask_followup_question)$/;

/** The state a tool call puts its agent in: waiting for an answer, planning, delegating or working. */
export function toolCallState(call: Pick<ToolCallDescription, 'kind' | 'phase'>): { state: AgentState; phase?: AgentPhase } {
  if (call.phase === 'input') return { state: 'waiting', phase: 'input' };
  if (call.phase === 'planning') return { state: 'working', phase: 'planning' };
  return { state: call.kind === 'delegate' ? 'delegating' : 'working' };
}

/** `agent.state` body for a tool call. */
export function toolStateBody(call: ToolCallDescription): EventBody {
  return { type: 'agent.state', ...toolCallState(call), activity: call.kind, summary: call.label, ...(call.target ? { target: call.target } : {}) };
}

/** Activity kind (a test run is `test`), label and short target of a tool call; shared by transcript and hook events. */
export function describeToolCall(step: Pick<Extract<TranscriptStep, { type: 'tool.call' }>, 'tool' | 'target' | 'command'>): ToolCallDescription {
  return describe(step);
}

function describe(step: Pick<Extract<TranscriptStep, { type: 'tool.call' }>, 'tool' | 'target' | 'command'>): Call {
  const lower = step.tool.trim().toLowerCase();
  if (PLAN_TOOL.test(lower)) return { tool: step.tool, kind: 'think', label: 'Planning', phase: 'planning' };
  if (ASK_TOOL.test(lower)) return { tool: step.tool, kind: 'tool', label: 'Asking the user', phase: 'input' };
  const mcp = mcpToolName(step.tool);
  const classified = classifyTool(step.tool);
  if (mcp && classified.kind === 'tool') return { tool: step.tool, kind: 'tool', label: safeLabel(`Using ${mcp}`, 200) || step.tool, ...(step.target ? { target: step.target } : {}) };
  const kind: ActivityKind = classified.kind === 'command' && step.command && TEST_COMMAND.test(step.command) ? 'test' : classified.kind;
  const label = step.command ? `Running ${step.command}` : step.target ? `${classified.label}: ${step.target}` : classified.label;
  return { tool: step.tool, kind, label: safeLabel(label, 200) || step.tool, ...(step.target ? { target: step.target } : {}) };
}

export function transcriptEvents(input: ObservedTranscript): ExtaliaEvent[] {
  const source = { runtime: input.runtime, channel: 'transcript' as const, adapter: 'native-transcript' };
  const events: ExtaliaEvent[] = [];
  let last = input.createdAt;
  const add = (body: EventBody, at: string, key: unknown[], agentId?: string, hashBody = true) => {
    try {
      events.push(createEvent({
        id: `observed-${digest([input.sessionId, ...key, ...(hashBody ? [body] : [])])}`, at, seq: events.length, sessionId: input.sessionId, source, body,
        ...(agentId ? { agentId } : {}),
      }));
    } catch { /* a step that cannot form a valid event is left out */ }
  };
  add({ type: 'session.started', control: 'observed', title: input.title || 'Observed session', ...(input.cwd ? { cwd: input.cwd } : {}) }, input.createdAt, ['session.started'], undefined, false);

  const calls = new Map<string, Call>();
  const open = new Map<string, { model?: string; lastStep?: 'prompt' | 'reply' | 'tool.call' | 'tool.result' | 'status'; lastPos?: string; lastAt?: string }>();
  // A closed turn leaves its agent idle; `phase` tells an interrupted or failed turn from a finished one,
  // and v0.0.43 `reason` why a failed one stopped (out of quota, rate limited, signed out, …) when the source says.
  const close = (agentId: string, at: string, pos: string, slot: string, phase?: 'interrupted' | 'error', reason?: StopReason) => {
    const turn = open.get(agentId);
    open.delete(agentId);
    const why = phase === 'error' && reason ? { reason } : {};
    if (turn) {
      add(phase === 'error' ? { type: 'turn.failed', error: reason ? STOP_REASON_TEXT[reason] : 'The turn failed.', ...why } : { type: 'turn.completed', ...(turn.model ? { model: turn.model } : {}) }, at, [pos, slot, 'turn'], agentId);
    }
    if (turn || phase) add({ type: 'agent.state', state: 'idle', ...(phase ? { phase } : {}), ...why }, at, [pos, slot, 'idle'], agentId);
  };
  const touch = (agentId: string, at: string, pos: string) => {
    const turn = open.get(agentId);
    if (turn) { turn.lastStep = 'status'; turn.lastPos = pos; turn.lastAt = at; }
  };
  // Sub-agents are announced once, from the agent that spawned them (the primary unless the source
  // names another sub-agent), so the Office lists them under their lead. Sources with sub-agent files
  // state the spawn (`subagent.spawn`); for rows that only carry an agent id (Claude Code sidechains in
  // the main transcript) the label is the delegation that started it. The model is the one the source
  // names, else the sub-agent's first reply's. The id leaves the body out, so a model learned later
  // never repeats the announcement.
  const spawned = new Set<string>();
  const firstModel = new Map<string, string>();
  for (const step of input.steps) if (step.type === 'reply' && step.model && step.agentId && !firstModel.has(step.agentId)) firstModel.set(step.agentId, step.model);
  let lastDelegation: string | undefined;
  for (const step of input.steps) {
    const at = step.at && step.at > last ? step.at : last;
    last = at;
    const agentId = step.agentId || 'primary';
    if (step.type === 'subagent.spawn') {
      if (step.subagentId === 'primary' || spawned.has(step.subagentId)) continue;
      spawned.add(step.subagentId);
      const model = step.model ?? firstModel.get(step.subagentId);
      add({ type: 'subagent.spawned', subagentId: step.subagentId, ...(step.label ? { label: step.label } : {}), ...(step.role ? { role: step.role } : {}), ...(model ? { model } : {}) },
        at, [step.pos, 'spawned', step.subagentId], agentId, false);
      continue;
    }
    if (agentId !== 'primary' && !spawned.has(agentId)) {
      spawned.add(agentId);
      const model = firstModel.get(agentId);
      add({ type: 'subagent.spawned', subagentId: agentId, ...(lastDelegation ? { label: lastDelegation, role: lastDelegation } : {}), ...(model ? { model } : {}) }, at, [step.pos, 'spawned', agentId], 'primary', false);
    }
    if (agentId === 'primary' && step.type === 'tool.call') {
      const call = describe(step);
      if (call.kind === 'delegate') lastDelegation = safeLabel(step.target ?? call.label, 80) || undefined;
    }
    switch (step.type) {
      case 'prompt':
        // A turn the source never closed ends where the next one starts.
        close(agentId, at, step.pos, 'before');
        if (!input.labelsOnly) {
          const attachments = (step.attachments ?? []).slice(0, 10).map(file => {
            const ref = file.data && file.mimeType ? input.keepAttachment?.(file.data, file.mimeType) : undefined;
            return { name: file.name, kind: file.kind, size: file.size, ...(ref ? { ref } : {}) };
          });
          add({ type: 'prompt.submitted', text: step.text, via: 'native', ...(attachments.length ? { attachments } : {}) }, at, [step.pos, 'prompt'], agentId);
        }
        add({ type: 'agent.state', state: 'thinking' }, at, [step.pos, 'thinking'], agentId);
        open.set(agentId, { lastStep: 'prompt', lastPos: step.pos, lastAt: at });
        break;
      case 'reply': {
        if (!input.labelsOnly) {
          add({ type: 'model.completed', text: step.text, ...(step.model ? { model: step.model } : {}) }, at, [step.pos, 'reply'], agentId);
        }
        const turn = open.get(agentId) ?? {};
        if (step.model) turn.model = step.model;
        turn.lastStep = 'reply';
        turn.lastPos = step.pos;
        turn.lastAt = at;
        open.set(agentId, turn);
        if (step.final) close(agentId, at, step.pos, 'final');
        break;
      }
      case 'tool.call': {
        const call = describe(step);
        if (step.callId) calls.set(step.callId, call);
        const turn = open.get(agentId) ?? {};
        turn.lastStep = 'tool.call';
        turn.lastPos = step.pos;
        turn.lastAt = at;
        open.set(agentId, turn);
        add(toolStateBody(call), at, [step.pos, 'working'], agentId);
        add({ type: 'tool.started', ...(step.callId ? { toolCallId: step.callId } : {}), tool: call.tool, kind: call.kind, label: call.label, ...(call.target ? { target: call.target } : {}) }, at, [step.pos, 'tool.started'], agentId);
        break;
      }
      case 'tool.result': {
        const call: Call = (step.callId ? calls.get(step.callId) : undefined) ?? (() => { const tool = step.tool || 'tool'; const classified = classifyTool(tool); return { tool, kind: classified.kind, label: classified.label }; })();
        const output = !input.labelsOnly && step.output ? step.output.slice(0, OUTPUT_LIMIT) : undefined;
        const turn = open.get(agentId);
        if (turn) { turn.lastStep = 'tool.result'; turn.lastPos = step.pos; turn.lastAt = at; }
        add({
          type: 'tool.completed', ...(step.callId ? { toolCallId: step.callId } : {}), tool: call.tool, kind: call.kind, label: call.label, ok: step.ok,
          ...(call.target ? { target: call.target } : {}), ...(output ? { output } : {}),
        }, at, [step.pos, 'tool.completed'], agentId);
        break;
      }
      case 'turn.end':
        close(agentId, at, step.pos, 'end', step.reason === 'interrupted' ? 'interrupted' : undefined);
        break;
      case 'status':
        if (step.status === 'error') { close(agentId, at, step.pos, 'error', 'error', step.reason); break; }
        touch(agentId, at, step.pos);
        add(step.status === 'thinking' ? { type: 'agent.state', state: 'thinking' }
          : step.status === 'compacting' ? { type: 'agent.state', state: 'thinking', phase: 'compacting', summary: 'Compacting context' }
            : step.status === 'approval' ? { type: 'agent.state', state: 'waiting', phase: 'approval', summary: 'Waiting for approval' }
              : { type: 'agent.state', state: 'waiting', phase: 'input', summary: 'Waiting for the user' }, at, [step.pos, 'status'], agentId);
        break;
    }
  }

  // Settle trailing replies from sources that do not emit an explicit final marker.
  if (input.nowMs !== undefined) {
    for (const [agentId, turn] of [...open.entries()]) {
      if (turn.lastStep === 'reply' && turn.lastPos && turn.lastAt) {
        const replyMs = Date.parse(turn.lastAt);
        if (Number.isFinite(replyMs) && input.nowMs - replyMs >= IDLE_REPLY_SETTLE_MS) {
          close(agentId, turn.lastAt, turn.lastPos, 'settled');
        }
      }
    }
  }

  return events;
}

/** The events of the latest turn (from its prompt on), at most `limit`. */
export function latestTurn(events: readonly ExtaliaEvent[], limit = 60): ExtaliaEvent[] {
  let start = events.length;
  for (let index = events.length - 1; index > 0; index--) {
    start = index;
    if (events[index]!.body.type === 'prompt.submitted' && (events[index]!.agentId ?? 'primary') === 'primary') break;
  }
  return events.slice(Math.max(start, events.length - limit));
}
