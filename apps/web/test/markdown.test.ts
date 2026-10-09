import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, safeHref } from '../src/chat/markdownParser';

describe('markdown parser', () => {
  it('parses headings, lists, quotes, rules and fenced code', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** and *em* with `code`.\n\n- one\n- two\n\n3. three\n4. four\n\n> quoted\n\n---\n\n```ts\nconst a = 1;\n```');
    expect(blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'code']);
    expect(blocks[1]).toMatchObject({ children: [{ type: 'text', text: 'Some ' }, { type: 'strong' }, { type: 'text', text: ' and ' }, { type: 'em' }, { type: 'text', text: ' with ' }, { type: 'code', text: 'code' }, { type: 'text', text: '.' }] });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[6]).toEqual({ type: 'code', language: 'ts', text: 'const a = 1;' });
  });

  it('keeps an unterminated fence (still streaming) as code', () => {
    expect(parseMarkdown('Look:\n```js\nlet x')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Look:' }] },
      { type: 'code', language: 'js', text: 'let x' },
    ]);
  });

  it('never produces HTML: tags stay text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script> <img src=x onerror=alert(1)>' }] }]);
  });

  it('allows only http and https links', () => {
    expect(parseInline('[docs](https://example.com/a)')).toEqual([{ type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'docs' }] }]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', text: 'click' }]);
    expect(parseInline('[x](data:text/html,hi) [y](/relative)').some(node => node.type === 'link')).toBe(false);
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(safeHref(' http://example.com ')).toBe('http://example.com/');
  });

  it('links bare URLs without trailing punctuation and leaves snake_case alone', () => {
    const nodes = parseInline('See https://example.com/x. and snake_case_name');
    expect(nodes[1]).toEqual({ type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'https://example.com/x' }] });
    expect(inlineText(nodes)).toBe('See https://example.com/x. and snake_case_name');
  });

  it('handles escapes, line breaks and unmatched delimiters', () => {
    expect(inlineText(parseInline('\\*not em\\* and 2 * 3 * 4'))).toBe('*not em* and 2 * 3 * 4');
    expect(parseInline('a\nb')).toEqual([{ type: 'text', text: 'a' }, { type: 'break' }, { type: 'text', text: 'b' }]);
    expect(inlineText(parseInline('**'.repeat(2000)))).toBe('**'.repeat(2000));
  });
});
