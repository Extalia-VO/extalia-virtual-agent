import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  normalizeAntigravityHook,
  normalizeClaudeHook,
  normalizeCodexHook,
  normalizeGeminiHook,
} from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

// Synthesized Antigravity and Gemini CLI histories and hooks in temporary homes only; no real history is read.
const temp = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const stamp = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
const spawned = (events: readonly ExtaliaEvent[]) => events.filter(event => event.body.type === 'subagent.spawned');

const agyRow = (stepIndex: number, type: string, offsetMs: number, extra: Record<string, unknown>) =>
  line({
    step_index: stepIndex,
    type,
    source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : type === 'PLANNER_RESPONSE' ? 'MODEL' : 'SYSTEM',
    status: extra.status ?? 'DONE',
    created_at: stamp(offsetMs),
    ...extra,
  });

async function createTempEnv() {
  const root = await temp();
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const published: ExtaliaEvent[] = [];
  const observer = await Observations.create(path.join(root, 'state'), source, event => published.push(event), 60_000, { homeDirectory: home });
  return { root, home, source, observer, published };
}

async function writeAntigravityTranscript(home: string, convId: string, rows: string): Promise<string> {
  const logsDir = path.join(home, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs');
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  await writeFile(transcriptPath, rows);
  return transcriptPath;
}

describe('Antigravity swarm & invoke_subagent hook normalization', () => {
  it('parses swarm(action: "add") single and batch responses with Created At / Completed At headers and handles swarm(action: "kill")', () => {
    const preSingle = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PreToolUse',
      stepIdx: 10,
      workspacePaths: ['/projects/example'],
      toolCall: { name: 'default_api:swarm', args: { action: 'add', name: 'worker-alpha', brief: 'Handle alpha', model: 'gemini-4-neon-xhigh' } },
    })!;
    expect(preSingle.steps[0]?.body).toMatchObject({ type: 'agent.state', state: 'delegating', activity: 'delegate' });
    expect(preSingle.steps[1]?.body).toMatchObject({ type: 'tool.started', tool: 'swarm', kind: 'delegate' });

    const postSingle = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PostToolUse',
      stepIdx: 10,
      toolOutput: [
        'Created At: 2026-10-15T12:00:00+00:00',
        'Completed At: 2026-10-15T12:00:02+00:00',
        JSON.stringify({
          status: 'added',
          name: 'worker-alpha',
          model: 'gemini-4-neon-xhigh',
          model_display_name: 'Gemini 4 Neon (XHigh)',
          conversation_id: 'agy-worker-alpha',
        }),
      ].join('\n'),
    })!;
    expect(postSingle.subagentSpawns).toEqual([
      { subagentId: 'agy-worker-alpha', label: 'worker-alpha', role: 'worker-alpha', model: 'Gemini 4 Neon (XHigh)' },
    ]);
    expect(postSingle.steps.map(step => step.body.type)).toEqual(['tool.completed', 'subagent.spawned']);
    expect(postSingle.steps[1]?.body).toEqual({
      type: 'subagent.spawned',
      subagentId: 'agy-worker-alpha',
      label: 'worker-alpha',
      role: 'worker-alpha',
      model: 'Gemini 4 Neon (XHigh)',
    });

    // Batch spawn via `workers` array and top-level JSON array (for `n > 1` or `tasks`).
    normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PreToolUse',
      stepIdx: 11,
      toolCall: { name: 'swarm', args: { action: 'add', name: 'shard', n: 2 } },
    });
    const postBatchObj = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PostToolUse',
      stepIdx: 11,
      toolOutput: `Created At: 2026-10-15T12:00:05+00:00\nCompleted At: 2026-10-15T12:00:06+00:00\n${JSON.stringify({
        status: 'added',
        workers: [
          { name: 'shard-1', conversation_id: 'agy-shard-1', model_display_name: 'Model A' },
          { name: 'shard-2', conversation_id: 'agy-shard-2', model: 'model-b' },
        ],
      })}`,
    })!;
    expect(postBatchObj.subagentSpawns).toEqual([
      { subagentId: 'agy-shard-1', label: 'shard-1', role: 'shard-1', model: 'Model A' },
      { subagentId: 'agy-shard-2', label: 'shard-2', role: 'shard-2', model: 'model-b' },
    ]);

    normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PreToolUse',
      stepIdx: 12,
      toolCall: { name: 'swarm', args: { action: 'add', name: 'task', tasks: ['a', 'b'] } },
    });
    const postBatchArr = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PostToolUse',
      stepIdx: 12,
      toolOutput: `Created At: 2026-10-15T12:00:07+00:00\nCompleted At: 2026-10-15T12:00:08+00:00\n${JSON.stringify([
        { status: 'added', name: 'task-1', conversation_id: 'agy-task-1' },
        { status: 'added', name: 'task-2', conversation_id: 'agy-task-2' },
      ])}`,
    })!;
    expect(postBatchArr.subagentSpawns?.map(item => item.subagentId)).toEqual(['agy-task-1', 'agy-task-2']);

    // `swarm(action: 'status')` never fabricates spawn events.
    normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PreToolUse',
      stepIdx: 13,
      toolCall: { name: 'swarm', args: { action: 'status' } },
    });
    const postStatus = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PostToolUse',
      stepIdx: 13,
      toolOutput: JSON.stringify({ members: [{ name: 'worker-alpha', conversation_id: 'agy-worker-alpha', state: 'working' }] }),
    })!;
    expect(postStatus.subagentSpawns).toBeUndefined();
    expect(postStatus.steps.map(step => step.body.type)).toEqual(['tool.completed']);

    // `swarm(action: 'kill', name)` emits `subagent.state` offline for the tracked worker id.
    normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PreToolUse',
      stepIdx: 14,
      toolCall: { name: 'swarm', args: { action: 'kill', name: 'worker-alpha' } },
    });
    const postKill = normalizeAntigravityHook({
      conversationId: 'agy-lead-1',
      hook_event_name: 'PostToolUse',
      stepIdx: 14,
      toolOutput: 'Created At: 2026-10-15T12:01:00+00:00\nCompleted At: 2026-10-15T12:01:01+00:00\n{"status":"killed","name":"worker-alpha"}',
    })!;
    expect(postKill.steps.map(step => step.body)).toEqual([
      expect.objectContaining({ type: 'tool.completed', tool: 'swarm', ok: true }),
      { type: 'subagent.state', subagentId: 'agy-worker-alpha', state: 'offline' },
    ]);
  });

  it('parses invoke_subagent (JSON & text responses) and manage_subagents kill / kill_all', () => {
    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PreToolUse',
      stepIdx: 1,
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'verifier', Role: 'Code Verifier', Model: 'gemini-4-pro' } },
    });
    const invokeJson = normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PostToolUse',
      stepIdx: 1,
      toolOutput: 'Created At: 2026-10-15T12:00:00+00:00\nCompleted At: 2026-10-15T12:00:01+00:00\n{"conversationId":"agy-sub-1","status":"started"}',
    })!;
    expect(invokeJson.subagentSpawns).toEqual([
      { subagentId: 'agy-sub-1', label: 'Code Verifier', role: 'verifier', model: 'gemini-4-pro' },
    ]);
    expect(invokeJson.steps[1]?.body).toEqual({
      type: 'subagent.spawned',
      subagentId: 'agy-sub-1',
      label: 'Code Verifier',
      role: 'verifier',
      model: 'gemini-4-pro',
    });

    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PreToolUse',
      stepIdx: 2,
      toolCall: { name: 'invoke_subagent', args: { TypeName: '"explorer"' } },
    });
    const invokeText = normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PostToolUse',
      stepIdx: 2,
      toolOutput: 'Created At: 2026-10-15T12:00:02+00:00\nCompleted At: 2026-10-15T12:00:03+00:00\nStarted subagent with conversation_id: agy-sub-2',
    })!;
    expect(invokeText.subagentSpawns).toEqual([
      { subagentId: 'agy-sub-2', label: 'explorer', role: 'explorer' },
    ]);

    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PreToolUse',
      stepIdx: 3,
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'tester' } },
    });
    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PostToolUse',
      stepIdx: 3,
      toolOutput: 'conversationId: agy-sub-3',
    });

    // Kill one explicitly via `manage_subagents(Action: 'kill')`
    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PreToolUse',
      stepIdx: 4,
      toolCall: { name: 'manage_subagents', args: { Action: 'kill', ConversationIds: ['agy-sub-1'] } },
    });
    const killOne = normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PostToolUse',
      stepIdx: 4,
      toolOutput: 'Killed 1 subagent.',
    })!;
    expect(killOne.steps.filter(step => step.body.type === 'subagent.state').map(step => step.body)).toEqual([
      { type: 'subagent.state', subagentId: 'agy-sub-1', state: 'offline' },
    ]);

    // Kill remaining tracked children via `manage_subagents(Action: 'kill_all')`
    normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PreToolUse',
      stepIdx: 5,
      toolCall: { name: 'manage_subagents', args: { Action: 'kill_all' } },
    });
    const killAll = normalizeAntigravityHook({
      conversationId: 'agy-lead-2',
      hook_event_name: 'PostToolUse',
      stepIdx: 5,
      toolOutput: 'All subagents stopped.',
    })!;
    expect(killAll.steps.filter(step => step.body.type === 'subagent.state').map(step => step.body)).toEqual([
      { type: 'subagent.state', subagentId: 'agy-sub-2', state: 'offline' },
      { type: 'subagent.state', subagentId: 'agy-sub-3', state: 'offline' },
    ]);
  });

  it('honors explicit parentConversationId and agentId fields on Antigravity hooks', () => {
    const hook = normalizeAntigravityHook({
      conversationId: 'agy-child-explicit',
      parentConversationId: 'agy-root-explicit',
      agentId: 'agy-child-explicit',
      hook_event_name: 'PreToolUse',
      stepIdx: 1,
      toolCall: { name: 'read_file', args: { Path: '/projects/example/src/index.ts' } },
    })!;
    expect(hook.parentSessionId).toBe('agy-root-explicit');
    expect(hook.agentId).toBe('agy-child-explicit');
    expect(hook.steps.every(step => step.agentId === 'agy-child-explicit')).toBe(true);
  });
});

