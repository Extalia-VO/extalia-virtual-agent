import { safeLabel, safeText } from '@extalia/core';
import type { ApprovalDecisionInput } from '@extalia/platform';
import type { ExtaliaEvent, RiskLevel } from '@extalia/protocol';

/**
 * Pending approvals across sessions (v0.0.48): a pure projection of protocol
 * events, so the topbar inbox, notifications and Office cards read one list.
 * The shape is source-neutral; observed sessions from other apps get the same
 * record with no choices until a bridge can answer for them.
 */

export type ApprovalSource = 'native' | 'claude' | 'codex' | 'gemini' | 'hermes';
export type ApprovalChoice = 'allow-once' | 'allow-session' | 'deny';
export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['allow-once', 'allow-session', 'deny'];

export interface PendingApproval {
  /** The protocol `approvalId`, unique within its session. */
  id: string;
  source: ApprovalSource;
  sessionId: string;
  /** Full name of the agent that asks; empty when the session has none. */
  agentName: string;
  /** Session title, shown next to the agent name. */
  sessionTitle: string;
  /** Redacted, single line: what the agent wants to do. */
  action: string;
  /** Redacted, bounded: parameters, command or file. */
  detail?: string;
  risk: RiskLevel;
  requestedAt: string;
  expiresAt?: string;
  /** Empty when this host cannot answer the request. */
  choices: ApprovalChoice[];
}

/** The part of a session summary the derivation needs. */
export interface ApprovalSessionRef {
  id: string;
  title?: string | undefined;
  agentName?: string | undefined;
  control?: 'managed' | 'observed' | undefined;
  runtime?: { id: string } | undefined;
}

const SOURCE_BY_RUNTIME: Readonly<Record<string, ApprovalSource>> = { hermes: 'hermes', claude: 'claude', 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' };

/** Where the request comes from: an external runtime's id, or Extalia Native for managed sessions without one. */
export function approvalSource(session: ApprovalSessionRef): ApprovalSource {
  return SOURCE_BY_RUNTIME[session.runtime?.id ?? ''] ?? 'native';
}

const HIGH_RISK = /\brm\s|\bsudo\b|\bgit\s+push\b|\bchmod\b|\bchown\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\bnc\s|https?:\/\/|\bdrop\s+table\b|\bdelete\b|\bremove\b|\bpublish\b|\bdeploy\b|\|\s*(?:sh|bash|zsh)\b|>\s*\//i;
const MEDIUM_RISK = /\b(?:run|execute|exec|command|shell|npm|pnpm|yarn|npx|node|python|make|test|edit|write|create|update|modify|overwrite|append|save|move|rename|commit)\b/i;
const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high'];

/** Risk from the words of the request: network, deletion and privilege are high; commands and writes medium. */
export function inferRisk(action: string, detail = ''): RiskLevel {
  const text = `${action} ${detail}`;
  if (HIGH_RISK.test(text)) return 'high';
  if (MEDIUM_RISK.test(text)) return 'medium';
  return 'low';
}

/** The higher of the runtime's stated risk and the one inferred from the request; never lower than the words say. */
export function riskOf(stated: RiskLevel | undefined, action: string, detail = ''): RiskLevel {
  const inferred = inferRisk(action, detail);
  if (!stated) return inferred;
  return RISK_ORDER.indexOf(stated) >= RISK_ORDER.indexOf(inferred) ? stated : inferred;
}

/** Redacted single-line action text, bounded. */
export function displayAction(action: string): string {
  return safeLabel(action, 160);
}

/** Redacted multi-line detail, bounded. */
export function displayDetail(detail: string): string {
  return safeText(detail, 800);
}

/** Map an approval choice to the host's decision input. */
export function decisionFor(choice: ApprovalChoice): ApprovalDecisionInput {
  return choice === 'allow-once' ? 'once' : choice === 'allow-session' ? 'session' : 'reject';
}

/** Stable key for one approval across sessions. */
export function approvalKey(approval: Pick<PendingApproval, 'sessionId' | 'id'>): string {
  return `${approval.sessionId}/${approval.id}`;
}

/** Oldest first; ties by id so the order is the same on every render. */
export function sortApprovals(list: readonly PendingApproval[]): PendingApproval[] {
  return [...list].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
}

/** One entry per approval (session and id); the first one wins, so history replayed twice does not double up. */
export function dedupeApprovals(list: readonly PendingApproval[]): PendingApproval[] {
  const seen = new Map<string, PendingApproval>();
  for (const item of list) if (!seen.has(approvalKey(item))) seen.set(approvalKey(item), item);
  return sortApprovals([...seen.values()]);
}

function eventOrder(a: ExtaliaEvent, b: ExtaliaEvent): number {
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
  return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

/**
 * Approvals a session is still waiting on, from its events. A request is open
 * until `approval.resolved` names it. A turn that ended (completed, failed or
 * the session ended) cannot still wait, so whatever is open then is closed.
 * Input order does not matter: events are sorted by sequence, then time.
 */
export function derivePendingApprovals(session: ApprovalSessionRef, events: readonly ExtaliaEvent[]): PendingApproval[] {
  const open = new Map<string, PendingApproval>();
  for (const event of [...events].sort(eventOrder)) {
    const body = event.body;
    if (body.type === 'approval.requested') {
      if (!open.has(body.approvalId)) open.set(body.approvalId, toPending(session, event.at, body));
    } else if (body.type === 'approval.resolved') {
      open.delete(body.approvalId);
    } else if (body.type === 'turn.completed' || body.type === 'turn.failed' || body.type === 'session.ended') {
      open.clear();
    }
  }
  return sortApprovals([...open.values()]);
}

function toPending(session: ApprovalSessionRef, requestedAt: string, body: { approvalId: string; action: string; detail?: string; risk?: RiskLevel }): PendingApproval {
  const detail = body.detail ? displayDetail(body.detail) : '';
  const pending: PendingApproval = {
    id: body.approvalId,
    source: approvalSource(session),
    sessionId: session.id,
    agentName: safeLabel(session.agentName ?? '', 60),
    sessionTitle: safeLabel(session.title ?? '', 80),
    action: displayAction(body.action),
    risk: riskOf(body.risk, body.action, body.detail ?? ''),
    requestedAt,
    // Observed sessions belong to another app; this host cannot answer for them.
    choices: session.control === 'observed' ? [] : [...APPROVAL_CHOICES],
  };
  if (detail) pending.detail = detail;
  return pending;
}
