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
  | 'delegate' | 'knowledge' | 'approval' | 'failed' | 'reply' | 'prompt' | 'working' | 'question';

export interface SemanticInput {
  kind: OfficeActivityKind;
  activity?: ActivityKind | undefined;
  /** Raw label or target. Read to tell git, test and review commands apart; never shown. */
  text?: string | undefined;
}

const GIT = /(^|[\s;&|(])git\s/i;
const TEST = /(^|[\s;&|(])((npm|pnpm|yarn|bun|npx)\s+(run\s+)?test\b|vitest\b|jest\b|pytest\b|mocha\b|cargo\s+test\b|go\s+test\b)/i;
const REVIEW = /\b(review|diff)\b/i;

/**
 * The category an activity stands for, or undefined when nothing is ongoing
 * (a finished turn). Commands are told apart by their text; everything else by kind.
 */
export function semanticCategory({ kind, activity, text = '' }: SemanticInput): SemanticCategory | undefined {
  switch (kind) {
    case 'prompt': case 'reply': case 'approval': case 'failed': return kind;
    case 'delegated': return 'delegate';
    case 'done': return undefined;
    case 'tool': break;
  }
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
      if (GIT.test(text)) return 'git';
      if (TEST.test(text)) return 'test';
      if (activity !== 'command' && REVIEW.test(text)) return 'review';
      return activity === 'command' ? 'command' : 'working';
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
  const category = semanticCategory({ kind: activity.kind, activity: activity.activity, text: activity.text });
  return category ? semanticPhrase(category, t) : undefined;
}
