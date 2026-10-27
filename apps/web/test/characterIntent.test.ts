import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import type { OfficeAgent } from '../src/office/presence';
import { characterIntent } from '../src/office/scene/characterIntent';

const en = MESSAGES.en;
const intent = (presence: Pick<OfficeAgent, 'status' | 'activity' | 'target'>, t = en) => characterIntent(presence, t);

describe('characterIntent', () => {
  it('says what a character is editing without naming the file', () => {
    expect(intent({ status: 'working', activity: 'edit', target: 'src/app.ts' })).toBe('Editing code…');
  });

  it('never shows a raw path, command or secret in the name tag', () => {
    const raw = intent({ status: 'working', activity: 'edit', target: '/Users/someone/secret.txt' });
    expect(raw).toBe('Editing code…');
    expect(intent({ status: 'working', activity: 'command', target: 'OPENAI_API_KEY=sk-ant-api03-abc rm -rf /' })).toBe('Running a command…');
  });

  it('says Reading a file for a read, without adding the target', () => {
    expect(intent({ status: 'working', activity: 'read', target: 'docs/notes.md' })).toBe('Reading a file…');
  });

  it.each([
    ['command', 'Running a command…'],
    ['test', 'Running tests…'],
    ['search', 'Searching files…'],
    ['think', 'Planning next steps…'],
    ['web', 'Researching…'],
    ['delegate', 'Coordinating another agent…'],
    ['knowledge', 'Checking notes…'],
    ['tool', 'Working…'],
  ] as const)('maps the %s activity to its safe phrase', (activity, phrase) => {
    expect(intent({ status: 'working', activity })).toBe(phrase);
  });

  it('recognises git and test commands by their text, not by a shown label', () => {
    expect(intent({ status: 'working', activity: 'command', target: 'git status' })).toBe('Checking repository…');
    expect(intent({ status: 'working', activity: 'command', target: 'pnpm test' })).toBe('Running tests…');
  });

  it('falls back to the working status when no activity is known', () => {
    expect(intent({ status: 'working' })).toBe('Working…');
  });

  it('shows the thinking status without an activity', () => {
    expect(intent({ status: 'thinking' })).toBe('Thinking…');
  });

  it('shows a delegating status without an activity', () => {
    expect(intent({ status: 'delegating' })).toBe('Delegating…');
  });

  it('says a waiting character needs approval, whatever it was doing', () => {
    expect(intent({ status: 'waiting', activity: 'command' })).toBe('Needs approval');
  });

  it('shows blocked and stopping', () => {
    expect(intent({ status: 'blocked' })).toBe('Blocked');
    expect(intent({ status: 'stopping' })).toBe('Stopping…');
  });

  it('marks an observed session as observed', () => {
    expect(intent({ status: 'observing' })).toBe('Observed');
  });

  it.each<OfficeAgent['status']>(['idle', 'offline', 'paused', 'unavailable'])('shows nothing while %s', status => {
    expect(intent({ status, activity: 'edit', target: 'src/app.ts' })).toBe('');
  });

  it('uses the Indonesian catalog when the language is Indonesian', () => {
    expect(intent({ status: 'waiting' }, MESSAGES.id)).toBe('Perlu persetujuan');
    expect(intent({ status: 'working', activity: 'read' }, MESSAGES.id)).toBe('Membaca berkas…');
  });
});
