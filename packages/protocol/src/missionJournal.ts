/**
 * Worker activity the native mission journal admits (ADR 0014, amended for ADR 0028): the single
 * source for the TypeScript host store (`nativeEvent` in `packages/host/src/missionCheckpoints.ts`)
 * and the Rust daemon store (`crates/extalia-core/src/mission/policy.rs`), which embeds the
 * generated `packages/protocol/schemas/journal-admission.json` at compile time.
 *
 * A read-only worker reports read/search/think activity and named read/search tools. A
 * write-capable worker (`access: 'write'` on its task, agent role `write-worker`) may also report
 * `edit` activity and the worktree file tools `write_file`/`edit_file`, each with an optional
 * `target`: a bounded path relative to the worker's own worktree. File contents, edit text, tool
 * output and raw labels never enter the journal; the worktree diff is the record of what changed.
 */

export type MissionJournalRole = 'read-only-worker' | 'write-worker';
/** Roles from the least to the most privileged; an activity needs the first role that admits it. */
export const MISSION_JOURNAL_ROLES = ['read-only-worker', 'write-worker'] as const satisfies readonly MissionJournalRole[];

interface RoleActivity { readonly agentActivities: readonly string[]; readonly toolKinds: readonly string[] }

export const MISSION_JOURNAL_ACTIVITY: Readonly<Record<MissionJournalRole, RoleActivity>> = Object.freeze({
  'read-only-worker': Object.freeze({ agentActivities: Object.freeze(['read', 'search', 'think']), toolKinds: Object.freeze(['read', 'search']) }),
  'write-worker': Object.freeze({ agentActivities: Object.freeze(['read', 'search', 'think', 'edit']), toolKinds: Object.freeze(['read', 'search', 'edit']) }),
});

/** The only tools an `edit` tool event may name. */
export const MISSION_JOURNAL_EDIT_TOOLS: readonly string[] = Object.freeze(['write_file', 'edit_file']);

/**
 * Bounds of an edit event's `target`: ASCII letters and digits plus `punctuation`, `/`-separated
 * segments (none empty, `.` or `..`, none starting or ending with a space), at most `maxLength`
 * characters (bytes, since it is ASCII) and `maxSegments` segments. Anything else is not journaled.
 */
export const MISSION_JOURNAL_EDIT_TARGET = Object.freeze({ maxLength: 240, maxSegments: 32, punctuation: '._-@+ ' });

const TOOL_NAME = /^[a-zA-Z][\w.-]{0,63}$/;

/** Whether `value` is a journal-safe path relative to a worker's worktree. */
export function isJournalEditTarget(value: unknown): value is string {
  const { maxLength, maxSegments, punctuation } = MISSION_JOURNAL_EDIT_TARGET;
  if (typeof value !== 'string' || !value.length || value.length > maxLength) return false;
  const segments = value.split('/');
  if (segments.length > maxSegments) return false;
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith(' ') && !segment.endsWith(' ')
    && [...segment].every(character => /^[A-Za-z0-9]$/.test(character) || punctuation.includes(character)));
}

/**
 * The journal target for a model-supplied file path: `\` becomes `/`, leading `./` and repeated or
 * trailing `/` are dropped. Absolute paths, drive letters, `..` and anything outside the bounds give
 * `undefined` (the event is then journaled without a target).
 */
export function journalEditTarget(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length > 4 * MISSION_JOURNAL_EDIT_TARGET.maxLength) return undefined;
  let value = path.replace(/\\/g, '/');
  if (value.startsWith('/')) return undefined;
  value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  while (value.startsWith('./')) value = value.slice(2);
  return isJournalEditTarget(value) ? value : undefined;
}

type ActivityBody =
  | { type: 'agent.state'; activity?: string }
  | { type: 'tool.started' | 'tool.completed'; tool: string; kind: string; label: string; target?: string };

function admits(role: MissionJournalRole, body: ActivityBody): boolean {
  const rules = MISSION_JOURNAL_ACTIVITY[role];
  if (body.type === 'agent.state') return body.activity === undefined || rules.agentActivities.includes(body.activity);
  if (!rules.toolKinds.includes(body.kind) || typeof body.tool !== 'string' || !TOOL_NAME.test(body.tool) || body.label !== body.tool) return false;
  if (body.kind === 'edit') return MISSION_JOURNAL_EDIT_TOOLS.includes(body.tool) && (body.target === undefined || isJournalEditTarget(body.target));
  return body.target === undefined;
}

/**
 * The least privileged role whose worker may journal this activity body (`agent.state`,
 * `tool.started`, `tool.completed`), or `undefined` when no worker may. Other keys are checked by
 * each store's field table.
 */
export function missionJournalRole(body: ActivityBody): MissionJournalRole | undefined {
  return MISSION_JOURNAL_ROLES.find(role => admits(role, body));
}

/** Content of the generated `journal-admission.json` read by the Rust daemon. */
export function missionJournalAdmissionJson(): { $comment: string; roles: readonly MissionJournalRole[]; activity: typeof MISSION_JOURNAL_ACTIVITY; editTools: readonly string[]; editTarget: typeof MISSION_JOURNAL_EDIT_TARGET } {
  return {
    $comment: 'Generated from @extalia/protocol (MISSION_JOURNAL_ACTIVITY, MISSION_JOURNAL_EDIT_TOOLS, MISSION_JOURNAL_EDIT_TARGET) by tooling/generate-schemas.mjs; do not edit. Roles are ordered from least to most privileged.',
    roles: MISSION_JOURNAL_ROLES,
    activity: MISSION_JOURNAL_ACTIVITY,
    editTools: MISSION_JOURNAL_EDIT_TOOLS,
    editTarget: MISSION_JOURNAL_EDIT_TARGET,
  };
}
