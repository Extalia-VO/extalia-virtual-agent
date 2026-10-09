/**
 * A small, safe Markdown subset for assistant replies: paragraphs, headings,
 * lists, quotes, rules, fenced code, inline code, bold, italic and links.
 * The parser builds a plain tree; the renderer turns it into React elements,
 * so raw HTML in a reply is always shown as text and never interpreted.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'rule' };

/** Only absolute http(s) links survive; everything else (javascript:, data:, relative) is dropped. */
export function safeHref(raw: string): string | undefined {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BLANK = /^\s*$/;

const isOrdered = (match: RegExpExecArray) => /\d/.test(match[1]!);
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line);

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (BLANK.test(line)) { index++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body: string[] = [];
      index++;
      // An unterminated fence (a reply still streaming) runs to the end.
      while (index < lines.length && !closing.test(lines[index]!)) body.push(lines[index++]!);
      index++;
      blocks.push({ type: 'code', text: body.join('\n'), ...(fence[2] ? { language: fence[2] } : {}) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]!) });
      index++;
      continue;
    }

    if (RULE.test(line)) { blocks.push({ type: 'rule' }); index++; continue; }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = isOrdered(item);
      const start = ordered ? Number.parseInt(item[1]!, 10) : 1;
      const entries: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const next = ITEM.exec(current);
        if (next) {
          if (isOrdered(next) !== ordered) break;
          entries.push(next[2]!);
          index++;
          continue;
        }
        if (BLANK.test(current)) {
          // Blank lines between items of the same list keep it going; anything else ends it.
          let ahead = index + 1;
          while (ahead < lines.length && BLANK.test(lines[ahead]!)) ahead++;
          const following = ahead < lines.length ? ITEM.exec(lines[ahead]!) : null;
          if (!following || isOrdered(following) !== ordered) break;
          index = ahead;
          continue;
        }
        if (startsBlock(current) && !/^[ \t]+\S/.test(current)) break;
        // Continuation line of the previous item.
        entries[entries.length - 1] += `\n${current.trim()}`;
        index++;
      }
      blocks.push({ type: 'list', ordered, start, items: entries.map(entry => parseInline(entry)) });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) quoted.push(QUOTE.exec(lines[index++]!)![1]!);
      blocks.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !BLANK.test(lines[index]!) && !(paragraph.length && startsBlock(lines[index]!))) paragraph.push(lines[index++]!.trim());
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

const WORD = /[\p{L}\p{N}]/u;
const URL_START = /^https?:\/\/[^\s<>]+/i;
const MAX_DEPTH = 4;

export function parseInline(text: string, depth = 0): Inline[] {
  const result: Inline[] = [];
  let buffer = '';
  // Delimiters known to have no closer after a position; avoids rescanning on long unmatched input.
  const noCloser = new Map<string, number>();
  const flush = () => { if (buffer) { result.push({ type: 'text', text: buffer }); buffer = ''; } };
  const findCloser = (delimiter: string, from: number, valid: (at: number) => boolean): number => {
    const known = noCloser.get(delimiter);
    if (known !== undefined && from >= known) return -1;
    let at = text.indexOf(delimiter, from);
    while (at !== -1 && !valid(at)) at = text.indexOf(delimiter, at + 1);
    if (at === -1) noCloser.set(delimiter, Math.min(known ?? from, from));
    return at;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const previous = index > 0 ? text[index - 1]! : '';

    if (char === '\\' && index + 1 < text.length && /[\\`*_[\]()#+\-.!>~|]/.test(text[index + 1]!)) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === '\n') { flush(); result.push({ type: 'break' }); index++; continue; }

    if (char === '`') {
      let run = 1;
      while (text[index + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = findCloser(fence, index + run, at => text[at - 1] !== '`' && text[at + run] !== '`');
      if (close !== -1) {
        flush();
        const code = text.slice(index + run, close);
        result.push({ type: 'code', text: code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code });
        index = close + run;
        continue;
      }
      buffer += fence;
      index += run;
      continue;
    }

    if (char === '[' && depth < MAX_DEPTH) {
      const match = /^\[((?:[^[\]\\]|\\.)*)\]\(\s*([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(index));
      if (match) {
        flush();
        const children = parseInline(match[1]!, depth + 1).filter(child => child.type !== 'link');
        const href = safeHref(match[2]!);
        // Unsafe targets keep their label as plain text.
        if (href) result.push({ type: 'link', href, children });
        else result.push(...children);
        index += match[0].length;
        continue;
      }
    }

    if ((char === 'h' || char === 'H') && (!previous || /[\s(]/.test(previous))) {
      const match = URL_START.exec(text.slice(index));
      if (match) {
        const url = match[0].replace(/[.,;:!?'")\]]+$/, '');
        const href = safeHref(url);
        if (href) {
          flush();
          result.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
          index += url.length;
          continue;
        }
      }
    }

    if ((char === '*' || char === '_') && depth < MAX_DEPTH) {
      const strong = text[index + 1] === char;
      const delimiter = strong ? char + char : char;
      const after = text[index + delimiter.length] ?? '';
      // `_` inside words (snake_case) is literal; openers must touch the text they wrap.
      const canOpen = after && !/\s/.test(after) && after !== char && !(char === '_' && WORD.test(previous));
      if (canOpen) {
        const close = findCloser(delimiter, index + delimiter.length + 1, at => {
          const before = text[at - 1]!;
          const next = text[at + delimiter.length] ?? '';
          if (/\s/.test(before) || next === char) return false;
          return !(char === '_' && WORD.test(next));
        });
        if (close !== -1) {
          flush();
          const children = parseInline(text.slice(index + delimiter.length, close), depth + 1);
          result.push(strong ? { type: 'strong', children } : { type: 'em', children });
          index = close + delimiter.length;
          continue;
        }
      }
      buffer += delimiter;
      index += delimiter.length;
      continue;
    }

    buffer += char;
    index++;
  }
  flush();
  return result;
}

/** Plain text of inline content, for labels and tests. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : node.type === 'break' ? '\n' : inlineText(node.children)).join('');
}
