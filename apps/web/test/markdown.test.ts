import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, safeHref, splitTableRow } from '../src/chat/markdownParser';

/** Cell text per row, for compact table assertions. */
const cellTexts = (rows: ReturnType<typeof parseInline>[][]) => rows.map(row => row.map(inlineText));

describe('markdown parser', () => {
  it('nests indented lists and code under their item instead of flattening them', () => {
    const [list] = parseMarkdown('- One\n  - Inner\n    1. Deep\n- Two\n\n  Second paragraph\n\n  ```ts\n  const a = 1;\n\n  const b = 2;\n  ```\n- Three');
    expect(list).toMatchObject({ type: 'list', ordered: false });
    if (list?.type !== 'list') throw new Error('expected a list');
    expect(list.items.map(inlineText)).toEqual(['One', 'Two', 'Three']);
    expect(list.nested?.[0]?.[0]).toMatchObject({ type: 'list', nested: [[{ type: 'list', ordered: true }]] });
    expect(list.nested?.[1]?.map(block => block.type)).toEqual(['paragraph', 'code']);
    expect(list.nested?.[1]?.[1]).toMatchObject({ text: 'const a = 1;\n\nconst b = 2;' });
    expect(list.nested?.[2]).toBeUndefined();
  });

  it('keeps flat lists as they were', () => {
    expect(parseMarkdown('- a\n- b\n\n- c\n  continued')).toEqual([{ type: 'list', ordered: false, start: 1, items: [
      [{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }], [{ type: 'text', text: 'c' }, { type: 'break' }, { type: 'text', text: 'continued' }],
    ] }]);
  });

  it('reads task boxes, strikethrough and rich quotes', () => {
    const [tasks] = parseMarkdown('- [x] Done\n- [ ] Open\n- Plain');
    expect(tasks).toMatchObject({ checks: [true, false, undefined] });
    if (tasks?.type !== 'list') throw new Error('expected a list');
    expect(tasks.items.map(inlineText)).toEqual(['Done', 'Open', 'Plain']);
    expect(parseInline('a ~~gone~~ b ~~ c ~ d')).toEqual([{ type: 'text', text: 'a ' }, { type: 'del', children: [{ type: 'text', text: 'gone' }] }, { type: 'text', text: ' b ~~ c ~ d' }]);
    expect(parseMarkdown('> Note\n>\n> - one')[0]).toMatchObject({ type: 'quote', blocks: [{ type: 'paragraph' }, { type: 'list' }] });
    expect(parseMarkdown('> Plain quote')[0]).not.toHaveProperty('blocks');
  });

  it('offers local file references only in a file-preview-enabled context', () => {
    const text = '[source](/projects/example/src/main.ts:12) and [spaces](</projects/example/My notes.md>)';
    expect(parseMarkdown(text)[0]).toMatchObject({ children: [{ type: 'text', text: 'source' }, { type: 'text', text: ' and ' }, { type: 'text', text: 'spaces' }] });
    expect(parseMarkdown(text, { fileLinks: true })[0]).toMatchObject({ children: [
      { type: 'filelink', path: '/projects/example/src/main.ts:12' }, { type: 'text', text: ' and ' }, { type: 'filelink', path: '/projects/example/My notes.md' },
    ] });
    for (const target of ['javascript:alert', 'file:///etc/example', 'data:text/plain,test', 'custom:command']) {
      expect(JSON.stringify(parseMarkdown(`[label](${target})`, { fileLinks: true }))).not.toContain('filelink');
    }
    expect(parseMarkdown('`[literal](README.md)`', { fileLinks: true })[0]).toMatchObject({ children: [{ type: 'code', text: '[literal](README.md)' }] });
  });
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

describe('markdown tables', () => {
  it('parses a header, a delimiter row with alignments and body rows', () => {
    const [table] = parseMarkdown('| Name | Qty | Price |\n| :--- | :---: | ---: |\n| Apple | 3 | 1.20 |\n| Pear | 10 | 0.80 |');
    expect(table).toMatchObject({ type: 'table', align: ['left', 'center', 'right'] });
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(cellTexts([table.header])).toEqual([['Name', 'Qty', 'Price']]);
    expect(cellTexts(table.rows)).toEqual([['Apple', '3', '1.20'], ['Pear', '10', '0.80']]);
  });

  it('accepts tables without outer pipes and without spaces', () => {
    const [table] = parseMarkdown('a | b\n--|--:\n1 | 2');
    expect(table).toMatchObject({ type: 'table', align: [null, 'right'] });
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(cellTexts(table.rows)).toEqual([['1', '2']]);
  });

  it('keeps escaped pipes inside their cell, in text and in code spans', () => {
    const [table] = parseMarkdown('| expr | note |\n| --- | --- |\n| `a\\|b` | x \\| y |');
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.rows[0]![0]).toEqual([{ type: 'code', text: 'a|b' }]);
    expect(cellTexts(table.rows)).toEqual([['a|b', 'x | y']]);
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('pads short rows with empty cells and cuts long rows, as GFM does', () => {
    const [table] = parseMarkdown('| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |');
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(cellTexts(table.rows)).toEqual([['1', '', ''], ['1', '2', '3']]);
  });

  it('starts a table directly after a paragraph line', () => {
    const blocks = parseMarkdown('Here are the numbers:\n| k | v |\n| --- | ---: |\n| x | 1 |\n\nAfter.');
    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(blocks[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Here are the numbers:' }] });
    if (blocks[1]?.type !== 'table') throw new Error('expected a table');
    expect(cellTexts(blocks[1].rows)).toEqual([['x', '1']]);
  });

  it('ends the table at a blank line or at the next block', () => {
    const blocks = parseMarkdown('| a |\n| - |\n| 1 |\n# Heading\n| not | table |');
    expect(blocks.map(block => block.type)).toEqual(['table', 'heading', 'paragraph']);
    if (blocks[0]?.type !== 'table') throw new Error('expected a table');
    expect(cellTexts(blocks[0].rows)).toEqual([['1']]);
  });

  it('renders inline formatting inside cells and keeps HTML as text', () => {
    const [table] = parseMarkdown('| **bold** | [docs](https://example.com) | <img src=x onerror=alert(1)> |\n| --- | --- | --- |\n| *em* | `code` | ok |');
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.header[0]).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'bold' }] }]);
    expect(table.header[1]).toEqual([{ type: 'link', href: 'https://example.com/', children: [{ type: 'text', text: 'docs' }] }]);
    expect(inlineText(table.header[2]!)).toBe('<img src=x onerror=alert(1)>');
    expect(table.rows[0]![1]).toEqual([{ type: 'code', text: 'code' }]);
  });

  it('never reads pipes inside fenced code as a table', () => {
    expect(parseMarkdown('```\n| a | b |\n| --- | --- |\n```')).toEqual([{ type: 'code', text: '| a | b |\n| --- | --- |' }]);
  });

  it('is not a table without a matching delimiter row', () => {
    expect(parseMarkdown('| a | b |\n| --- |').map(block => block.type)).toEqual(['paragraph']);
    expect(parseMarkdown('| a | b |\n| - | x |').map(block => block.type)).toEqual(['paragraph']);
    expect(parseMarkdown('| a | b |\n| - | :-x: |').map(block => block.type)).toEqual(['paragraph']);
    expect(parseMarkdown('| a | b |\n| a | b |').map(block => block.type)).toEqual(['paragraph']);
    expect(parseMarkdown('just a | pipe in a sentence').map(block => block.type)).toEqual(['paragraph']);
    expect(parseMarkdown('Total\n---').map(block => block.type)).toEqual(['paragraph', 'rule']);
  });
});
