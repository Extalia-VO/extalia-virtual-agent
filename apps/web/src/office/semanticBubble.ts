import type { ActivityKind, AgentPhase } from '@extalia/protocol';
import type { Messages } from '../i18n';
import type { OfficeActivity, OfficeActivityKind } from './activityFeed';
import type { OfficeAgentStatus } from './presence';

/**
 * Privacy-safe words for what a character is doing. Bubbles, name tags, toasts
 * and in-world screens show only these fixed catalog phrases: never a command,
 * path, query, token, or reply text. Raw labels are read only to pick a category.
 */
export type SemanticCategory =
  | 'command' | 'read' | 'search' | 'git' | 'test' | 'edit' | 'web' | 'think' | 'review'
  | 'write' | 'create' | 'delete' | 'move' | 'copy' | 'format' | 'build' | 'install' | 'data'
  | 'meeting' | 'delegate' | 'knowledge' | 'approval' | 'failed' | 'reply' | 'prompt' | 'working' | 'question';

export interface SemanticInput {
  kind: OfficeActivityKind;
  activity?: ActivityKind | undefined;
  /** Reported presentation label. Read only for a safe category; never shown. */
  text?: string | undefined;
  /** Exact protocol tool identity; metadata is never included in the phrase. */
  tool?: string | undefined;
  /** Explicit tool target, preferred to its presentation label for command classification. */
  target?: string | undefined;
}

const TOOL_CATEGORIES: Readonly<Record<string, SemanticCategory>> = {
  write_file: 'write', write: 'write', write_to_file: 'write',
  edit_file: 'edit', edit: 'edit', multiedit: 'edit', apply_patch: 'edit', str_replace_editor: 'edit',
  replace_file_content: 'edit', multi_replace_file_content: 'edit',
  create_file: 'create', create_directory: 'create', make_directory: 'create',
  delete_file: 'delete', remove_file: 'delete', delete_directory: 'delete', remove_directory: 'delete',
  move_file: 'move', rename_file: 'move', move_directory: 'move',
  copy_file: 'copy', copy_directory: 'copy',
  read_file: 'read', read: 'read', view_file: 'read',
  search_files: 'search', grep: 'search', glob: 'search',
  format_file: 'format', format_code: 'format',
  build_project: 'build', install_dependencies: 'install',
  query_database: 'data', database_query: 'data', execute_sql: 'data', sqlite_query: 'data',
};
const COMMAND_TOOLS = new Set(['run_command', 'exec_command', 'shell_command', 'bash', 'shell', 'terminal', 'execute_command', 'run_terminal_command', 'run_shell_command']);
const REVIEW = /^(?:review(?:ing)?(?:\s|$)|(?:checking|viewing)\s+(?:the\s+)?diff\b)/i;

