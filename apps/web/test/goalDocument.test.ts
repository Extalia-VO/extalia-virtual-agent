import { describe, expect, it } from 'vitest';
import { extendGoalDocument, goalDocumentFromText, goalReference } from '../src/goals/goalDocument';

describe('retained goal text imports', () => {
  it('retains both complete imports when more text is pasted after the first file', () => {
    const first = 'First requirements 🌟\n'.repeat(500);
    const second = 'Additional requirements\n'.repeat(500);
    const document = goalDocumentFromText(first)!;
    const combined = extendGoalDocument(document, second);
    expect(combined).toBe(`${first}\n\n${second}`);
    expect(goalDocumentFromText(combined)?.text).toBe(combined);
    expect(goalReference(document.name)).toContain(document.name);
  });
  it('refuses an oversized combined document without modifying either source', () => {
    const first = { name: 'goal.txt', text: 'x'.repeat(150000) };
    const second = 'y'.repeat(100000);
    const full = extendGoalDocument(first, second);
    expect(goalDocumentFromText(full)).toBeUndefined();
    expect(full).toContain(first.text);
    expect(full.endsWith(second)).toBe(true);
  });
});
