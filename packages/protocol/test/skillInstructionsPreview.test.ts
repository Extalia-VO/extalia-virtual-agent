import { describe, expect, it } from 'vitest';
import { parseDaemonFrame } from '../src/index.js';
import frames from './fixtures/daemon/frames.json' with { type: 'json' };

const baseline = frames.cases.find(item => item.name === 'skill.inspect response')!.value;
const preview = (instructions: string) => ({ ...baseline, result: { ...('result' in baseline ? baseline.result : {}), instructions } });

describe('candidate instruction previews', () => {
  it('accepts normal multiline Markdown without granting activation', () => {
    const frame = preview('# Review\n\nRead the input.\n\tCheck the result.');
    expect(parseDaemonFrame(frame).ok).toBe(true);
    expect(frame.result).toMatchObject({ revision: { state: 'quarantined', active: false } });
  });

  it.each(['', '   ', 'Invalid\u0000content', 'x'.repeat(65_537)])('refuses blank, binary or oversized content', instructions => {
    expect(parseDaemonFrame(preview(instructions)).ok).toBe(false);
  });
});