describe('Antigravity live hook observation routing, multi-level trees & race coalescing', () => {
  it('folds swarm workers and nested invoke_subagent grandchildren into a multi-level tree under root', async () => {
    const f = await createTempEnv();
    try {
      // 1. Root lead starts and spawns `worker-a` via swarm(action: 'add')
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-root',
        hook_event_name: 'PreInvocation',
        workspacePaths: ['/projects/example'],
        modelName: 'gemini-4-lead',
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-root',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        workspacePaths: ['/projects/example'],
        toolCall: { name: 'swarm', args: { action: 'add', name: 'worker-a', brief: 'Implement task A' } },
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-root',
        hook_event_name: 'PostToolUse',
        stepIdx: 1,
        toolOutput: `Created At: 2026-10-15T12:00:00+00:00\nCompleted At: 2026-10-15T12:00:01+00:00\n${JSON.stringify({
          status: 'added',
          name: 'worker-a',
          model: 'gemini-4-worker',
          model_display_name: 'Gemini 4 Worker',
          conversation_id: 'agy-worker-a',
        })}`,
      })!);

      // 2. Worker-a works in its own worktree and spawns grandchild `helper-b` via invoke_subagent
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-worker-a',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        workspacePaths: ['/projects/worktrees/worker-a'],
        modelName: 'gemini-4-worker',
        toolCall: { name: 'invoke_subagent', args: { TypeName: 'verifier', Role: 'Helper B', Model: 'gemini-4-helper' } },
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-worker-a',
        hook_event_name: 'PostToolUse',
        stepIdx: 1,
        toolOutput: 'Created At: 2026-10-15T12:00:03+00:00\nCompleted At: 2026-10-15T12:00:04+00:00\n{"conversationId":"agy-helper-b","status":"started"}',
      })!);

      // 3. Grandchild helper-b executes a read tool
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-helper-b',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        workspacePaths: ['/projects/worktrees/worker-a'],
        toolCall: { name: 'read_file', args: { Path: '/projects/example/src/app.ts' } },
      })!);

      // 4. Root kills worker-a via swarm(action: 'kill')
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-root',
        hook_event_name: 'PreToolUse',
        stepIdx: 2,
        toolCall: { name: 'swarm', args: { action: 'kill', name: 'worker-a' } },
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-root',
        hook_event_name: 'PostToolUse',
        stepIdx: 2,
        toolOutput: '{"status":"killed","name":"worker-a"}',
      })!);

      // Only ONE top-level observed session exists; child cwd/model never overwrote root's settings!
      const summaries = f.observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        model: 'gemini-4-lead',
        observation: { sourceId: 'antigravity', nativeSessionId: 'agy-root', projectPath: '/projects/example', channel: 'hook' },
      });

      const events = f.observer.events(summaries[0]!.id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      expect(spawned(events).map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'agy-worker-a', label: 'worker-a', role: 'worker-a', model: 'Gemini 4 Worker' }],
        ['agy-worker-a', { type: 'subagent.spawned', subagentId: 'agy-helper-b', label: 'Helper B', role: 'verifier', model: 'gemini-4-helper' }],
      ]);
      expect(events.some(event => event.agentId === 'agy-helper-b' && event.body.type === 'tool.started' && event.body.tool === 'read_file')).toBe(true);
      expect(events.some(event => event.agentId === 'primary' && event.body.type === 'subagent.state' && event.body.subagentId === 'agy-worker-a' && event.body.state === 'offline')).toBe(true);
    } finally {
      await f.observer.close();
    }
  });

  it('coalesces a race-condition standalone child record into its root session when the parent spawn link arrives', async () => {
    const f = await createTempEnv();
    try {
      // Root begins calling swarm(action: 'add'), before PostToolUse returns child id.
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-race-root',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        workspacePaths: ['/projects/example'],
        toolCall: { name: 'swarm', args: { action: 'add', name: 'early-worker' } },
      })!);

      // Race condition: child conversation fires PreInvocation and PreToolUse BEFORE parent's PostToolUse arrives.
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-race-child',
        hook_event_name: 'PreInvocation',
        workspacePaths: ['/projects/example'],
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-race-child',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        workspacePaths: ['/projects/example'],
        toolCall: { name: 'read_file', args: { Path: '/projects/example/README.md' } },
      })!);

      // Before PostToolUse arrives, both root and child exist as separate auto records.
      expect(f.observer.summaries().map(s => s.observation?.nativeSessionId).sort()).toEqual(['agy-race-child', 'agy-race-root']);

      // Now parent's PostToolUse returns the link to agy-race-child.
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-race-root',
        hook_event_name: 'PostToolUse',
        stepIdx: 1,
        toolOutput: `Created At: 2026-10-15T12:00:00+00:00\nCompleted At: 2026-10-15T12:00:01+00:00\n${JSON.stringify({
          status: 'added',
          name: 'early-worker',
          model_display_name: 'Gemini 4 Fast',
          conversation_id: 'agy-race-child',
        })}`,
      })!);

      // Duplicate standalone auto-record is folded cleanly: only root remains!
      const summaries = f.observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.observation?.nativeSessionId).toBe('agy-race-root');

      const events = f.observer.events(summaries[0]!.id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      expect(spawned(events).map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'agy-race-child', label: 'early-worker', role: 'early-worker', model: 'Gemini 4 Fast' }],
      ]);
      // Child's early tool call was folded under the parent as `agy-race-child`!
      const spawnIdx = events.findIndex(event => event.body.type === 'subagent.spawned' && event.body.subagentId === 'agy-race-child');
      const foldedToolIdx = events.findIndex(event => event.agentId === 'agy-race-child' && event.body.type === 'tool.started' && event.body.tool === 'read_file');
      expect(spawnIdx).toBeGreaterThanOrEqual(0);
      expect(foldedToolIdx).toBeGreaterThan(spawnIdx);

      // Subsequent hooks from child continue routing cleanly under root.
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-race-child',
        hook_event_name: 'PostToolUse',
        stepIdx: 1,
        toolOutput: 'ok',
      })!);
      expect(f.observer.summaries()).toHaveLength(1);
      expect(f.observer.events(summaries[0]!.id).some(event => event.agentId === 'agy-race-child' && event.body.type === 'tool.completed')).toBe(true);
    } finally {
      await f.observer.close();
    }
  });

  it('does not fold a user-renamed standalone record during race coalescing', async () => {
    const f = await createTempEnv();
    try {
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-renamed-child',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        toolCall: { name: 'read_file', args: { Path: '/projects/example/a.ts' } },
      })!);
      const childSummary = f.observer.summaries()[0]!;
      await f.observer.rename(childSummary.id, 'User Named Session');

      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-renamed-root',
        hook_event_name: 'PreToolUse',
        stepIdx: 1,
        toolCall: { name: 'swarm', args: { action: 'add', name: 'renamed' } },
      })!);
      await f.observer.receiveHook(normalizeAntigravityHook({
        conversationId: 'agy-renamed-root',
        hook_event_name: 'PostToolUse',
        stepIdx: 1,
        toolOutput: JSON.stringify({ status: 'added', name: 'renamed', conversation_id: 'agy-renamed-child' }),
      })!);

      expect(f.observer.summaries()).toHaveLength(2);
      expect(f.observer.summaries().some(s => s.title === 'User Named Session')).toBe(true);
    } finally {
      await f.observer.close();
    }
  });
});

