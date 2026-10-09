import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EventBody } from '@extalia/protocol';
import type { AnyTool, ToolOutcome, ToolRunContext } from '@extalia/runtime';
import { afterEach } from 'vitest';

/** Returns a factory for temporary directories that are removed after each test. */
export function useTempDirs(): (prefix?: string) => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });
  return async (prefix = 'extalia-host-') => {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    created.push(directory);
    return directory;
  };
}

export function toolContext(signal: AbortSignal = new AbortController().signal): { context: ToolRunContext; events: EventBody[] } {
  const events: EventBody[] = [];
  return { context: { signal, toolCallId: 'call-1', emit: body => { events.push(body); } }, events };
}

export function findTool(tools: readonly AnyTool[], name: string): AnyTool {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`No tool ${name}.`);
  return tool;
}

export async function runTool(tools: readonly AnyTool[], name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome & { events: EventBody[] }> {
  const { context, events } = toolContext(signal);
  const outcome = await findTool(tools, name).run(input, context);
  return { ...outcome, events };
}
