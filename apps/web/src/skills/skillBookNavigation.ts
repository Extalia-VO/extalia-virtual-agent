import type { SkillBookPage } from './skillBookMotion';

export interface BookContentsEntry { title: string; page: number; level: number }
export interface BookContents { entries: BookContentsEntry[]; total: number; truncated: boolean }
export interface BookSearchMatch { page: number; snippet: string }
export interface BookSearchResults { matches: BookSearchMatch[]; total: number; truncated: boolean }

export const BOOK_CONTENTS_LIMIT = 100;
export const BOOK_SEARCH_LIMIT = 50;
export const BOOK_SEARCH_QUERY_LIMIT = 200;

/** Invalid inputs resolve to the first page; a desktop spread always starts on an even index. */
export function bookPageIndex(page: number, count: number, compact: boolean): number {
  const length = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const requested = Number.isFinite(page) ? Math.floor(page) : 0;
  const index = Math.max(0, Math.min(Math.max(0, length - 1), requested));
  return compact ? index : index - index % 2;
}

function documentPages(pages: readonly SkillBookPage[]) {
  const offsets: number[] = []; let offset = 0;
  for (const page of pages) { offsets.push(offset); offset += page.text.length; }
  return { text: pages.map(page => page.text).join(''), offsets };
}

function pageAt(offsets: readonly number[], position: number): number {
  let low = 0, high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle]! <= position) low = middle + 1; else high = middle;
  }
  return Math.max(0, low - 1);
}

function* sourceLines(text: string) {
  let start = 0;
  for (const newline of text.matchAll(/\r\n|\r|\n/gu)) {
    yield { text: text.slice(start, newline.index), start };
    start = newline.index + newline[0].length;
  }
  if (start < text.length) yield { text: text.slice(start), start };
}

function indentedCode(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === ' ') columns++;
    else if (character === '\t') columns += 4 - columns % 4;
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

/**
 * A text-only heading index over the original source, not its visually wrapped lines.
 * Fences and indentation carry across page boundaries. Titles remain literal display
 * strings: inline Markdown/HTML is never interpreted or made into executable links.
 */
export function bookContents(pages: readonly SkillBookPage[]): BookContents {
  const { text, offsets } = documentPages(pages);
  const entries: BookContentsEntry[] = []; let total = 0;
  let fence: { character: string; length: number } | undefined;
  let paragraph: { lines: string[]; start: number } | undefined;
  const add = (title: string, start: number, level: number) => {
    if (!title) return;
    total++;
    if (entries.length < BOOK_CONTENTS_LIMIT) entries.push({ title, page: pageAt(offsets, start), level });
  };
  for (const line of sourceLines(text)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.text);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && /^[ \t]*$/u.test(marker[2]!)) fence = undefined;
      paragraph = undefined; continue;
    }
    if (marker && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }; paragraph = undefined; continue;
    }
    if (!line.text.trim() || indentedCode(line.text)) { paragraph = undefined; continue; }
    const heading = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u.exec(line.text);
    if (heading) {
      const title = (heading[3] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/u, '').trim();
      add(title, line.start + heading[1]!.length, heading[2]!.length); paragraph = undefined; continue;
    }
    const underline = /^ {0,3}(=+|-+)[ \t]*$/u.exec(line.text);
    if (underline) {
      if (paragraph) add(paragraph.lines.join(' '), paragraph.start, underline[1]![0] === '=' ? 1 : 2);
      paragraph = undefined; continue;
    }
    // A block boundary cannot become a Setext title merely because a rule follows it.
    if (/^ {0,3}(?:>|(?:[-+*]|\d+[.)])[ \t]+|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:-[ \t]*){3,}$)/u.test(line.text)) { paragraph = undefined; continue; }
    const title = line.text.trim();
    if (paragraph) paragraph.lines.push(title);
    else paragraph = { lines: [title], start: line.start + line.text.indexOf(title) };
  }
  return { entries, total, truncated: total > entries.length };
}

// Character-wise Unicode folding keeps an explicit map back to the source even
// when a letter expands (İ, ß, ligatures) or a supplementary character uses 2 units.
function foldCharacter(character: string): string {
  return character === '\u0131' ? character : character.toUpperCase().toLowerCase();
}

function boundedQuery(query: string): string {
  let result = '', count = 0;
  for (const character of query) {
    if (count++ >= BOOK_SEARCH_QUERY_LIMIT) break;
    result += character;
  }
  return result;
}

function snippet(text: string, start: number, end: number): string {
  let from = start, to = end;
  for (let count = 0; count < 36 && from > 0; count++) {
    from--;
    const unit = text.charCodeAt(from);
    const previous = text.charCodeAt(from - 1);
    if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) from--;
  }
  for (let count = 0; count < 36 && to < text.length; count++) {
    const unit = text.charCodeAt(to++);
    const next = text.charCodeAt(to);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) to++;
  }
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/** Literal caseless search; one result per page where a match starts, including page-spanning matches. */
export function searchBookPages(pages: readonly SkillBookPage[], query: string): BookSearchResults {
  const matches: BookSearchMatch[] = [];
  const bounded = boundedQuery(query);
  if (!bounded.trim()) return { matches, total: 0, truncated: false };
  const needle = Array.from(bounded, foldCharacter).join('');
  const { text, offsets } = documentPages(pages);
  const folded: string[] = [], starts: number[] = [], ends: number[] = [];
  let position = 0;
  for (const character of text) {
    const value = foldCharacter(character); folded.push(value);
    for (let unit = 0; unit < value.length; unit++) { starts.push(position); ends.push(position + character.length); }
    position += character.length;
  }
  const haystack = folded.join('');
  let lastPage = -1, total = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    const start = starts[index]!, end = ends[index + needle.length - 1]!;
    const page = pageAt(offsets, start);
    if (lastPage === page) continue;
    lastPage = page; total++;
    if (matches.length < BOOK_SEARCH_LIMIT) matches.push({ page, snippet: snippet(text, start, end) });
  }
  return { matches, total, truncated: total > matches.length };
}