describe('Antigravity transcript subagent discovery', () => {
  it('hides child conversations from scan/autoWatch, resolves multi-level rootReference, and merges child transcripts', async () => {
    const f = await createTempEnv();
    try {
      const rootPath = await writeAntigravityTranscript(
        f.home,
        'agy-t-root',
        agyRow(1, 'USER_INPUT', 0, { content: '<USER_REQUEST>\nCoordinate Antigravity swarm\n</USER_REQUEST>' }) +
        agyRow(2, 'PLANNER_RESPONSE', 1000, {
          content: 'Spawning workers.',
          tool_calls: [
            { name: 'default_api:swarm', args: JSON.stringify({ action: 'add', name: 'worker-a', brief: 'Work A' }) },
            { name: 'default_api:swarm', args: JSON.stringify({ action: 'add', name: 'worker-b', brief: 'Work B' }) },
          ],
        }) +
        agyRow(3, 'GENERIC', 1500, {
          content: `Created At: 2026-10-15T12:00:01+00:00\nCompleted At: 2026-10-15T12:00:02+00:00\n${JSON.stringify({
            status: 'added',
            name: 'worker-a',
            model: 'gemini-4-neon',
            model_display_name: 'Gemini 4 Neon',
            conversation_id: 'agy-t-worker-a',
          })}`,
        }) +
        agyRow(4, 'GENERIC', 1600, {
          content: `Created At: 2026-10-15T12:00:02+00:00\nCompleted At: 2026-10-15T12:00:03+00:00\n${JSON.stringify({
            status: 'added',
            name: 'worker-b',
            model_display_name: 'Gemini 4 Flash',
            conversation_id: 'agy-t-worker-b',
          })}`,
        }),
      );

      const workerAPath = await writeAntigravityTranscript(
        f.home,
        'agy-t-worker-a',
        agyRow(1, 'SYSTEM_MESSAGE', 2000, { content: '<SYSTEM_MESSAGE>\nsender=agy-t-root content=You have just started.\n</SYSTEM_MESSAGE>' }) +
        agyRow(2, 'PLANNER_RESPONSE', 2500, {
          content: 'Delegating verification.',
          tool_calls: [{ name: 'default_api:invoke_subagent', args: JSON.stringify({ TypeName: 'verifier', Role: 'Nested Verifier', Model: 'gemini-4-verify' }) }],
        }) +
        agyRow(3, 'GENERIC', 3000, {
          content: 'Created At: 2026-10-15T12:00:04+00:00\nCompleted At: 2026-10-15T12:00:05+00:00\n{"conversationId":"agy-t-helper-c","status":"started"}',
        }),
      );

      await writeAntigravityTranscript(
        f.home,
        'agy-t-worker-b',
        agyRow(1, 'PLANNER_RESPONSE', 2600, {
          content: '',
          tool_calls: [{ name: 'default_api:run_command', args: JSON.stringify({ CommandLine: 'pnpm test', Cwd: '/projects/example' }) }],
        }) +
        agyRow(2, 'GENERIC', 2800, { content: 'All tests passed.' }),
      );

      const helperCPath = await writeAntigravityTranscript(
        f.home,
        'agy-t-helper-c',
        agyRow(1, 'PLANNER_RESPONSE', 3500, {
          content: '',
          tool_calls: [{ name: 'default_api:read_file', args: JSON.stringify({ Path: '/projects/example/src/verify.ts' }) }],
        }) +
        agyRow(2, 'GENERIC', 3800, { content: 'export const verified = true;' }),
      );

      const location = f.source.locations().find(item => item.sourceId === 'antigravity')!;
      // Scan shows ONLY the root session — children are folded!
      const scan = f.source.scan([location.id]);
      expect(scan.sessions.map(item => item.nativeSessionId)).toEqual(['agy-t-root']);

      // rootReference resolves both direct child and nested grandchild with full parent & spawn metadata.
      expect(f.source.rootReference({ locationId: location.id, sourceId: 'antigravity', nativeSessionId: 'agy-t-worker-a', path: workerAPath }))
        .toEqual({
          locationId: location.id,
          sourceId: 'antigravity',
          nativeSessionId: 'agy-t-root',
          path: rootPath,
          subagentId: 'agy-t-worker-a',
          parentAgentId: 'primary',
          subagentLabel: 'worker-a',
          subagentRole: 'worker-a',
          subagentModel: 'Gemini 4 Neon',
        });
      expect(f.source.rootReference({ locationId: location.id, sourceId: 'antigravity', nativeSessionId: 'agy-t-helper-c', path: helperCPath }))
        .toEqual({
          locationId: location.id,
          sourceId: 'antigravity',
          nativeSessionId: 'agy-t-root',
          path: rootPath,
          subagentId: 'agy-t-helper-c',
          parentAgentId: 'agy-t-worker-a',
          subagentLabel: 'Nested Verifier',
          subagentRole: 'verifier',
          subagentModel: 'gemini-4-verify',
        });
      // Works even for hook-only references without a transcript path yet.
      expect(f.source.rootReference({ locationId: 'hook-antigravity', sourceId: 'antigravity', nativeSessionId: 'agy-t-helper-c', path: '' }))
        .toMatchObject({ nativeSessionId: 'agy-t-root', path: rootPath, subagentId: 'agy-t-helper-c', parentAgentId: 'agy-t-worker-a' });

      // Auto-watch discovers ONLY the root and merges all 3 descendants as a multi-level tree.
      await f.observer.setAutoWatch(location.id, true);
      const summaries = f.observer.summaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        title: 'Coordinate Antigravity swarm',
        observation: { sourceId: 'antigravity', nativeSessionId: 'agy-t-root', channel: 'transcript', auto: true },
      });

      const id = summaries[0]!.id;
      const events = f.observer.events(id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      expect(spawned(events).map(event => [event.agentId, event.body])).toEqual([
        ['primary', { type: 'subagent.spawned', subagentId: 'agy-t-worker-a', label: 'worker-a', role: 'worker-a', model: 'Gemini 4 Neon' }],
        ['primary', { type: 'subagent.spawned', subagentId: 'agy-t-worker-b', label: 'worker-b', role: 'worker-b', model: 'Gemini 4 Flash' }],
        ['agy-t-worker-a', { type: 'subagent.spawned', subagentId: 'agy-t-helper-c', label: 'Nested Verifier', role: 'verifier', model: 'gemini-4-verify' }],
      ]);
      expect(events.some(event => event.agentId === 'agy-t-helper-c' && event.body.type === 'tool.started' && event.body.target === 'verify.ts')).toBe(true);

      // Appending to a nested grandchild publishes only its new steps under `agy-t-helper-c`.
      f.published.length = 0;
      await f.observer.refresh();
      expect(f.published).toHaveLength(0);
      await appendFile(helperCPath, agyRow(3, 'PLANNER_RESPONSE', 4200, { content: 'Verification complete.' }));
      await f.observer.refresh();
      const nonUpdate = f.published.filter(event => event.body.type !== 'session.updated');
      expect(nonUpdate.some(event => event.agentId === 'agy-t-helper-c' && event.body.type === 'model.completed')).toBe(true);
      expect(nonUpdate.some(event => event.body.type === 'subagent.spawned')).toBe(false);
    } finally {
      await f.observer.close();
    }
  });

  it('guards against cyclic spawn graphs without hanging or crashing', async () => {
    const f = await createTempEnv();
    try {
      const pathA = await writeAntigravityTranscript(
        f.home,
        'agy-cycle-a',
        agyRow(1, 'USER_INPUT', 0, { content: '<USER_REQUEST>\nCycle A\n</USER_REQUEST>' }) +
        agyRow(2, 'PLANNER_RESPONSE', 1000, { content: '', tool_calls: [{ name: 'swarm', args: { action: 'add', name: 'b' } }] }) +
        agyRow(3, 'GENERIC', 1100, { content: JSON.stringify({ status: 'added', name: 'b', conversation_id: 'agy-cycle-b' }) }),
      );
      await writeAntigravityTranscript(
        f.home,
        'agy-cycle-b',
        agyRow(1, 'USER_INPUT', 500, { content: '<USER_REQUEST>\nCycle B\n</USER_REQUEST>' }) +
        agyRow(2, 'PLANNER_RESPONSE', 1200, { content: '', tool_calls: [{ name: 'swarm', args: { action: 'add', name: 'a' } }] }) +
        agyRow(3, 'GENERIC', 1300, { content: JSON.stringify({ status: 'added', name: 'a', conversation_id: 'agy-cycle-a' }) }),
      );
      const location = f.source.locations().find(item => item.sourceId === 'antigravity')!;
      expect(() => f.source.scan([location.id])).not.toThrow();
      const ref = f.source.rootReference({ locationId: location.id, sourceId: 'antigravity', nativeSessionId: 'agy-cycle-a', path: pathA });
      expect(ref.subagentId).toBeUndefined();
    } finally {
      await f.observer.close();
    }
  });
});

