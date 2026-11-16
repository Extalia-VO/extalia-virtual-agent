import { readFile } from 'node:fs/promises';
import { expect, vi } from 'vitest';
import type { AgentHostRuntime } from '../src/service.js';

/** A real hook listener and observed source, entirely inside the caller's temporary host. */
export async function learningObservedFixture(runtime: AgentHostRuntime, project: string) {
  const ingest = await runtime.host.hookIngest();
  const token = (await readFile(ingest.tokenPath, 'utf8')).trim();
  const listener = await runtime.hooks!.listen();
  const nativeSessionId = 'foreign-observed-review';
  const post = async (event: string, extra: Record<string, unknown> = {}) => {
    const result = await fetch(`http://127.0.0.1:${listener.port}/api/hooks/claude`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: nativeSessionId, hook_event_name: event, cwd: project, ...extra }),
    });
    expect(result.status).toBe(204);
  };
  await post('UserPromptSubmit', { prompt: 'Keep the foreign project research private.' });
  let sessionId = '';
  await vi.waitFor(async () => {
    const source = (await runtime.host.getState()).sessions.find(item => item.observation?.nativeSessionId === nativeSessionId);
    expect(source).toMatchObject({ control: 'observed', running: true });
    sessionId = source!.id;
  }, { timeout: 5_000, interval: 5 });
  return { sessionId,
    async changeProject(location: string) {
      await post('UserPromptSubmit', { cwd: location, prompt: 'Continue reviewing the reported project.' });
    },
    async pulse() {
      await post('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'foreign-reference.md' } });
      await post('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'foreign-reference.md' }, tool_response: 'Foreign project evidence.' });
    },
  };
}
