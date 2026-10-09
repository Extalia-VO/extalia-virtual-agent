import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';

/**
 * A scripted session used to exercise the protocol without any runtime.
 * It is labeled as a demo source so it can never be mistaken for real activity.
 */
export function demoSession(start = new Date('2026-01-31T09:00:00.000Z')): ExtaliaEvent[] {
  const sessionId = 'demo-session';
  const source = { runtime: 'demo', channel: 'system' as const };
  let offset = 0;
  const at = () => new Date(start.getTime() + (offset += 1500));
  const event = (body: EventBody, extra: { agentId?: string; taskId?: string } = {}) =>
    createEvent({ sessionId, source, ...extra, body }, at);

  return [
    event({ type: 'session.started', control: 'managed', title: 'Add a health check endpoint' }),
    event({ type: 'agent.created', name: 'Primary agent', role: 'primary' }, { agentId: 'primary' }),
    event({ type: 'prompt.submitted', text: 'Add a /health endpoint and a test for it.', via: 'extalia' }),
    event({ type: 'agent.state', state: 'thinking' }, { agentId: 'primary' }),
    event({ type: 'task.created', title: 'Implement /health' }, { taskId: 'task-1' }),
    event({ type: 'task.assigned', assigneeAgentId: 'primary' }, { taskId: 'task-1' }),
    event({ type: 'agent.state', state: 'working', activity: 'edit', target: 'server.ts', summary: 'Editing server.ts' }, { agentId: 'primary', taskId: 'task-1' }),
    event({ type: 'tool.started', toolCallId: 'call-1', tool: 'edit_file', kind: 'edit', label: 'Editing server.ts', target: 'server.ts' }, { agentId: 'primary' }),
    event({ type: 'file.written', path: 'src/server.ts', change: 'update' }, { agentId: 'primary' }),
    event({ type: 'tool.completed', toolCallId: 'call-1', tool: 'edit_file', kind: 'edit', label: 'Editing server.ts', ok: true }, { agentId: 'primary' }),
    event({ type: 'agent.state', state: 'working', activity: 'test', target: 'npm test', summary: 'Running tests' }, { agentId: 'primary', taskId: 'task-1' }),
    event({ type: 'command.started', commandId: 'cmd-1', command: 'npm test' }, { agentId: 'primary' }),
    event({ type: 'command.completed', commandId: 'cmd-1', exitCode: 0, durationMs: 2100 }, { agentId: 'primary' }),
    event({ type: 'task.completed', ok: true, summary: '/health returns 200 with build info.' }, { taskId: 'task-1' }),
    event({ type: 'model.completed', text: 'Added GET /health and a passing test.' }, { agentId: 'primary' }),
    event({ type: 'agent.state', state: 'idle' }, { agentId: 'primary' }),
    event({ type: 'turn.completed', summary: 'Health check added.', usage: { inputTokens: 1840, outputTokens: 420 } }),
  ];
}

export const demoSessionLines = () => demoSession().map(item => JSON.stringify(item)).join('\n');