describe('Gemini CLI orchestrator/subagent hooks & Claude/Codex regression guard', () => {
  it('spawns and settles synchronous Gemini CLI delegation tools (delegate_to_agent, codebase_investigator)', async () => {
    const f = await createTempEnv();
    try {
      await f.observer.receiveHook(normalizeGeminiHook({
        sessionId: 'gemini-lead-1',
        hookEventName: 'BeforeAgent',
        prompt: 'Investigate the repository',
        cwd: '/projects/example',
      })!);

      const beforeDelegate = normalizeGeminiHook({
        sessionId: 'gemini-lead-1',
        hookEventName: 'BeforeTool',
        toolName: 'delegate_to_agent',
        toolCallId: 'g-call-1',
        toolInput: { agent_name: 'codebase_investigator', objective: 'Find router files' },
      })!;
      expect(beforeDelegate.steps.map(step => step.body.type)).toEqual([
        'agent.state',
        'tool.started',
        'subagent.spawned',
        'subagent.state',
      ]);
      expect(beforeDelegate.steps[0]?.body).toMatchObject({ type: 'agent.state', state: 'delegating', activity: 'delegate' });
      expect(beforeDelegate.steps[2]?.body).toEqual({
        type: 'subagent.spawned',
        subagentId: 'g-call-1',
        label: 'codebase_investigator',
        role: 'codebase_investigator',
      });
      expect(beforeDelegate.steps[3]?.body).toMatchObject({ type: 'subagent.state', subagentId: 'g-call-1', state: 'working' });
      await f.observer.receiveHook(beforeDelegate);

      // Unkeyed call to `codebase_investigator` derives deterministic `gemini-sub-...` id and settles on AfterTool.
      const beforeInv = normalizeGeminiHook({
        session_id: 'gemini-lead-1',
        hook_event_name: 'BeforeTool',
        tool_name: 'codebase_investigator',
        tool_input: { query: 'Find hooks' },
      })!;
      const invSpawn = beforeInv.steps.find(step => step.body.type === 'subagent.spawned')?.body as { subagentId: string; label?: string; role?: string };
      expect(invSpawn.subagentId).toMatch(/^gemini-sub-codebase-investigator-\d+$/);
      expect(invSpawn).toMatchObject({ label: 'codebase_investigator', role: 'codebase_investigator' });
      await f.observer.receiveHook(beforeInv);

      const afterInv = normalizeGeminiHook({
        session_id: 'gemini-lead-1',
        hook_event_name: 'AfterTool',
        tool_name: 'codebase_investigator',
        tool_response: { llmContent: 'Found normalize.ts' },
      })!;
      expect(afterInv.steps.at(-1)?.body).toEqual({ type: 'subagent.state', subagentId: invSpawn.subagentId, state: 'offline' });
      await f.observer.receiveHook(afterInv);

      const afterDelegate = normalizeGeminiHook({
        sessionId: 'gemini-lead-1',
        hookEventName: 'AfterTool',
        toolName: 'delegate_to_agent',
        toolCallId: 'g-call-1',
        toolResponse: { llmContent: 'Summary ready' },
      })!;
      expect(afterDelegate.steps.at(-1)?.body).toEqual({ type: 'subagent.state', subagentId: 'g-call-1', state: 'offline' });
      await f.observer.receiveHook(afterDelegate);

      const [summary] = f.observer.summaries();
      expect(summary?.observation?.nativeSessionId).toBe('gemini-lead-1');
      const events = f.observer.events(summary!.id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      expect(spawned(events).map(event => [event.agentId, (event.body as { subagentId: string }).subagentId])).toEqual([
        ['primary', 'g-call-1'],
        ['primary', invSpawn.subagentId],
      ]);
      expect(events.filter(event => event.body.type === 'subagent.state' && event.body.state === 'offline').map(event => (event.body as { subagentId: string }).subagentId))
        .toEqual([invSpawn.subagentId, 'g-call-1']);
    } finally {
      await f.observer.close();
    }
  });

  it('links async Gemini CLI child sessions and honors camelCase agentId / parentSessionId metadata', async () => {
    const f = await createTempEnv();
    try {
      await f.observer.receiveHook(normalizeGeminiHook({
        sessionId: 'gemini-root-async',
        hookEventName: 'BeforeAgent',
        prompt: 'Run async investigation',
        cwd: '/projects/example',
      })!);
      await f.observer.receiveHook(normalizeGeminiHook({
        sessionId: 'gemini-root-async',
        hookEventName: 'BeforeTool',
        toolName: 'delegate_to_agent',
        toolCallId: 'call-async-1',
        toolInput: { agent_name: 'researcher' },
      })!);
      const afterAsync = normalizeGeminiHook({
        sessionId: 'gemini-root-async',
        hookEventName: 'AfterTool',
        toolName: 'delegate_to_agent',
        toolCallId: 'call-async-1',
        toolResponse: { session_id: 'gemini-child-async', status: 'running' },
      })!;
      expect(afterAsync.subagentSpawns).toEqual([
        { subagentId: 'gemini-child-async', label: 'researcher', role: 'researcher' },
      ]);
      await f.observer.receiveHook(afterAsync);

      // Child session reports activity (routed into lead via subagentSpawns link).
      await f.observer.receiveHook(normalizeGeminiHook({
        sessionId: 'gemini-child-async',
        hookEventName: 'BeforeTool',
        toolName: 'read_file',
        toolInput: { file_path: '/projects/example/src/a.ts' },
      })!);

      // Explicit camelCase `parentSessionId` + `agentId` + `agentType` routes another nested child into the tree!
      const nestedChild = normalizeGeminiHook({
        sessionId: 'gemini-grandchild',
        parentSessionId: 'gemini-child-async',
        agentId: 'gemini-grandchild',
        agentType: 'Verifier',
        hookEventName: 'BeforeTool',
        toolName: 'read_file',
        toolInput: { file_path: '/projects/example/src/b.ts' },
      })!;
      expect(nestedChild.parentSessionId).toBe('gemini-child-async');
      expect(nestedChild.agentType).toBe('Verifier');
      await f.observer.receiveHook(nestedChild);

      expect(f.observer.summaries()).toHaveLength(1);
      const events = f.observer.events(f.observer.summaries()[0]!.id);
      expect(events.every(event => parseEvent(event).ok)).toBe(true);
      expect(spawned(events).map(event => [event.agentId, (event.body as { subagentId: string; role?: string }).subagentId, (event.body as { role?: string }).role])).toEqual([
        ['primary', 'call-async-1', 'researcher'],
        ['primary', 'gemini-child-async', 'researcher'],
        ['gemini-child-async', 'gemini-grandchild', 'Verifier'],
      ]);
      expect(events.some(event => event.agentId === 'gemini-child-async' && event.body.type === 'tool.started' && event.body.target === 'a.ts')).toBe(true);
      expect(events.some(event => event.agentId === 'gemini-grandchild' && event.body.type === 'tool.started' && event.body.target === 'b.ts')).toBe(true);
    } finally {
      await f.observer.close();
    }
  });

  it('never emits synthetic subagent.spawned/state on PreToolUse/PostToolUse for Claude Code or Codex', () => {
    for (const [label, normalize] of [['claude', normalizeClaudeHook], ['codex', normalizeCodexHook]] as const) {
      for (const toolName of ['delegate_to_agent', 'codebase_investigator', 'Agent', 'Task', 'spawn_agent']) {
        const pre = normalize({
          session_id: `${label}-s1`,
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_use_id: `${label}-${toolName}`,
          tool_input: { description: 'Subtask' },
        })!;
        expect(pre.steps.some(step => step.body.type === 'subagent.spawned' || step.body.type === 'subagent.state'), `${label} PreToolUse ${toolName}`).toBe(false);

        const post = normalize({
          session_id: `${label}-s1`,
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
          tool_use_id: `${label}-${toolName}`,
          tool_response: { output: 'done' },
        })!;
        expect(post.steps.some(step => step.body.type === 'subagent.spawned' || step.body.type === 'subagent.state'), `${label} PostToolUse ${toolName}`).toBe(false);
      }
    }
  });
});
