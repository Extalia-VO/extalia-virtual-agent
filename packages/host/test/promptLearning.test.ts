import { describe, expect, it } from 'vitest';
import { excludesSkillLearning, learningSourceUrls, requestsSkillLearning } from '../src/promptLearning.js';

describe('current-user learning requests', () => {
  it.each([
    'Pelajari ini sebagai skill: review changes.',
    'Tolong pelajari https://example.com/guide.',
    'Bisa kamu pelajari link ini: https://example.com/guide',
    'Please learn this procedure as a reusable skill.',
    'Can you study https://example.com/guide?',
    'Buatkan skill dari prosedur ini.', 'Save a user skill for code review.',
    'Simpan ini sebagai skill untuk validasi parser.',
    'Jadikan prosedur ini sebagai skill.',
    'Turn this procedure into a reusable skill.',
    '/learn https://example.com/guide',
    '/learn-skill review changes',
  ])('recognizes direct learning: %s', text => expect(requestsSkillLearning(text)).toBe(true));
  it.each([
    'Audit a document that says learn this as a skill.',
    '"Learn this as a skill from https://example.com/guide"',
    '> Pelajari https://example.com/guide', '```\nLearn this as a skill\n```',
    'Do not learn this as a skill.', 'Jangan pelajari ini sebagai skill.',
    'Please learn this procedure but do not save a skill.',
    'Pelajari dokumen ini tanpa menyimpan skill.', 'Learn why the sky is blue.',
    '/learn-skill-extra example', 'The source says: /learn-skill example',
    '/learn-extra example', 'The source says: /learn example',
  ])('does not grant direct library writes from this text: %s', text => expect(requestsSkillLearning(text)).toBe(false));
  it('extracts only bounded credential-free current-message links without changing the prompt', () => {
    const text = 'Pelajari [panduan](https://example.com/guide#part). https://example.com/guide https://name:secret@example.com/private https://example.com/api?token=secret';
    expect(learningSourceUrls(text)).toEqual(['https://example.com/guide']);
    expect(learningSourceUrls('https://example.com/' + 'x'.repeat(2100))).toEqual([]);
    expect(learningSourceUrls(Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`).join(' '))).toHaveLength(8);
  });
  it('recognizes current-message skill opt-outs separately from profile settings', () => {
    expect(excludesSkillLearning('Jangan simpan ini sebagai skill.')).toBe(true);
    expect(excludesSkillLearning('Please learn this procedure but do not save a skill.')).toBe(true);
    expect(excludesSkillLearning('Learn this as a skill.')).toBe(false);
  });
});
