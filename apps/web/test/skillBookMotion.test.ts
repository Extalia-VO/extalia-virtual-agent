import { describe, expect, it } from 'vitest';
import { paginateBookText, SkillBookMotion } from '../src/skills/skillBookMotion';

function settle(motion: SkillBookMotion) { motion.advance(10_000); }

describe('in-place book motion', () => {
  it('pulls before opening and closes before returning to the shelf', () => {
    const book = new SkillBookMotion(); book.request('first');
    book.advance(240); expect(book.lift).toBeCloseTo(.5); expect(book.open).toBe(0);
    book.advance(240); expect(book.lift).toBe(1); expect(book.phase).toBe('opening');
    book.advance(290); expect(book.open).toBeCloseTo(.5);
    settle(book); expect(book.phase).toBe('reading');
    book.request(null); book.advance(210);
    expect(book.open).toBeCloseTo(.5); expect(book.lift).toBe(1);
    book.advance(210); expect(book.phase).toBe('returning'); expect(book.open).toBe(0);
    settle(book); expect(book.activeId).toBeNull(); expect(book.lift).toBe(0); expect(book.animating).toBe(false);
  });
  it('returns the old volume continuously before pulling a rapidly selected replacement', () => {
    const book = new SkillBookMotion(); book.request('first'); book.advance(240);
    book.request('second'); expect(book.lift).toBeCloseTo(.5);
    book.request('third'); expect(book.activeId).toBe('first');
    book.advance(230); expect(book.lift).toBeCloseTo(.25);
    settle(book); expect(book.activeId).toBe('third'); expect(book.phase).toBe('reading');
  });
  it('completes a turning leaf before closing and ignores intermediate retargets', () => {
    const book = new SkillBookMotion(); book.request('first'); settle(book);
    book.request('first', 2); book.advance(310);
    expect(book.turn).toBeCloseTo(.5); expect(book.fromPage).toBe(0); expect(book.toPage).toBe(2);
    book.request('second'); book.request('third');
    expect(book.phase).toBe('turning');
    book.advance(310); expect(book.phase).toBe('closing'); expect(book.page).toBe(2);
    settle(book); expect(book.activeId).toBe('third'); expect(book.page).toBe(0);
  });
  it('has the same pose at different frame rates and settles reduced motion immediately', () => {
    const slow = new SkillBookMotion(), fast = new SkillBookMotion(); slow.request('a'); fast.request('a');
    for (let frame = 0; frame < 30; frame++) slow.advance(20);
    for (let frame = 0; frame < 60; frame++) fast.advance(10);
    expect(fast.open).toBeCloseTo(slow.open); expect(fast.lift).toBe(slow.lift);
    fast.advance(0, true); expect(fast.phase).toBe('reading'); expect(fast.animating).toBe(false);
    fast.request('a', 2); fast.advance(0, true); expect(fast.page).toBe(2);
    fast.request(null); fast.advance(0, true); expect(fast.phase).toBe('shelf');
  });
});

describe('literal text on book surfaces', () => {
  it('wraps whole words and avoids an extra blank page at the final line boundary', () => {
    expect(paginateBookText('words fit on a page', 10)[0]?.lines).toEqual(['words fit ', 'on a page']);
    expect(paginateBookText('line\n'.repeat(15) + 'last line')).toHaveLength(1);
    const pages = paginateBookText('a'.repeat(21) + '\tb'.repeat(200));
    for (const page of pages) expect(page.lines.join('')).toBe(page.text.replace(/\r?\n/g, '').replace(/\t/g, '  '));
  });

  it('preserves all source characters across bounded pages including emoji, tabs and CRLF', () => {
    const text = '🌺 <script>literal</script>\r\n\t'.repeat(200) + 'z'.repeat(2000);
    const pages = paginateBookText(text);
    expect(pages.map(page => page.text).join('')).toBe(text);
    expect(pages.every(page => page.lines.length <= 16)).toBe(true);
    expect(pages.flatMap(page => page.lines).every(line => !line.includes('\ufffd'))).toBe(true);
    expect(pages.length).toBeGreaterThan(1);
  });
});
