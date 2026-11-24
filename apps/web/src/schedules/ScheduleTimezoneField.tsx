import { isValidIanaTimeZone, type NextRunPreview } from '@extalia/platform';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import {
  COMMON_SCHEDULE_TIMEZONES,
  CUSTOM_TIMEZONE_OPTION,
  HOST_FALLBACK_TIMEZONE_OPTION,
  buildTimeZoneSelectOptions,
} from './scheduleFormatting';

export function ScheduleTimezoneField({
  text,
  timeZone,
  hostZone,
  isLegacyNoZone,
  disabled,
  onChangeTimeZone,
}: {
  text: Messages['schedules'];
  timeZone: string;
  hostZone?: string;
  isLegacyNoZone: boolean;
  disabled?: boolean;
  onChangeTimeZone(next: string): void;
}) {
  const trimmed = timeZone.trim();
  const isPresetZone =
    Boolean(trimmed) &&
    ((hostZone && trimmed === hostZone) || (COMMON_SCHEDULE_TIMEZONES as readonly string[]).includes(trimmed));
  const selectValue =
    !trimmed && isLegacyNoZone
      ? HOST_FALLBACK_TIMEZONE_OPTION
      : isPresetZone
        ? trimmed
        : CUSTOM_TIMEZONE_OPTION;
  const options = buildTimeZoneSelectOptions(hostZone, text, isLegacyNoZone);
  const valid = trimmed === '' ? isLegacyNoZone : isValidIanaTimeZone(trimmed);
  const errorId = 'schedule-timezone-error';

  return (
    <div className="schedule-timezone-section" data-testid="schedule-timezone-field">
      <div className="form-grid">
        <Select
          label={text.timeZoneLabel}
          value={selectValue}
          options={options}
          disabled={disabled}
          onChange={value => {
            if (value === HOST_FALLBACK_TIMEZONE_OPTION) onChangeTimeZone('');
            else if (value === CUSTOM_TIMEZONE_OPTION) onChangeTimeZone(isPresetZone ? '' : timeZone);
            else onChangeTimeZone(value);
          }}
        />
        <label className="field">
          <span>{text.timeZoneLabel}</span>
          <input
            type="text"
            value={timeZone}
            disabled={disabled}
            placeholder={text.timeZoneCustomPlaceholder}
            aria-invalid={!valid || undefined}
            aria-describedby={!valid ? errorId : undefined}
            data-testid="schedule-timezone-input"
            onChange={event => onChangeTimeZone(event.target.value)}
          />
        </label>
      </div>
      {isLegacyNoZone && trimmed === '' && hostZone && (
        <p className="muted small" data-testid="schedule-timezone-legacy-notice">
          {text.timeZoneLegacyNotice(hostZone)}
        </p>
      )}
      {!valid && (
        <p className="form-error" id={errorId} role="alert" data-testid="schedule-timezone-error">
          <Icon name="alert" />
          <span>{text.timeZoneInvalid}</span>
        </p>
      )}
    </div>
  );
}

export function NextRunsPreviewPanel({
  text,
  preview,
  loading,
  error,
  supported,
}: {
  text: Messages['schedules'];
  preview?: NextRunPreview;
  loading: boolean;
  error: string | null;
  supported: boolean;
}) {
  if (!supported) return null;

  return (
    <section
      className="schedule-preview-box"
      data-testid="schedule-next-runs-preview"
      aria-label={text.nextRunsHeading(preview?.runs.length || 5)}
      aria-live="polite"
    >
      <div className="schedule-preview-head">
        <strong>{text.nextRunsHeading(preview?.runs.length || 5)}</strong>
        {preview && (
          <span className="badge subtle" data-testid="schedule-preview-zone">
            {preview.usedFallbackTimeZone
              ? text.timeZoneHostFallbackBadge(preview.timeZone)
              : text.timeZoneBadge(preview.timeZone)}
          </span>
        )}
      </div>

      {loading && <p className="muted small">{text.nextRunsLoading}</p>}
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      {!loading && !error && preview && (
        <>
          {preview.runs.length === 0 ? (
            <p className="muted small">{text.nextRunsEmpty}</p>
          ) : (
            <ol className="schedule-preview-list">
              {preview.runs.map((entry, index) => (
                <li key={`${entry.utc}-${index}`} className="schedule-preview-item">
                  <div className="schedule-preview-times">
                    <span className="schedule-preview-local">
                      <strong>{text.localLabel}:</strong> {entry.localTime}
                    </span>
                    <span className="muted small">
                      {text.utcLabel}: <code>{entry.utc}</code>
                    </span>
                  </div>
                  <div className="schedule-preview-badges">
                    <span className="badge subtle">{entry.timeZone}</span>
                    {entry.dstNote && (
                      <span className="badge warn" data-testid={`schedule-dst-badge-${entry.dstNote}`}>
                        <Icon name="alert" />
                        {text.dstNotes[entry.dstNote]}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {preview.notes.length > 0 && (
            <ul className="schedule-preview-notes muted small">
              {preview.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
