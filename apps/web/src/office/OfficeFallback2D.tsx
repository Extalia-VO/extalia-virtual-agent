import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import type { ReactNode } from 'react';
import type { PendingApproval } from '../approvals/model';
import type { Language, Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { OriginChip } from '../ui/OriginMark';
import { agentStatusLabel, statusTone, type StatusTone } from './overlay/status';
import type { OfficeAgent } from './presence';
import './officeFallback2D.css';

export interface OfficeFallback2DProps {
  t: Messages;
  language: Language;
  reason: 'webgl-unavailable' | 'manual-2d';
  agents: readonly OfficeAgent[];
  sessions: readonly SessionSummary[];
  workspaces: readonly Workspace[];
  statusLabelOf?: (agent: OfficeAgent) => string;
  approvalFor?: (agent: OfficeAgent) => PendingApproval | undefined;
  renderApprovalActions?: (approval: PendingApproval) => ReactNode;
  onOpenSession?: (agent: OfficeAgent) => void;
  onOpenChat?: () => void;
  onOpenMissions?: () => void;
  onSwitchTo3D?: () => void;
}

const TITLE_ID = 'office-fallback-2d-title';

function toneBadgeClass(tone: StatusTone): string {
  switch (tone) {
    case 'work':
      return 'ok';
    case 'warn':
    case 'wait':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return '';
  }
}

function approvalRiskClass(risk: PendingApproval['risk']): string {
  if (risk === 'high') return 'error';
  if (risk === 'medium') return 'warn';
  return '';
}

/**
 * Presentation-only 2D Operations View rendered when 3D/WebGL is unavailable or
 * when the user switches to 2D mode. Keeps workspaces, links, and approvals actionable.
 */
export function OfficeFallback2D({
  t,
  language,
  reason,
  agents,
  sessions,
  workspaces,
  statusLabelOf,
  approvalFor,
  renderApprovalActions,
  onOpenSession,
  onOpenChat,
  onOpenMissions,
  onSwitchTo3D,
}: OfficeFallback2DProps) {
  const f = t.office.fallback2d;
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));

  return (
    <section className="office-fallback-2d" aria-labelledby={TITLE_ID}>
      <header className="office-fallback-2d-header">
        <div className="office-fallback-2d-title-row">
          <h2 id={TITLE_ID}>{f.title}</h2>
          <span className="badge">{f.agentCount(agents.length)}</span>
        </div>
        <div className="office-fallback-2d-actions">
          {reason === 'webgl-unavailable' && onSwitchTo3D && (
            <button type="button" className="button primary small" onClick={onSwitchTo3D}>
              <Icon name="refresh" />
              <span>{f.retry3d}</span>
            </button>
          )}
          {reason === 'manual-2d' && onSwitchTo3D && (
            <button type="button" className="button small" onClick={onSwitchTo3D}>
              <Icon name="monitor" />
              <span>{t.office.viewMode.switchTo3d}</span>
            </button>
          )}
          {onOpenChat && (
            <button type="button" className="button small" onClick={onOpenChat}>
              <Icon name="chat" />
              <span>{f.openChat}</span>
            </button>
          )}
          {onOpenMissions && (
            <button type="button" className="button small" onClick={onOpenMissions}>
              <Icon name="mission" />
              <span>{f.openMissions}</span>
            </button>
          )}
        </div>
      </header>

      <p className="office-fallback-2d-banner" role="status" data-reason={reason}>
        {reason === 'webgl-unavailable' ? f.leadWebglUnavailable : f.leadManual2d}
      </p>

      {agents.length === 0 ? (
        <div className="office-fallback-2d-empty">
          <p>{f.empty}</p>
        </div>
      ) : (
        <ul className="office-fallback-2d-grid">
          {agents.map(agent => {
            const session = sessionById.get(agent.sessionId);
            const roleLabel = agent.control === 'observed'
              ? t.characterPopover.roles.observed
              : agent.agentId === 'primary'
                ? t.characterPopover.roles.lead
                : t.characterPopover.roles.worker;
            const statusText = statusLabelOf ? statusLabelOf(agent) : agentStatusLabel(t, agent, language);
            const tone = statusTone(agent);
            const badgeTone = toneBadgeClass(tone);
            const unassigned = session?.workspaceId == null || session.workspaceId === '';
            const workspaceName = unassigned
              ? f.workspaceUnassigned
              : workspaceById.get(session.workspaceId!)?.name ?? session.workspaceId!;
            const channel = agent.origin?.channel ? t.observedOrigin.channels[agent.origin.channel] : undefined;
            const approval = approvalFor?.(agent);
            const summaryText = agent.summary ?? agent.title;

            return (
              <li key={agent.id} className="office-fallback-2d-card" data-control={agent.control} data-tone={tone}>
                <div className="office-fallback-2d-card-head">
                  <div className="office-fallback-2d-card-identity">
                    <strong>{agent.displayName}</strong>
                    <span className="office-fallback-2d-role">{roleLabel}</span>
                  </div>
                  <span
                    className={`badge office-fallback-2d-status${badgeTone ? ` ${badgeTone}` : ''}`}
                    data-tone={tone}
                  >
                    {statusText}
                  </span>
                </div>

                <div className="office-fallback-2d-meta">
                  <span className="office-fallback-2d-workspace" data-unassigned={unassigned || undefined}>
                    <Icon name="folder" />
                    <span>{workspaceName}</span>
                  </span>
                  {agent.origin && <OriginChip origin={agent.origin} channel={channel} showChannel />}
                  {agent.control === 'observed' && (
                    <span className="badge office-fallback-2d-observed">{f.observedReadOnly}</span>
                  )}
                  {agent.model && <code className="office-fallback-2d-model">{agent.model}</code>}
                </div>

                {agent.title && agent.summary && agent.title !== agent.summary ? (
                  <div className="office-fallback-2d-summary">
                    <p className="office-fallback-2d-task">{agent.title}</p>
                    <p className="office-fallback-2d-detail">{agent.summary}</p>
                  </div>
                ) : summaryText ? (
                  <p className="office-fallback-2d-detail">{summaryText}</p>
                ) : null}

                {approval && (
                  <div className="office-fallback-2d-approval" data-risk={approval.risk}>
                    <div className="office-fallback-2d-approval-head">
                      <strong>{t.approval.title}</strong>
                      <span className={`badge ${approvalRiskClass(approval.risk)}`}>
                        {t.approval.risk[approval.risk]}
                      </span>
                    </div>
                    <p className="office-fallback-2d-approval-action">{approval.action}</p>
                    {approval.detail && (
                      <pre className="office-fallback-2d-approval-detail">{approval.detail}</pre>
                    )}
                    {renderApprovalActions?.(approval)}
                  </div>
                )}

                {onOpenSession && (
                  <div className="office-fallback-2d-card-foot">
                    <button type="button" className="button small" onClick={() => onOpenSession(agent)}>
                      <Icon name="external" />
                      <span>{f.openSession}</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
