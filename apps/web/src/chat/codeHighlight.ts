/** Light syntax colouring for code blocks: a linear scan with no markup in the source, so nothing is interpreted. */
export type CodeTokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'added' | 'removed' | 'meta';
export interface CodeToken { text: string; kind?: CodeTokenKind }

const MAX_CODE = 48 * 1024;
const STRINGS = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const SLASH_COMMENTS = String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`;
const HASH_COMMENTS = String.raw`#[^\n]*`;
const WORDS = {
  script: 'as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield',
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  shell: 'case do done elif else esac export fi for function if in local return then until while cd echo git npm npx pnpm sudo',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  go: 'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
  c: 'auto bool break case catch char class const continue default delete do double else enum extern false float for goto if int long namespace new nullptr private protected public return short signed sizeof static struct switch template this throw true try typedef union unsigned using virtual void volatile while',
  sql: 'add all alter and as asc between by case create delete desc distinct drop else end exists from group having in index insert inner into is join key left like limit not null on or order outer primary references right select set table then union unique update values when where',
} as const;

interface Grammar { pattern: RegExp; groups: readonly CodeTokenKind[] }
const grammar = (comments: string, strings: string, words: string, flags = 'g'): Grammar => ({
  pattern: new RegExp(`(${comments})|(${strings})|(\\b(?:${words.split(' ').join('|')})\\b)|(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)`, flags),
  groups: ['comment', 'string', 'keyword', 'number'],
});
const SCRIPT = grammar(SLASH_COMMENTS, `${STRINGS}|\`(?:\\\\.|[^\`\\\\])*\``, WORDS.script);
const PYTHON = grammar(HASH_COMMENTS, `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${STRINGS}`, WORDS.python);
const SHELL = grammar(`(?<![\\w$])${HASH_COMMENTS}`, STRINGS, WORDS.shell);
const RUST = grammar(SLASH_COMMENTS, String.raw`"(?:\\.|[^"\\])*"`, WORDS.rust);
const GO = grammar(SLASH_COMMENTS, `${STRINGS}|\`[^\`]*\``, WORDS.go);
const C = grammar(SLASH_COMMENTS, STRINGS, WORDS.c);
const SQL = grammar('--[^\\n]*', STRINGS, WORDS.sql, 'gi');
const JSON_LIKE = grammar('(?!)', STRINGS, 'true false null');
const YAML = grammar(HASH_COMMENTS, STRINGS, 'true false null yes no');
const GRAMMARS: Record<string, Grammar> = {
  js: SCRIPT, jsx: SCRIPT, ts: SCRIPT, tsx: SCRIPT, javascript: SCRIPT, typescript: SCRIPT, mjs: SCRIPT,
  py: PYTHON, python: PYTHON,
  sh: SHELL, bash: SHELL, zsh: SHELL, shell: SHELL, console: SHELL,
  rs: RUST, rust: RUST, go: GO, golang: GO,
  c: C, h: C, cpp: C, 'c++': C, java: C, csharp: C, cs: C, swift: C, kotlin: C,
  sql: SQL, json: JSON_LIKE, jsonc: JSON_LIKE, yaml: YAML, yml: YAML, toml: YAML,
};

function highlightDiff(code: string): CodeToken[] {
  return code.split(/(?<=\n)/).map(line => ({
    text: line,
    ...(/^(?:\+\+\+|---|@@|diff |index )/.test(line) ? { kind: 'meta' as const } : line.startsWith('+') ? { kind: 'added' as const } : line.startsWith('-') ? { kind: 'removed' as const } : {}),
  }));
}

/** Concatenating the tokens always gives the input back. Unknown languages and very long code stay plain. */
export function highlightCode(code: string, language?: string): CodeToken[] {
  const name = language?.toLowerCase() ?? '';
  if (code.length > MAX_CODE) return [{ text: code }];
  if (name === 'diff' || name === 'patch') return highlightDiff(code);
  const rules = GRAMMARS[name];
  if (!rules) return [{ text: code }];
  const tokens: CodeToken[] = [];
  let cursor = 0;
  for (const match of code.matchAll(rules.pattern)) {
    if (match.index > cursor) tokens.push({ text: code.slice(cursor, match.index) });
    const group = rules.groups.findIndex((_, index) => match[index + 1] !== undefined);
    tokens.push({ text: match[0], ...(group >= 0 ? { kind: rules.groups[group]! } : {}) });
    cursor = match.index + match[0].length;
  }
  if (cursor < code.length) tokens.push({ text: code.slice(cursor) });
  return tokens;
}
