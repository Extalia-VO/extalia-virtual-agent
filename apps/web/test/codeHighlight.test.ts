import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/chat/codeHighlight';

const join = (code: string, language?: string) => highlightCode(code, language).map(token => token.text).join('');
const kinds = (code: string, language: string) => Object.fromEntries(highlightCode(code, language).filter(token => token.kind).map(token => [token.text, token.kind]));

describe('code highlighting', () => {
  it('always gives the source back unchanged', () => {
    const code = 'const a = "x"; // note\n<script>alert(1)</script>\n`${a}`';
    for (const language of ['ts', 'python', 'bash', 'rust', 'go', 'c', 'sql', 'json', 'yaml', 'diff', 'unknown', undefined]) expect(join(code, language)).toBe(code);
  });

  it('marks keywords, strings, comments and numbers', () => {
    expect(kinds('const a = "x"; // note\nreturn 12', 'ts')).toEqual({ const: 'keyword', '"x"': 'string', '// note': 'comment', return: 'keyword', 12: 'number' });
    expect(kinds('def run():  # go\n  return None', 'py')).toMatchObject({ def: 'keyword', '# go': 'comment', None: 'keyword' });
    expect(kinds('SELECT id FROM users', 'sql')).toEqual({ SELECT: 'keyword', FROM: 'keyword' });
  });

  it('does not colour keywords inside strings or comments', () => {
    expect(kinds('"return" // const', 'ts')).toEqual({ '"return"': 'string', '// const': 'comment' });
  });

  it('colours diffs by line and leaves unknown languages and huge code plain', () => {
    expect(highlightCode('@@ -1 +1 @@\n-a\n+b\n c', 'diff').map(token => token.kind)).toEqual(['meta', 'removed', 'added', undefined]);
    expect(highlightCode('const a = 1', 'brainfuck')).toEqual([{ text: 'const a = 1' }]);
    const huge = 'const a = 1;\n'.repeat(5000);
    expect(highlightCode(huge, 'ts')).toEqual([{ text: huge }]);
  });
});
