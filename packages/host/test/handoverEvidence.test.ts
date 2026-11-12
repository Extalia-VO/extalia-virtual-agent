import { describe, expect, it } from 'vitest';
import { createEvent, type EventBody } from '@extalia/protocol';
import { handoverEvidence } from '../src/handoverEvidence.js';

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
  it('retains attachment metadata and discloses that image/file contents were not handed over', () => {
    const value = handoverEvidence([event({ type: 'prompt.submitted', via: 'extalia', text: 'Use the attached plan',
      attachments: [{ name: 'plan.png', kind: 'image', size: 1234, ref: 'a'.repeat(64) }] }, 'with-image')]);
    expect(value.entries[0]!.text).toContain('plan.png');
    expect(value.entries[0]!.text).not.toContain('a'.repeat(64));
    expect(value.coverage.mode).toBe('partial');
    expect(value.coverage.limits.join(' ')).toContain('bytes were not transferred');
  });
});
