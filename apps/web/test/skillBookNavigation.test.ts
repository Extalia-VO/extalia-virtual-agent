import { describe, expect, it } from 'vitest';
import { paginateBookText, type SkillBookPage } from '../src/skills/skillBookMotion';
import { bookContents, bookPageIndex, searchBookPages } from '../src/skills/skillBookNavigation';

const pagesOf = (...texts: string[]): SkillBookPage[] => texts.map(text => ({ text, lines: [] }));

describe('literal book contents', () => {
  it('maps complete ATX/Setext source headings to their original pages across visual pagination', () => {
    const pages = pagesOf('intro\r\n  # L', 'iteral 🌺 title ###\r\n\r\nSetext ', 'title\r', '\n===\r\n\r\n###### Last\n');
    expect(bookContents(pages)).toEqual({
      entries: [
        { title: 'Literal 🌺 title', page: 0, level: 1 },
        { title: 'Setext title', page: 1, level: 1 },
        { title: 'Last', page: 3, level: 6 },
      ], total: 3, truncated: false,
    });
    const text = '🌺 prefix\n\n## A heading split over visual pages\n\nParagraph\n';
    const wrapped = paginateBookText(text, 7, 1);
    const headingStart = text.indexOf('##');
    let offset = 0;
    const expected = wrapped.findIndex(page => { const start = offset; offset += page.text.length; return headingStart >= start && headingStart < offset; });
    expect(bookContents(wrapped).entries).toEqual([{ title: 'A heading split over visual pages', page: expected, level: 2 }]);
  });

  it('keeps fence state across pages, requires a matching closing fence and excludes indented code', () => {
    const pages = pagesOf('````ts\n# hidden\n```\n', '## still hidden\n~~~\n````\n', '# Real\n\n~~~text\nSetext fake\n---\n', '~~~~\n    # indented\n \t## tab indented\n\tFake\n\t===\n### Visible\n');
    expect(bookContents(pages).entries).toEqual([
      { title: 'Real', page: 2, level: 1 }, { title: 'Visible', page: 3, level: 3 },
    ]);
  });

  it('indexes Setext paragraphs while rejecting rules, list/quote markers and invalid ATX headings', () => {
    const source = '---\n\n- List item\n---\n\n> Quote\n===\n\n#No space\n####### Too many\n\n***\n---\n\nTwo-line\nheading\n---\n\n# Keep trailing#\n# <script>alert(1)</script> [link](javascript:evil)\n';
    expect(bookContents(pagesOf(source)).entries).toEqual([
      { title: 'Two-line heading', page: 0, level: 2 },
      { title: 'Keep trailing#', page: 0, level: 1 },
      { title: '<script>alert(1)</script> [link](javascript:evil)', page: 0, level: 1 },
    ]);
  });

  it('bounds entries while reporting the true heading count, without changing source pages', () => {
    const pages = pagesOf(Array.from({ length: 112 }, (_, index) => `# Heading ${index}\n`).join(''));
    const source = pages[0]!.text;
    const result = bookContents(pages);
    expect(result.entries).toHaveLength(100); expect(result.total).toBe(112); expect(result.truncated).toBe(true);
    expect(result.entries[99]!.title).toBe('Heading 99'); expect(pages[0]!.text).toBe(source);
    expect(bookContents([])).toEqual({ entries: [], total: 0, truncated: false });
  });
});

describe('literal in-book search', () => {
  it('uses literal Unicode caseless matches and original snippets even when folding expands a letter', () => {
    const pages = pagesOf('🌺 '.repeat(60) + 'İSTANBUL Straße Σίσυφος Kelvin [a.*] <b>literal</b> ' + '🌷'.repeat(60));
    const city = searchBookPages(pages, 'istanbul');
    // Unicode default casing keeps the dotted i distinct from an unmarked i.
    expect(city.total).toBe(0);
    for (const [query, original] of [['i\u0307stanbul', 'İSTANBUL'], ['STRASSE', 'Straße'], ['σίσυφοσ', 'Σίσυφος'], ['kelvin', 'Kelvin'], ['[a.*]', '[a.*]'], ['<B>LITERAL</B>', '<b>literal</b>']] as const) {
      const result = searchBookPages(pages, query);
      expect(result.total).toBe(1); expect(result.matches[0]?.snippet).toContain(original);
      expect(result.matches[0]?.snippet).not.toContain('\ufffd');
      expect(result.matches[0]?.snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
  });

  it('finds a phrase crossing source pages and returns each matching start page only once', () => {
    const result = searchBookPages(pagesOf('preface 🌺 hello ', 'WORLD hello world', '', ' HELLO WORLD'), 'hello world');
    expect(result.total).toBe(3);
    expect(result.matches.map(match => match.page)).toEqual([0, 1, 3]);
    expect(result.matches[0]?.snippet).toContain('hello WORLD');
    expect(searchBookPages(pagesOf('repeated repeated repeated'), 'repeated').total).toBe(1);
  });

  it('reports empty/no-result states and caps result pages without hiding the full count', () => {
    for (const query of ['', '   \n\t', 'unmatched']) expect(searchBookPages(pagesOf('example'), query)).toEqual({ matches: [], total: 0, truncated: false });
    const result = searchBookPages(pagesOf(...Array.from({ length: 63 }, () => 'a needle in each page\n')), 'NEEDLE');
    expect(result.matches).toHaveLength(50); expect(result.total).toBe(63); expect(result.truncated).toBe(true);
    expect(result.matches[49]!.page).toBe(49);
  });

  it('bounds a query by Unicode characters and clips context without splitting emoji or changing the source', () => {
    const source = '🌺'.repeat(80) + 'z'.repeat(200) + '🌷'.repeat(80);
    const pages = pagesOf(source);
    const result = searchBookPages(pages, 'z'.repeat(200) + 'not included');
    expect(result.total).toBe(1); expect(result.matches[0]!.snippet).toBe('…' + '🌺'.repeat(36) + 'z'.repeat(200) + '🌷'.repeat(36) + '…');
    expect(searchBookPages(pagesOf('🌺'.repeat(200)), '🌺'.repeat(201)).total).toBe(1);
    expect(pages[0]!.text).toBe(source);
  });
});

describe('book spread navigation', () => {
  it('clamps to actual pages and aligns desktop spreads without changing compact page selection', () => {
    expect(bookPageIndex(5, 6, false)).toBe(4); expect(bookPageIndex(5, 6, true)).toBe(5);
    expect(bookPageIndex(99, 5, false)).toBe(4); expect(bookPageIndex(99, 5, true)).toBe(4);
    expect(bookPageIndex(3.9, 6, false)).toBe(2); expect(bookPageIndex(3.9, 6, true)).toBe(3);
    expect(bookPageIndex(-1, 6, true)).toBe(0); expect(bookPageIndex(2, 0, true)).toBe(0);
  });

  it('returns finite first-page indices for invalid page/count inputs', () => {
    for (const page of [NaN, Infinity, -Infinity]) expect(bookPageIndex(page, 8, false)).toBe(0);
    for (const count of [NaN, Infinity, -Infinity, -3, 0]) {
      expect(bookPageIndex(8, count, true)).toBe(0); expect(bookPageIndex(8, count, false)).toBe(0);
    }
  });
});
