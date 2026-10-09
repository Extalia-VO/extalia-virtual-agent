import { describe, expect, it } from 'vitest';
import { HermesAdapter, parseHermesToolOutput } from '../src/hermes.js';

describe('HermesAdapter', () => {
  const adapter = new HermesAdapter();

  it('formulates headless oneshot CLI command', () => {
    const plan = adapter.plan({
      cwd: '/workspace/project',
      prompt: 'Check git status',
      profile: 'devops',
      model: 'ag/gemini-3.8-flash',
      resumeSessionId: 'sess-123',
      yolo: true
    });

    expect(plan.args).toEqual([
      '-p', 'devops',
      'chat',
      '--query-file', '-',
      '--oneshot',
      '--format', 'stream-json',
      '--source', 'extalia',
      '--in', '/workspace/project',
      '--resume', 'sess-123',
      '-m', 'ag/gemini-3.8-flash',
      '--yolo'
    ]);
    expect(plan.stdin).toBe('Check git status');
  });

  it('parses tool output JSON and extracts exit code & files', () => {
    const jsonOutput = JSON.stringify({
      exit_code: 0,
      output: 'All tests passed',
      files_modified: ['src/index.ts', 'package.json']
    });

    const parsed = parseHermesToolOutput(jsonOutput, false);
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.output).toBe('All tests passed');
    expect(parsed.files).toEqual(['src/index.ts', 'package.json']);
  });

  it('normalizes stream-json lines into Extalia Protocol v0 events', () => {
    const parse = adapter.createStreamParser('test-session');

    // 1. Init event
    const initEvents = parse(JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'ag/gemini-3.8-flash'
    }));
    expect(initEvents).toHaveLength(1);
    const firstInit = initEvents[0]!;
    expect(firstInit.body.type).toBe('session.started');
    if (firstInit.body.type === 'session.started') {
      expect(firstInit.body.model).toBe('ag/gemini-3.8-flash');
    }

    // 2. Text delta
    const textEvents = parse(JSON.stringify({
      type: 'text',
      text: 'Analyzing repository structure...'
    }));
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!.body.type).toBe('model.delta');

    // 3. Tool use
    const toolUseEvents = parse(JSON.stringify({
      type: 'tool_use',
      name: 'terminal',
      tool_call_id: 'call_1',
      input: { command: 'git status' }
    }));
    expect(toolUseEvents).toHaveLength(1);
    expect(toolUseEvents[0]!.body.type).toBe('tool.started');

    // 4. Tool result with modified files
    const toolResultEvents = parse(JSON.stringify({
      type: 'tool_result',
      name: 'terminal',
      tool_call_id: 'call_1',
      output: JSON.stringify({
        exit_code: 0,
        output: 'clean',
        files_modified: ['README.md']
      })
    }));
    expect(toolResultEvents).toHaveLength(2);
    expect(toolResultEvents[0]!.body.type).toBe('tool.completed');
    expect(toolResultEvents[1]!.body.type).toBe('file.written');

    // 5. Result with tokens
    const resultEvents = parse(JSON.stringify({
      type: 'result',
      text: 'Finished task.',
      tokens: { input: 1500, output: 200 }
    }));
    expect(resultEvents).toHaveLength(2);
    expect(resultEvents[0]!.body.type).toBe('model.completed');
    expect(resultEvents[1]!.body.type).toBe('turn.completed');
  });
});
