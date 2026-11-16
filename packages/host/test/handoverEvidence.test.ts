import { describe, expect, it } from 'vitest';
import { createEvent, type EventBody } from '@extalia/protocol';
import { parseClaude, parseCodex, parseGemini } from '@extalia/importers';
import { handoverEvidence } from '../src/handoverEvidence.js';
import { transcriptEvents } from '../src/transcriptEvents.js';

const event = (body: EventBody, id: string, adapter = 'test') => createEvent({
  id, sessionId: 's_example123456', seq: 1, at: '2026-01-01T00:00:00.000Z',
  source: { runtime: 'example', channel: 'stream', adapter, adapterVersion: 'test' }, body,
});

describe('handover evidence boundaries', () => {
  it('keeps original requests, actual tools and files, without replaying or trusting summaries as receipts', () => {
    const source = [event({ type: 'prompt.submitted', text: 'Original goal', via: 'extalia' }, 'goal'),
      event({ type: 'tool.completed', toolCallId: 'read', tool: 'read_file', kind: 'read', label: 'Read', ok: true, output: 'Evidence' }, 'tool'),
      event({ type: 'model.completed', text: 'Unverified model claim' }, 'claim')];
    const value = handoverEvidence([...source, source[0]!, event({ type: 'prompt.submitted', text: 'Earlier generated capsule', via: 'extalia' }, 'capsule', 'handover-context')]);
    expect(value.entries.map(entry => entry.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(value.entries[1]!.text).toContain('Evidence');
    expect(value.coverage.mode).toBe('full');
  });
  it('does not mistake observed visibility for complete harness context', () => {
    const value = handoverEvidence([event({ type: 'model.completed', text: 'Latest visible reply' }, 'latest')], true);
    expect(value.coverage).toMatchObject({ mode: 'partial', observedThrough: 'latest', observedEntries: 1 });
    expect(value.coverage.limits.join(' ')).toContain('Hidden harness context');
  });
  it('redacts credentials and discloses clipped evidence instead of claiming full preservation', () => {
    const value = handoverEvidence([event({ type: 'model.completed', text: `token=secret-example-value\n${'x'.repeat(40_000)}` }, 'long')]);
    expect(value.entries[0]!.text).not.toContain('secret-example-value');
    expect(value.entries[0]!.text.length).toBeLessThanOrEqual(32_000);
    expect(value.coverage.mode).toBe('partial');
    expect(value.coverage.limits.join(' ')).toContain('clipped');
  });
  it('does not grow the context archive when only handover reads or generated capsules were added', () => {
    const original = event({ type: 'prompt.submitted', text: 'Original objective', via: 'extalia' }, 'original');
    const ownRead = event({ type: 'tool.completed', toolCallId: 'status-read', tool: 'continuity_status', kind: 'read', label: 'Status', ok: true, output: 'Archive metadata' }, 'read');
    const capsule = event({ type: 'prompt.submitted', text: 'Generated packet', via: 'extalia' }, 'packet', 'handover-context');
    expect(handoverEvidence([original, ownRead, capsule])).toEqual(handoverEvidence([original]));
  });
  it.each([
    'continuity_status', 'continuity_read', 'extalia_continuity_status', 'extalia_continuity_read',
    'mcp__extalia__extalia_continuity_status', 'mcp__extalia__extalia_continuity_read',
    'mcp__reviewed-archive__extalia_continuity_read',
  ])('excludes exact archive tool identity %s from newly captured evidence', tool => {
    const original = event({ type: 'prompt.submitted', text: 'Original objective', via: 'native' }, 'original');
    const read = event({ type: 'tool.completed', toolCallId: 'archive-call', tool, kind: 'read', label: 'Archive', ok: true,
      output: 'Already retained source evidence', attachments: [{ name: 'retained.txt', kind: 'file', size: 12 }] }, 'archive');
    expect(handoverEvidence([original, read], true)).toEqual(handoverEvidence([original], true));
  });
  it.each([
    'read_file', 'custom_continuity_read', 'extalia_continuity_reader', 'Extalia_continuity_read',
    'mcp__extalia__read', 'mcp__extalia__continuity_read', 'mcp__other__my_extalia_continuity_read',
    'prefix_mcp__extalia__extalia_continuity_read', 'mcp__extalia__extra__extalia_continuity_read',
  ])('retains unrelated or lookalike tool identity %s', tool => {
    const value = handoverEvidence([event({ type: 'tool.completed', toolCallId: 'ordinary-call', tool, kind: 'read', label: 'Read',
      ok: true, output: 'Fresh evidence' }, 'ordinary')]);
    expect(value.entries).toHaveLength(1);
    expect(JSON.parse(value.entries[0]!.text)).toMatchObject({ tool, output: 'Fresh evidence' });
  });
  it('retains attachment metadata and discloses that image/file contents were not handed over', () => {
    const value = handoverEvidence([event({ type: 'prompt.submitted', via: 'extalia', text: 'Use the attached plan',
      attachments: [{ name: 'plan.png', kind: 'image', size: 1234, ref: 'a'.repeat(64) }] }, 'with-image')]);
    expect(value.entries[0]!.text).toContain('plan.png');
    expect(value.entries[0]!.text).not.toContain('a'.repeat(64));
    expect(value.coverage.mode).toBe('partial');
    expect(value.coverage.limits.join(' ')).toContain('bytes were not transferred');
  });
});

const calls = [
  { name: 'mcp__extalia__extalia_continuity_status', output: 'ARCHIVE-STATUS-REPEATED' },
  { name: 'extalia_continuity_read', output: 'ARCHIVE-CONTENT-REPEATED' },
  { name: 'read_file', output: 'FRESH-FILE-EVIDENCE' },
  { name: 'mcp__other__custom_extalia_continuity_read', output: 'FRESH-OTHER-EVIDENCE' },
];
const at = '2026-01-01T00:00:00.000Z';
const jsonLines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const codex = jsonLines([{ type: 'session_meta', payload: { id: 'native-fixture', cwd: '/example/project', timestamp: at } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the original objective' }] } },
  ...calls.flatMap((call, index) => [
    { type: 'response_item', timestamp: at, payload: { type: 'function_call', name: call.name, call_id: `call-${index}`, arguments: '{}' } },
    { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: `call-${index}`, output: call.output } },
  ]),
]);
const claude = jsonLines([
  { type: 'user', message: { role: 'user', content: 'Continue the original objective' } },
  ...calls.flatMap((call, index) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `call-${index}`, name: call.name, input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: call.output }] } },
  ]),
].map((row, index) => ({ ...row, sessionId: 'native-fixture', uuid: `row-${index}`, parentUuid: index ? `row-${index - 1}` : null, timestamp: at })));
const gemini = JSON.stringify({ sessionId: 'native-fixture', projectHash: 'fixture-project', startTime: at, messages: [
  { id: 'prompt', type: 'user', timestamp: at, content: 'Continue the original objective' },
  { id: 'reply', type: 'gemini', timestamp: at, content: '', toolCalls: calls.map((call, index) => ({
    id: `call-${index}`, name: call.name, args: {}, status: 'success',
    result: [{ functionResponse: { name: call.name, response: { output: call.output } } }],
  })) },
] });

