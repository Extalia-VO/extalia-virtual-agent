import { describe, expect, it } from 'vitest';
import { observedReadCandidate } from '../src/observe/observedRead';

const visibleOutput = { sessionId: 'session-a', revision: 'output-2', loadedRevision: 'output-2', unread: true, latestAssistant: 'The actual new assistant response', renderedAssistant: 'The actual new assistant response', visible: true, pinned: true, atLatest: true, assistantVisible: true };

describe('observed output read receipts', () => {
  it('acknowledges the exact revision rendered in the current latest-output viewport', () => {
    expect(observedReadCandidate(visibleOutput)).toEqual({ sessionId: 'session-a', revision: 'output-2' });
  });
  it.each(['visible', 'pinned', 'atLatest', 'assistantVisible'] as const)('keeps output unread when %s is false', field => {
    expect(observedReadCandidate({ ...visibleOutput, [field]: false })).toBeUndefined();
  });
  it('does not treat visiting a session or viewing stale stream events as reading its latest output', () => {
    expect(observedReadCandidate({ ...visibleOutput, loadedRevision: 'output-1' })).toBeUndefined();
    expect(observedReadCandidate({ ...visibleOutput, renderedAssistant: 'Earlier assistant response' })).toBeUndefined();
    expect(observedReadCandidate({ ...visibleOutput, renderedAssistant: undefined })).toBeUndefined();
  });
  it('does not fabricate unread output from user prompts, tools, status changes or empty responses', () => {
    expect(observedReadCandidate({ ...visibleOutput, unread: false })).toBeUndefined();
    expect(observedReadCandidate({ ...visibleOutput, revision: undefined })).toBeUndefined();
    expect(observedReadCandidate({ ...visibleOutput, latestAssistant: '' })).toBeUndefined();
    expect(observedReadCandidate({ ...visibleOutput, latestAssistant: ' ', renderedAssistant: ' ' })).toBeUndefined();
  });
  it('captures the rendered revision and leaves newer output unread until that new output is rendered', () => {
    const receipt = observedReadCandidate(visibleOutput);
    expect(receipt?.revision).toBe('output-2');
    expect(observedReadCandidate({ ...visibleOutput, revision: 'output-3' })).toBeUndefined();
    expect(receipt?.revision).toBe('output-2');
  });
});
