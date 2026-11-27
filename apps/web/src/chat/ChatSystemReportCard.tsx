import {
  sanitizeGatewayText,
  type AutonomousReportOutcome,
  type WorkspaceSystemReport,
  type WorkspaceSystemReportSkill,
} from '@extalia/platform';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import './chatSystemReport.css';

function outcomeTone(outcome: AutonomousReportOutcome): string {
  if (outcome === 'completed') return 'ok';
  if (outcome === 'partial' || outcome === 'skipped') return 'warn';
  if (outcome === 'failed') return 'error';
  return 'subtle';
}

function skillTone(state: WorkspaceSystemReportSkill['state']): string {
  if (state === 'active-confirmed') return 'ok';
  if (state === 'failed') return 'error';
  if (state === 'review-required' || state === 'inspection-pending' || state === 'candidate-saved') return 'warn';
  return 'subtle';
}

function knowledgeTone(state: NonNullable<WorkspaceSystemReport['knowledge']>['state']): string {
  if (state === 'saved') return 'ok';
  if (state === 'partial' || state === 'skipped') return 'warn';
  if (state === 'failed') return 'error';
  return 'subtle';
}

function meetingTone(outcome: NonNullable<WorkspaceSystemReport['meeting']>['outcome']): string {
  if (outcome === 'completed') return 'ok';
  if (outcome === 'failed') return 'error';
  if (outcome === 'cancelled') return 'warn';
  return 'subtle';
}

function formatTimestamp(value: string, language?: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
  } catch {
    return value;
  }
}

export interface ChatSystemReportCardProps {
  t: Messages;
  report: WorkspaceSystemReport;
  language?: string;
  variant?: 'chat' | 'inbox';
}

/**
 * Read-only projection of a canonical WorkspaceSystemReport (GW-AT-088).
 * Explicitly marked as host output that is never sent to the model.
 */
export function ChatSystemReportCard({ t, report, language, variant = 'chat' }: ChatSystemReportCardProps) {
  const copy = t.chat.systemReports;
  const sourceText = copy.sources[report.source] ?? report.source;
  const outcomeText = copy.outcomes[report.outcome] ?? report.outcome;
  const targetText = copy.targets[report.targetSelection] ?? report.targetSelection;
  const sanitizedProblems = (report.problems ?? [])
    .map(problem => sanitizeGatewayText(problem, { maxLength: 500, stripMentions: true }).text)
    .filter(Boolean);

  return (
    <aside
      className="chat-system-report-card"
      data-testid={variant === 'chat' ? 'chat-system-report-card' : 'workspace-system-report-card'}
      aria-label={`${copy.heading}: ${sourceText}`}
    >
      <div className="chat-system-report-head">
        <span className="chat-system-report-title">
          <Icon name="shield" />
          <span>{sourceText}</span>
        </span>
        <div className="chat-system-report-badges">
          <span className={`badge ${outcomeTone(report.outcome)}`}>{outcomeText}</span>
          <span className="badge subtle">{copy.readOnlyBadge}</span>
        </div>
      </div>

      <dl className="chat-system-report-facts">
        <div>
          <dt>{copy.sourceLabel}</dt>
          <dd>{sourceText}</dd>
        </div>
        <div>
          <dt>{copy.outcomeLabel}</dt>
          <dd>{outcomeText}</dd>
        </div>
        <div>
          <dt>{copy.targetLabel}</dt>
          <dd>{targetText}</dd>
        </div>
      </dl>

      {(report.knowledge || (report.skills && report.skills.length > 0) || report.meeting) && (
        <div className="chat-system-report-receipts">
          {report.knowledge && (
            <div className="chat-system-report-row">
              <span className="chat-system-report-label">{copy.knowledgeLabel}</span>
              <span className={`badge ${knowledgeTone(report.knowledge.state)}`}>
                {copy.knowledgeStates[report.knowledge.state] ?? report.knowledge.state}
              </span>
              {report.knowledge.indexed !== undefined && (
                <span className="badge subtle">
                  {report.knowledge.indexed ? copy.indexed : copy.notIndexed}
                </span>
              )}
            </div>
          )}

          {report.skills && report.skills.length > 0 && (
            <div className="chat-system-report-row">
              <span className="chat-system-report-label">{copy.skillsLabel}</span>
              <ul className="chat-system-report-skills">
                {report.skills.map(skill => {
                  const activated = skill.state === 'active-confirmed' && skill.activationPerformed;
                  return (
                    <li key={`${skill.packageId}:${skill.revisionId}`}>
                      <code>{skill.packageId}@{skill.revisionId}</code>
                      <span className={`badge ${skillTone(skill.state)}`}>
                        {copy.skillStates[skill.state] ?? skill.state}
                      </span>
                      <span className={`badge ${activated ? 'ok' : 'subtle'}`}>
                        {activated ? copy.activationPerformed : copy.activationNotPerformed}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {report.meeting && (
            <div className="chat-system-report-row">
              <span className="chat-system-report-label">{copy.meetingLabel}</span>
              <span className={`badge ${meetingTone(report.meeting.outcome)}`}>
                {copy.meetingOutcomes[report.meeting.outcome] ?? report.meeting.outcome}
              </span>
              <span className="badge subtle">
                {copy.meetingKnowledge[report.meeting.knowledge] ?? report.meeting.knowledge}
              </span>
            </div>
          )}
        </div>
      )}

      {sanitizedProblems.length > 0 && (
        <div className="chat-system-report-receipts">
          <span className="chat-system-report-label">{copy.problemsLabel}</span>
          <ul className="chat-system-report-problems">
            {sanitizedProblems.map((problem, index) => (
              <li key={`${report.id}:problem:${index}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="chat-system-report-meta">
        <span>{copy.jobLabel}: <code>{report.sourceJobId}</code></span>
        <span>{copy.committedLabel}: {formatTimestamp(report.committedAt, language)}</span>
      </p>
    </aside>
  );
}
