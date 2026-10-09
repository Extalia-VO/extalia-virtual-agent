import { classifyTool, type ExtaliaEvent } from '@extalia/protocol';

export interface HermesPlanInput {
  cwd: string;
  prompt: string;
  profile?: string;
  model?: string;
  provider?: string;
  resumeSessionId?: string;
  yolo?: boolean;
}

export interface HermesPlanResult {
  args: readonly string[];
  stdin: string;
}

export interface HermesToolOutput {
  ok: boolean;
  output?: string;
  exitCode?: number;
  files: readonly string[];
}

/** Parses raw JSON tool output returned by Hermes Agent. */
export function parseHermesToolOutput(raw: unknown, isError: boolean): HermesToolOutput {
  const text = typeof raw === 'string' ? raw : '';
  let data: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Plain text output
  }

  if (!data) {
    return { ok: !isError, files: [], ...(text ? { output: text } : {}) };
  }

  const exitCode = [data.exit_code, data.returncode, data.exitCode].find(
    v => typeof v === 'number'
  ) as number | undefined;
  const output = [data.output, data.stdout, data.content, data.error].find(
    v => typeof v === 'string' && v
  ) as string | undefined;
  const files = Array.isArray(data.files_modified)
    ? data.files_modified.filter((f): f is string => typeof f === 'string')
    : [];
  const ok = !isError && !data.error && data.success !== false && (exitCode === undefined || exitCode === 0);

  return { ok, files, ...(output ? { output } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}

/**
 * Hermes Agent runtime adapter.
 * Formulates execution commands and normalizes stream-json outputs into Extalia Protocol v0 events.
 */
export class HermesAdapter {
  readonly id = 'hermes';

  plan(input: HermesPlanInput): HermesPlanResult {
    const args: string[] = [
      ...(input.profile && input.profile !== 'default' ? ['-p', input.profile] : []),
      'chat',
      '--query-file',
      '-',
      '--oneshot',
      '--format',
      'stream-json',
      '--source',
      'extalia',
      '--in',
      input.cwd
    ];
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    if (input.model) args.push('-m', input.model);
    if (input.provider) args.push('--provider', input.provider);
    if (input.yolo) args.push('--yolo');

    return { args, stdin: input.prompt };
  }

  createStreamParser(sessionId: string): (line: string) => readonly ExtaliaEvent[] {
    const pendingTools = new Map<string, { id: string; input: unknown }[]>();
    let counter = 0;

    return (line: string): readonly ExtaliaEvent[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return [];
      }

      const at = new Date().toISOString();
      const events: ExtaliaEvent[] = [];

      switch (data.type) {
        case 'system': {
          if (data.subtype === 'init') {
            const model = typeof data.model === 'string' ? data.model : undefined;
            events.push({
              v: 'extalia.v0',
              id: `evt-${++counter}`,
              at,
              sessionId,
              source: { runtime: 'hermes', channel: 'stream' },
              body: {
                type: 'session.started',
                control: 'managed',
                ...(model ? { model } : {})
              }
            });
          }
          break;
        }
        case 'text': {
          if (typeof data.text === 'string' && data.text) {
            events.push({
              v: 'extalia.v0',
              id: `evt-${++counter}`,
              at,
              sessionId,
              source: { runtime: 'hermes', channel: 'stream' },
              body: {
                type: 'model.delta',
                text: data.text
              }
            });
          }
          break;
        }
        case 'tool_use': {
          const name = String(data.name ?? 'tool');
          const toolId = typeof data.tool_call_id === 'string' ? data.tool_call_id : `hm_${++counter}`;
          pendingTools.set(name, [...(pendingTools.get(name) ?? []), { id: toolId, input: data.input }]);

          const { kind, label } = classifyTool(name);
          events.push({
            v: 'extalia.v0',
            id: `evt-${++counter}`,
            at,
            sessionId,
            source: { runtime: 'hermes', channel: 'stream' },
            body: {
              type: 'tool.started',
              toolCallId: toolId,
              tool: name,
              kind,
              label
            }
          });
          break;
        }
        case 'tool_result': {
          const name = String(data.name ?? 'tool');
          const queue = pendingTools.get(name) ?? [];
          const callIndex = typeof data.tool_call_id === 'string'
            ? queue.findIndex(item => item.id === data.tool_call_id)
            : 0;
          const call = callIndex >= 0 ? queue.splice(callIndex, 1)[0] : undefined;
          const result = parseHermesToolOutput(data.output, data.is_error === true);
          const toolId = call?.id ?? (typeof data.tool_call_id === 'string' ? data.tool_call_id : `hm_${++counter}`);
          const { kind, label } = classifyTool(name);

          events.push({
            v: 'extalia.v0',
            id: `evt-${++counter}`,
            at,
            sessionId,
            source: { runtime: 'hermes', channel: 'stream' },
            body: {
              type: 'tool.completed',
              toolCallId: toolId,
              tool: name,
              kind,
              label,
              ok: result.ok,
              ...(result.output ? { output: result.output } : {})
            }
          });

          for (const file of result.files) {
            events.push({
              v: 'extalia.v0',
              id: `evt-${++counter}`,
              at,
              sessionId,
              source: { runtime: 'hermes', channel: 'stream' },
              body: {
                type: 'file.written',
                path: file,
                change: 'update'
              }
            });
          }
          break;
        }
        case 'result': {
          const text = typeof data.text === 'string' ? data.text : '';
          const tokens = data.tokens as { input?: number; output?: number; cache_read?: number } | undefined;

          if (text.trim()) {
            events.push({
              v: 'extalia.v0',
              id: `evt-${++counter}`,
              at,
              sessionId,
              source: { runtime: 'hermes', channel: 'stream' },
              body: {
                type: 'model.completed',
                text
              }
            });
          }

          events.push({
            v: 'extalia.v0',
            id: `evt-${++counter}`,
            at,
            sessionId,
            source: { runtime: 'hermes', channel: 'stream' },
            body: {
              type: 'turn.completed',
              ...(tokens
                ? {
                    usage: {
                      inputTokens: tokens.input,
                      outputTokens: tokens.output,
                      cachedInputTokens: tokens.cache_read
                    }
                  }
                : {})
            }
          });
          break;
        }
      }

      return events;
    };
  }
}
