import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { normalizeClaudeHook } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

// v0.0.38: a Claude Code session live via hooks whose lead launches a background subagent. Synthesized
// transcripts in temporary homes only; no real history is read.
const temp = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const SESSION = 'claude-status-1';
const CWD = '/projects/example';

describe('observed Claude Code session live via hooks with a background subagent', () => {
  it('announces a subagent whose start hook was missed under the lead, then merges its transcript model and label', async () => {
    const root = await temp(), home = path.join(root, 'home'), claude = path.join(root, 'claude-home');
    await mkdir(home, { recursive: true });
    const source = await NativeImportService.create({ homeDirectory: home, env: { CLAUDE_CONFIG_DIR: claude } });
    const project = path.join(claude, 'projects', '-projects-example');
    const subagents = path.join(project, SESSION, 'subagents');
    await mkdir(subagents, { recursive: true });
    const main = path.join(project, `${SESSION}.jsonl`);
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    await writeFile(main,
      line({ type: 'user', sessionId: SESSION, uuid: 'u1', parentUuid: null, timestamp: at(-5000), cwd: CWD, message: { role: 'user', content: 'Fix the example' } }) +
      line({ type: 'assistant', sessionId: SESSION, uuid: 'a1', parentUuid: 'u1', timestamp: at(-4000), cwd: CWD,
        message: { role: 'assistant', model: 'claude-lead-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started a background agent.' }] } }));

    const published: ExtaliaEvent[] = [];
    const observer = await Observations.create(path.join(root, 'state'), source, event => published.push(event), 60_000, { homeDirectory: home });
    const hook = (payload: Record<string, unknown>) => observer.receiveHook(normalizeClaudeHook({ session_id: SESSION, transcript_path: main, cwd: CWD, ...payload })!);
    try {
      // The lead launches the background agent and ends its turn.
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the example' });
      await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Fix the bug', run_in_background: true }, tool_use_id: 'toolu_bg' });
      await hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_response: { status: 'async_launched' }, tool_use_id: 'toolu_bg' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Started a background agent.' });
      const [summary] = observer.summaries();
      const id = summary!.id;
      expect(summary).toMatchObject({ observation: { channel: 'hook' } });

      // The background agent works; its SubagentStart was missed (e.g. it started before this host).
      await writeFile(path.join(subagents, 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix the bug', toolUseId: 'toolu_bg', spawnDepth: 1, requestShape: 'background' }));
      await writeFile(path.join(subagents, 'agent-bg1.jsonl'),
        line({ type: 'user', sessionId: SESSION, isSidechain: true, agentId: 'bg1', uuid: 's1', parentUuid: null, timestamp: at(1000), cwd: CWD, message: { role: 'user', content: 'Fix the bug' } }) +
        line({ type: 'assistant', sessionId: SESSION, isSidechain: true, agentId: 'bg1', uuid: 's2', parentUuid: 's1', timestamp: at(2000), cwd: CWD,
          message: { role: 'assistant', model: 'claude-sub-model', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: `${CWD}/src/a.ts` } }] } }));
      published.length = 0;
      await hook({ hook_event_name: 'PreToolUse', agent_id: 'bg1', agent_type: 'general-purpose', tool_name: 'Edit', tool_input: { file_path: `${CWD}/src/a.ts` }, tool_use_id: 'toolu_edit' });
      expect(published.filter(event => event.body.type !== 'session.updated').map(event => [event.agentId, event.body.type, (event.body as { state?: string }).state])).toEqual([
        ['primary', 'subagent.spawned', undefined],
        ['bg1', 'agent.state', 'working'],
        ['bg1', 'tool.started', undefined],
      ]);
      expect(published[0]!.body).toEqual({ type: 'subagent.spawned', subagentId: 'bg1', role: 'general-purpose', label: 'general-purpose' });

      // A transcript poll merges the subagent file's label and model into the hook stream, once.
      published.length = 0;
      await observer.refresh();
      const identity = published.filter(event => event.body.type === 'subagent.spawned');
      expect(identity.map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'bg1', label: 'Fix the bug', role: 'general-purpose', model: 'claude-sub-model' }],
      ]);
      published.length = 0;
      await observer.refresh();
      expect(published.some(event => event.body.type === 'subagent.spawned')).toBe(false);

      // The session's events carry both: one subagent, nested under the lead, with its model; all valid protocol events.
      const events = observer.events(id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      const spawns = events.filter(event => event.body.type === 'subagent.spawned');
      expect(new Set(spawns.map(event => (event.body as { subagentId: string }).subagentId))).toEqual(new Set(['bg1']));
      expect(spawns.every(event => event.agentId === 'primary')).toBe(true);
      expect(observer.summaries()[0]).toMatchObject({ model: 'claude-lead-model' });
      // The newest lead state is idle (its turn ended); the subagent's own state is working.
      const states = events.filter(event => event.body.type === 'agent.state');
      expect(states.filter(event => event.agentId === 'primary').at(-1)!.body).toMatchObject({ state: 'idle' });
      expect(states.filter(event => event.agentId === 'bg1').at(-1)!.body).toMatchObject({ state: 'working', activity: 'edit' });
    } finally { await observer.close(); }
  });
});