/** A deliberately narrow execution-prefix classifier, never a shell parser or a keyword search. */
function commandCategory(raw: string, presentationLabel: boolean): SemanticCategory | undefined {
  // Very large tool targets remain generic rather than repeatedly scanning
  // unbounded command bodies during Office presentation updates.
  if (raw.length > 2048) return undefined;
  const command = presentationLabel ? raw.trim().replace(/^Running\s+/i, '') : raw.trim();
  // Compound commands, substitutions and redirected output cannot establish one
  // precise action. Help/version/dry-run flags must not look like a mutation.
  if (!command || /[\n\r;&|`$<>]/.test(command)
    || /(?:^|[\s'"])(?:--help|--version|--dry-run|--dryrun|--what-if|-whatif|-h|-\?|\/\?)(?=[\s'"=]|$)/i.test(command)) return undefined;
  if (/^git(?:\s|$)/i.test(command)) return 'git';
  if (/^(?:rm|rmdir|unlink|del|erase|remove-item)(?:\s|$)/i.test(command)) return 'delete';
  if (/^(?:mv|rename|ren|move-item|rename-item)(?:\s|$)/i.test(command)) return 'move';
  if (/^(?:cp|copy|xcopy|rsync|copy-item)(?:\s|$)/i.test(command)) return 'copy';
  if (/^(?:mkdir|touch|new-item)(?:\s|$)/i.test(command)) return 'create';
  if (/^(?:sqlite3|psql|mysql|duckdb|jq|yq|csvcut|csvstat|csvjoin|csvsql)(?:\s|$)/i.test(command)) return 'data';
  if (/^(?:vitest|jest|pytest|mocha)(?:\s|$)/i.test(command) || /^(?:cargo|go|dotnet)\s+test(?:\s|$)/i.test(command)) return 'test';
  const packageTask = /^(?:npm|pnpm|yarn|bun|npx)\s+(?:(?:run|exec)\s+)?([\w:-]+)(?:\s|$)/i.exec(command)?.[1]?.toLowerCase().split(':')[0];
  if (packageTask === 'test' || ['vitest', 'jest', 'mocha'].includes(packageTask ?? '')) return 'test';
  if (packageTask === 'build' || /^(?:(?:cargo|go|dotnet)\s+build|cmake\s+--build|mvn\s+(?:compile|package)|gradle\s+build)(?:\s|$)/i.test(command)) return 'build';
  if (['install', 'ci', 'add'].includes(packageTask ?? '')
    || /^(?:(?:pip3?|uv\s+pip)\s+install|python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install|cargo\s+add|dotnet\s+add\s+package)(?:\s|$)/i.test(command)) return 'install';
  const checksOnly = /(?:^|\s)(?:--check|--diff|--verify-no-changes|-l)(?:\s|$)/i.test(command);
  if (packageTask === 'format' || packageTask === 'fmt' || packageTask === 'prettier'
    || /^(?:(?:prettier|black|rustfmt|gofmt)(?:\s|$)|(?:cargo\s+fmt|ruff\s+format|dotnet\s+format)(?:\s|$))/i.test(command)) return checksOnly ? 'review' : 'format';
  if (packageTask === 'lint' || /^(?:eslint(?:\s|$)|ruff\s+check(?:\s|$)|tsc\s+--noEmit(?:\s|$))/i.test(command)) return 'review';
  return undefined;
}

/**
 * The category an activity stands for, or undefined when nothing is ongoing
 * (a finished turn). Exact tool identity takes precedence; command prefixes are
 * inspected only for reported command work, never for a prompt or search query.
 */
export function semanticCategory({ kind, activity, text = '', tool, target }: SemanticInput): SemanticCategory | undefined {
  switch (kind) {
    case 'prompt': case 'reply': case 'approval': case 'failed': return kind;
    case 'meeting-started': case 'meeting-contribution': return 'meeting';
    case 'meeting-completed': case 'meeting-cancelled': return undefined;
    case 'meeting-failed': return 'failed';
    case 'delegated': return 'delegate';
    case 'done': return undefined;
    case 'tool': break;
  }
  const toolName = tool && tool.length <= 256 ? tool.trim().toLowerCase().replace(/^functions\./, '').replace(/^mcp__filesystem__/, '') : undefined;
  const reported = toolName && Object.hasOwn(TOOL_CATEGORIES, toolName) ? TOOL_CATEGORIES[toolName] : undefined;
  if (reported) return reported;
  const commandTarget = target?.trim();
  if (toolName && COMMAND_TOOLS.has(toolName)) return commandCategory(commandTarget || text, !commandTarget) ?? 'command';
  switch (activity) {
    case 'edit': return 'edit';
    case 'read': return 'read';
    case 'search': return 'search';
    case 'web': return 'web';
    case 'delegate': return 'delegate';
    case 'knowledge': return 'knowledge';
    case 'think': return 'think';
    case 'test': return 'test';
    case 'command': case 'tool': case undefined:
      if (activity === 'command') return commandCategory(commandTarget || text, !commandTarget) ?? 'command';
      if (REVIEW.test(text)) return 'review';
      return 'working';
  }
}

/**
 * The category for a presence's current work: what its screen or name tag says. Waiting and
 * blocked presences need attention; a delegating one without an activity is coordinating.
 */
export function presenceCategory(presence: { status: OfficeAgentStatus; activity?: ActivityKind | undefined; target?: string | undefined; phase?: AgentPhase | undefined }): SemanticCategory | undefined {
  // v0.0.38: a question to the user is not an approval; planning and compacting read as thinking.
  if (presence.status === 'waiting' && presence.phase === 'input') return 'question';
  if (presence.phase === 'planning' || presence.phase === 'compacting') return 'think';
  if (presence.phase === 'error') return 'failed';
  const kind = presence.status === 'waiting' ? 'approval' : presence.status === 'blocked' ? 'failed'
    : presence.status === 'delegating' && !presence.activity ? 'delegated' : 'tool';
  const activity = presence.activity ?? (presence.status === 'thinking' ? 'think' : undefined);
  return semanticCategory({ kind, activity, text: presence.target });
}

export function semanticPhrase(category: SemanticCategory, t: Messages): string {
  return t.officeUx.semantic[category];
}

/** The short world-safe line for an activity, or undefined when it has none (a finished turn). */
export function semanticBubble(activity: OfficeActivity, t: Messages): string | undefined {
  const category = semanticCategory(activity);
  return category ? semanticPhrase(category, t) : undefined;
}
