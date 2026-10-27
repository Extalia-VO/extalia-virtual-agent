import type { TeamMember } from '@extalia/core';
import type { AnyTool } from './tools.js';

/**
 * Where a write-capable team member may edit. `scope` lists workspace-relative
 * directories, files or globs (`*` within a segment, `**` across segments);
 * an empty scope is the whole workspace. `forbidden` always wins over scope.
 * Paths are checked as written, before the file tools resolve them: absolute
 * paths, `~` and `..` are refused for members, so a member cannot reach a
 * forbidden file through another spelling. The file tools still enforce the
 * workspace boundary, symbolic links and credential files.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A scope entry as a matcher; a match also covers everything below it. */
function patternMatcher(pattern: string, ignoreCase: boolean): (path: string) => boolean {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!clean || clean === '.' || clean === '**') return () => true;
  let source = '';
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]!;
    if (char === '*') {
      if (clean[index + 1] === '*') {
        index++;
        // "a/**/b" also matches "a/b".
        if (clean[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += escapeRegExp(char);
  }
  const regex = new RegExp(`^${source}(?:/.*)?$`, ignoreCase ? 'i' : '');
  return path => regex.test(path);
}

/** Normalize a member-supplied path: relative, `/` separators, no `.`/`..` segments. Undefined when refused. */
export function memberRelativePath(requested: string): { path?: string; error?: string } {
  if (typeof requested !== 'string' || requested.includes('\0')) return { error: 'The path must be plain text.' };
  const value = requested.trim().replace(/\\/g, '/');
  if (!value) return { error: 'Give a file path.' };
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    return { error: `"${value}" is an absolute path. Team members use paths relative to the workspace root.` };
  }
  const parts = value.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) return { error: `"${value}" uses "..". Team members use plain paths inside the workspace.` };
  if (!parts.length) return { error: 'Give a file path, not the workspace folder.' };
  return { path: parts.join('/') };
}

/** Why `member` may not edit `requested`, or undefined when it may. */
export function memberEditRefusal(member: Pick<TeamMember, 'name' | 'access' | 'scope' | 'forbidden'>, requested: string): string | undefined {
  if (member.access !== 'write') return `${member.name} is a read-only team member and cannot edit files.`;
  const { path, error } = memberRelativePath(requested);
  if (!path) return error;
  // Forbidden paths match case-insensitively: on most macOS and Windows disks `SRC/x` is `src/x`.
  const forbidden = (member.forbidden ?? []).find(pattern => patternMatcher(pattern, true)(path));
  if (forbidden) return `"${path}" is forbidden for ${member.name} (${forbidden}). Leave it unchanged and report what should change there.`;
  const scope = member.scope ?? [];
  if (scope.length && !scope.some(pattern => patternMatcher(pattern, false)(path))) {
    return `"${path}" is outside ${member.name}'s scope (${scope.join(', ')}). Edit only inside the scope, or report the change for the lead.`;
  }
  return undefined;
}

/**
 * The tools a member gets: write tools (those with `access: 'write'` and a
 * `path` argument) refuse paths outside the member's scope or inside its
 * forbidden list with a clear tool error; other tools are unchanged.
 */
export function guardMemberTools(tools: readonly AnyTool[], member: Pick<TeamMember, 'name' | 'access' | 'scope' | 'forbidden'>): AnyTool[] {
  return tools.map(tool => {
    if (tool.access !== 'write') return tool;
    const refusal = (input: unknown): string | undefined => {
      const requested = input && typeof input === 'object' ? (input as { path?: unknown }).path : undefined;
      return typeof requested === 'string' ? memberEditRefusal(member, requested) : 'Give the file path to change.';
    };
    const guarded: AnyTool = {
      ...tool,
      // Refused before any approval is asked, so the user is never asked about an edit that cannot happen.
      precheck: input => refusal(input) ?? tool.precheck?.(input),
      async run(input, context) {
        const problem = refusal(input);
        if (problem) return { ok: false, output: problem };
        return tool.run({ ...input, path: memberRelativePath((input as { path: string }).path).path }, context);
      },
    };
    return guarded;
  });
}