describe('native transcript archive-read evidence boundary', () => {
  it.each([
    { runtime: 'codex' as const, parse: parseCodex, text: codex },
    { runtime: 'claude-code' as const, parse: parseClaude, text: claude },
    { runtime: 'gemini-cli' as const, parse: parseGemini, text: gemini },
  ])('preserves fresh $runtime tool evidence without rearchiving external MCP reads', ({ runtime, parse, text }) => {
    const parsed = parse(text, { sourceId: runtime, nativeSessionId: 'native-fixture', exportedAt: at });
    expect(parsed.session).toBeDefined();
    const events = transcriptEvents({ sessionId: 'observed-fixture', runtime, title: 'Fixture', createdAt: at, steps: parsed.steps! });
    // Check the real import path retained identities; a missing tool import must
    // not make the exclusion assertion pass accidentally.
    expect(events.filter(event => event.body.type === 'tool.completed').map(event => event.body.type === 'tool.completed' && event.body.tool))
      .toEqual(calls.map(call => call.name));
    const captured = handoverEvidence(events, true);
    expect(captured.entries.filter(entry => entry.kind === 'tool').map(entry => JSON.parse(entry.text).output))
      .toEqual(['FRESH-FILE-EVIDENCE', 'FRESH-OTHER-EVIDENCE']);
    expect(JSON.stringify(captured)).not.toContain('ARCHIVE-');
    expect(captured.entries[0]!.text).toBe('Continue the original objective');
    expect(captured.coverage.mode).toBe('partial');
  });
});
