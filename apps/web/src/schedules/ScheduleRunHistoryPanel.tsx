import { useState } from 'react';
import {
  GENERAL_SCHEDULE_LIMITS,
  SCHEDULE_REVIEW_ACTIONS,
  SCHEDULE_RUN_STATES,
  type GeneralSchedule,
  type ScheduleReviewAction,
  type ScheduleReviewDecision,
  type ScheduleRunDetail,
  type ScheduleRunState,
  type ScheduleRunV1,
} from '@extalia/platform';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import {
  deliveryBadgeTone,
  formatTimestampInZone,
  runStateBadgeTone,
  verificationBadgeTone,
} from './scheduleFormatting';

export function ScheduleRunDetailCard({
  text,
  detail,
  schedule,
  loading,
  reviewBusy,
  reviewError,
  onClose,
  onOpenSession,
  onReviewUnknownRun,
}: {
  text: Messages['schedules'];
  detail?: ScheduleRunDetail;
  schedule?: GeneralSchedule;
  loading: boolean;
  reviewBusy: boolean;
  reviewError: string | null;
  onClose(): void;
  onOpenSession(sessionId: string, workspaceId: string): void;
  onReviewUnknownRun(runId: string, expectedRevision: number, decision: ScheduleReviewDecision): Promise<void>;
}) {
  const [action, setAction] = useState<ScheduleReviewAction>('acknowledge');
  const [note, setNote] = useState('');

  if (loading) {
    return (
      <section className="card schedule-run-detail" data-testid="schedule-run-detail" aria-busy="true">
        <div className="card-head">
          <h3>{text.runDetailTitle}</h3>
          <button type="button" className="button small" onClick={onClose}>
            <Icon name="close" />
            {text.closeRunDetail}
          </button>
        </div>
        <p className="muted" role="status">{text.loadingRunDetail}</p>
      </section>
    );
  }

  if (!detail) return null;

  const { run, deliveries, scheduleName } = detail;
  const scheduleTimeZone = schedule?.trigger.kind === 'cron' ? schedule.trigger.timeZone : undefined;
  const latestDelivery = deliveries.at(-1);

  return (
    <section
      className="card schedule-run-detail"
      data-testid="schedule-run-detail"
      aria-labelledby="schedule-run-detail-heading"
    >
      <div className="card-head">
        <div>
          <h3 id="schedule-run-detail-heading">
            {text.runDetailTitle}
            {scheduleName || schedule?.name ? ` · ${scheduleName ?? schedule?.name}` : ''}
          </h3>
          <p className="muted small">
            {text.occurrenceKinds[run.occurrenceKind]} · <code>{run.id}</code>
          </p>
        </div>
        <button type="button" className="button small" onClick={onClose}>
          <Icon name="close" />
          {text.closeRunDetail}
        </button>
      </div>

      <div className="schedule-run-badges" data-testid="schedule-run-detail-badges">
        {schedule && (
          <span className="badge subtle" data-testid="badge-schedule-state">
            {text.scheduleStateBadge(text.states[schedule.state])}
          </span>
        )}
        <span className={`badge ${runStateBadgeTone(run.state)}`} data-testid="badge-run-state">
          {text.runStates[run.state]}
        </span>
        <span className={`badge ${verificationBadgeTone(run.verification)}`} data-testid="badge-verification-state">
          {text.verificationStates[run.verification]}
        </span>
        {latestDelivery ? (
          <span className={`badge ${deliveryBadgeTone(latestDelivery.state)}`} data-testid="badge-delivery-state">
            {text.deliveryStates[latestDelivery.state]}
          </span>
        ) : (
          <span className="badge subtle" data-testid="badge-delivery-state">
            {text.noDeliveries}
          </span>
        )}
      </div>

      <dl className="schedule-detail-grid">
        <div>
          <dt>{text.fieldScheduledFor}</dt>
          <dd>
            {formatTimestampInZone(run.scheduledFor, scheduleTimeZone)}{' '}
            <code className="muted">({run.scheduledFor})</code>
          </dd>
        </div>
        <div>
          <dt>{text.fieldAdmittedAt}</dt>
          <dd>{formatTimestampInZone(run.admittedAt, scheduleTimeZone)}</dd>
        </div>
        <div>
          <dt>{text.fieldSettledAt}</dt>
          <dd>{formatTimestampInZone(run.settledAt, scheduleTimeZone)}</dd>
        </div>
        <div>
          <dt>{text.fieldAttempts}</dt>
          <dd>{run.attemptCount}</dd>
        </div>
        {run.statusReason && (
          <div className="schedule-detail-wide">
            <dt>{text.fieldStatusReason}</dt>
            <dd>{run.statusReason}</dd>
          </div>
        )}
        <div>
          <dt>{text.fieldOccurrenceKey}</dt>
          <dd><code>{run.occurrenceKey}</code></dd>
        </div>
        {run.runtimeId && (
          <div>
            <dt>{text.fieldRuntime}</dt>
            <dd><code>{run.runtimeId}</code></dd>
          </div>
        )}
        {run.correlationId && (
          <div>
            <dt>{text.fieldCorrelation}</dt>
            <dd><code>{run.correlationId}</code></dd>
          </div>
        )}
        {run.turnId && (
          <div>
            <dt>{text.fieldTurnId}</dt>
            <dd><code>{run.turnId}</code></dd>
          </div>
        )}
        {run.terminalEvidenceRef && (
          <div>
            <dt>{text.fieldEvidence}</dt>
            <dd><code>{run.terminalEvidenceRef}</code></dd>
          </div>
        )}
        {run.verificationEvidenceRef && (
          <div>
            <dt>{text.fieldVerificationEvidence}</dt>
            <dd><code>{run.verificationEvidenceRef}</code></dd>
          </div>
        )}
      </dl>

      {run.sessionId && (
        <div className="row-actions">
          <button
            type="button"
            className="button small"
            onClick={() => onOpenSession(run.sessionId!, run.workspaceId)}
          >
            <Icon name="chat" />
            {text.openSession}
          </button>
          <span className="muted small">
            {text.fieldSession}: <code>{run.sessionId}</code>
          </span>
        </div>
      )}

      {deliveries.length > 0 && (
        <div className="schedule-deliveries" data-testid="schedule-run-deliveries">
          <h4>{text.deliveriesHeading}</h4>
          <ul className="schedule-delivery-list">
            {deliveries.map(delivery => (
              <li key={delivery.id} className="schedule-delivery-item">
                <div className="schedule-run-badges">
                  <span className={`badge ${deliveryBadgeTone(delivery.state)}`}>
                    {text.deliveryStates[delivery.state]}
                  </span>
                  <span className="muted small">
                    {text.deliveryTarget(delivery.targetGuildId, delivery.targetChannelId, delivery.targetThreadId)}
                  </span>
                </div>
                <p className="muted small">
                  {text.fieldAttempts}: {delivery.attemptCount}
                  {delivery.discordMessageId ? ` · ${text.deliveryMessageId(delivery.discordMessageId)}` : ''}
                  {delivery.lastErrorCode ? ` · ${text.deliveryErrorCode(delivery.lastErrorCode)}` : ''}
                  {delivery.acknowledgedAt ? ` · ${formatTimestampInZone(delivery.acknowledgedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.state === 'unknown' && (
        <section className="schedule-unknown-review" data-testid="schedule-unknown-review">
          <h4>{text.reviewUnknownHeading}</h4>
          <p className="muted small">{text.reviewUnknownHint}</p>
          {run.reviewDecision && (
            <p className="note" data-testid="schedule-review-recorded">
              <Icon name="check" />
              <span>
                {text.reviewRecorded(
                  text.reviewActions[run.reviewDecision],
                  formatTimestampInZone(run.reviewedAt),
                )}
                {run.reviewNote ? ` — ${run.reviewNote}` : ''}
              </span>
            </p>
          )}
          {reviewError && (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              <span>{reviewError}</span>
            </p>
          )}
          <div className="form-grid">
            <Select
              label={text.reviewActionLabel}
              value={action}
              disabled={reviewBusy}
              options={SCHEDULE_REVIEW_ACTIONS.map(item => ({
                value: item,
                label: text.reviewActions[item],
              }))}
              onChange={value => setAction(value)}
            />
            <label className="field">
              <span>{text.reviewNoteLabel}</span>
              <textarea
                rows={2}
                value={note}
                disabled={reviewBusy}
                maxLength={GENERAL_SCHEDULE_LIMITS.reviewNoteLength}
                placeholder={text.reviewNotePlaceholder}
                data-testid="schedule-review-note"
                onChange={event => setNote(event.target.value)}
              />
            </label>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="button primary small"
              disabled={reviewBusy}
              data-testid="schedule-review-submit"
              onClick={() => {
                const trimmedNote = note.trim();
                void onReviewUnknownRun(run.id, run.revision, {
                  action,
                  ...(trimmedNote ? { note: trimmedNote } : {}),
                }).then(() => setNote(''), () => undefined);
              }}
            >
              <Icon name="check" />
              {reviewBusy ? text.reviewSaving : text.reviewSubmit}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

export function ScheduleRunHistoryPanel({
  text,
  workspaceName,
  schedules,
  runs,
  total,
  nextCursor,
  loading,
  loadingMore,
  error,
  supported,
  scheduleFilter,
  stateFilter,
  selectedRunId,
  selectedDetail,
  detailLoading,
  reviewBusy,
  reviewError,
  onChangeScheduleFilter,
  onChangeStateFilter,
  onRefresh,
  onLoadMore,
  onSelectRun,
  onCloseDetail,
  onClosePanel,
  onOpenSession,
  onReviewUnknownRun,
}: {
  text: Messages['schedules'];
  workspaceName?: string;
  schedules: GeneralSchedule[];
  runs: ScheduleRunV1[];
  total: number;
  nextCursor?: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  supported: boolean;
  scheduleFilter: string;
  stateFilter: ScheduleRunState | '';
  selectedRunId: string | null;
  selectedDetail?: ScheduleRunDetail;
  detailLoading: boolean;
  reviewBusy: boolean;
  reviewError: string | null;
  onChangeScheduleFilter(scheduleId: string): void;
  onChangeStateFilter(state: ScheduleRunState | ''): void;
  onRefresh(): void;
  onLoadMore(): void;
  onSelectRun(run: ScheduleRunV1): void;
  onCloseDetail(): void;
  onClosePanel(): void;
  onOpenSession(sessionId: string, workspaceId: string): void;
  onReviewUnknownRun(runId: string, expectedRevision: number, decision: ScheduleReviewDecision): Promise<void>;
}) {
  const scheduleById = new Map(schedules.map(item => [item.id, item]));
  const selectedRun = runs.find(item => item.id === selectedRunId);
  const effectiveDetail: ScheduleRunDetail | undefined =
    selectedDetail && selectedDetail.run.id === selectedRunId
      ? selectedDetail
      : selectedRun
        ? {
            run: selectedRun,
            deliveries: [],
            ...(scheduleById.get(selectedRun.scheduleId)?.name
              ? { scheduleName: scheduleById.get(selectedRun.scheduleId)!.name }
              : {}),
          }
        : undefined;

  return (
    <section
      className="card schedule-history-panel"
      data-testid="schedule-history-panel"
      aria-labelledby="schedule-history-heading"
    >
      <div className="card-head">
        <div>
          <h2 id="schedule-history-heading">
            {text.runHistoryTitle}
            {workspaceName ? ` · ${workspaceName}` : ''}
          </h2>
          <p className="muted small">{text.runHistoryLead}</p>
        </div>
        <div className="row-actions">
          {supported && (
            <button type="button" className="button small" disabled={loading} onClick={onRefresh}>
              <Icon name="refresh" />
              {text.refreshRuns}
            </button>
          )}
          <button type="button" className="button small" onClick={onClosePanel}>
            <Icon name="close" />
            {text.hideRuns}
          </button>
        </div>
      </div>

      {!supported ? (
        <p className="muted" role="status">{text.runHistoryUnsupported}</p>
      ) : (
        <>
          <div className="form-grid schedule-history-filters">
            <Select
              label={text.filterSchedule}
              value={scheduleFilter}
              options={[
                { value: '', label: text.allSchedules },
                ...schedules.map(item => ({ value: item.id, label: item.name })),
              ]}
              onChange={onChangeScheduleFilter}
            />
            <Select
              label={text.filterRunState}
              value={stateFilter}
              options={[
                { value: '', label: text.allRunStates },
                ...SCHEDULE_RUN_STATES.map(state => ({
                  value: state,
                  label: text.runStates[state],
                })),
              ]}
              onChange={value => onChangeStateFilter(value)}
            />
          </div>

          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}

          {loading && runs.length === 0 ? (
            <p className="muted" role="status">{text.loadingRuns}</p>
          ) : runs.length === 0 ? (
            <p className="muted" role="status">{text.noRuns}</p>
          ) : (
            <>
              <p className="muted small">{text.runsTotal(runs.length, total)}</p>
              <div className="stack" data-testid="schedule-run-list">
                {runs.map(run => {
                  const schedule = scheduleById.get(run.scheduleId);
                  const zone = schedule?.trigger.kind === 'cron' ? schedule.trigger.timeZone : undefined;
                  const isSelected = selectedRunId === run.id;
                  const deliveryLabel =
                    isSelected && selectedDetail?.run.id === run.id && selectedDetail.deliveries.length > 0
                      ? text.deliveryStates[selectedDetail.deliveries.at(-1)!.state]
                      : undefined;
                  const deliveryTone =
                    isSelected && selectedDetail?.run.id === run.id && selectedDetail.deliveries.length > 0
                      ? deliveryBadgeTone(selectedDetail.deliveries.at(-1)!.state)
                      : 'subtle';
                  return (
                    <article
                      key={run.id}
                      className={`card schedule-run-row${isSelected ? ' is-selected' : ''}`}
                      data-testid={`schedule-run-row-${run.id}`}
                    >
                      <div className="card-head">
                        <div>
                          <div className="schedule-run-badges">
                            {schedule && (
                              <span className="badge subtle">
                                {text.scheduleStateBadge(text.states[schedule.state])}
                              </span>
                            )}
                            <span className={`badge ${runStateBadgeTone(run.state)}`}>
                              {text.runStates[run.state]}
                            </span>
                            <span className={`badge ${verificationBadgeTone(run.verification)}`}>
                              {text.verificationStates[run.verification]}
                            </span>
                            {deliveryLabel && (
                              <span className={`badge ${deliveryTone}`}>{deliveryLabel}</span>
                            )}
                          </div>
                          <p className="muted small schedule-run-meta">
                            <strong>{schedule?.name ?? run.scheduleId}</strong> · {text.occurrenceKinds[run.occurrenceKind]} ·{' '}
                            {formatTimestampInZone(run.scheduledFor, zone)} · {text.fieldAttempts}: {run.attemptCount}
                          </p>
                          {run.statusReason && (
                            <p className="muted small">{run.statusReason}</p>
                          )}
                        </div>
                        <div className="row-actions">
                          {run.sessionId && (
                            <button
                              type="button"
                              className="button small"
                              onClick={() => onOpenSession(run.sessionId!, run.workspaceId)}
                            >
                              <Icon name="chat" />
                              {text.openSession}
                            </button>
                          )}
                          <button
                            type="button"
                            className="button small"
                            aria-expanded={isSelected}
                            data-testid={`schedule-inspect-run-${run.id}`}
                            onClick={() => (isSelected ? onCloseDetail() : onSelectRun(run))}
                          >
                            <Icon name="eye" />
                            {isSelected ? text.closeRunDetail : text.inspectRun}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {nextCursor && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="button small"
                    disabled={loadingMore}
                    onClick={onLoadMore}
                  >
                    {text.loadMoreRuns}
                  </button>
                </div>
              )}
            </>
          )}

          {selectedRunId && (
            <ScheduleRunDetailCard
              text={text}
              detail={effectiveDetail}
              schedule={effectiveDetail ? scheduleById.get(effectiveDetail.run.scheduleId) : undefined}
              loading={detailLoading && !effectiveDetail}
              reviewBusy={reviewBusy}
              reviewError={reviewError}
              onClose={onCloseDetail}
              onOpenSession={onOpenSession}
              onReviewUnknownRun={onReviewUnknownRun}
            />
          )}
        </>
      )}
    </section>
  );
}
