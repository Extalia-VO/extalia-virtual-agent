import type { UpdateCapability, UpdateStatus } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { RestartTimeoutError } from '../host/bridgeHost';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { CommandLine } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';

export function useUpdateStatus(updater: UpdateCapability | undefined): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => updater?.onStatus(setStatus), [updater]);
  return status;
}

/** Seconds left of a scheduled restart, counted down locally between host updates. */
function useCountdown(seconds: number | undefined): number | undefined {
  const [left, setLeft] = useState<{ from: number | undefined; value: number | undefined }>({ from: seconds, value: seconds });
  // Restart the countdown whenever the host reports a new value.
  const current = left.from === seconds ? left.value : seconds;
  if (left.from !== seconds) setLeft({ from: seconds, value: seconds });
  useEffect(() => {
    if (seconds === undefined) return;
    const timer = setInterval(() => setLeft(previous => ({ ...previous, value: Math.max(0, (previous.value ?? 0) - 1) })), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  return current;
}

function useInstall(updater: UpdateCapability | undefined, t: Messages) {
  const [error, setError] = useState<string | null>(null);
  const install = () => {
    setError(null);
    updater?.install().catch(failure => setError(failure instanceof RestartTimeoutError ? t.updates.restartFailed : errorMessage(failure)));
  };
  return { error, install };
}

/** Slim banner for an available or downloaded update; hidden when there is nothing to do. */
export function UpdateBanner({ t, updater, status }: { t: Messages; updater: UpdateCapability | undefined; status: UpdateStatus | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const countdown = useCountdown(status?.state === 'ready' ? status.restartInSeconds : undefined);
  const { error, install } = useInstall(updater, t);
  if (!status || !updater) return null;
  const version = status.latest ?? '';
  const key = `${status.state}:${version}`;
  const visible = (['available', 'downloading', 'ready', 'installing'] as const).includes(status.state as 'available') && dismissed !== key;
  if (!visible) return null;

  const later = () => {
    if (status.restartInSeconds !== undefined) void updater.postpone().catch(() => undefined);
    setDismissed(key);
  };

  let text: string;
  let action: string | undefined;
  switch (status.state) {
    case 'available': text = t.updates.banner.available(version); action = t.updates.banner.update; break;
    case 'downloading': text = t.updates.banner.downloading(version, Math.round((status.progress ?? 0) * 100)); break;
    case 'ready':
      text = `${t.updates.banner.ready(version)}${countdown !== undefined ? ` ${t.updates.banner.restartIn(countdown)}` : ''}`;
      action = t.updates.banner.restart;
      break;
    default: text = t.updates.banner.installing;
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <Icon name="download" />
      <span className="update-text">{error ?? text}</span>
      {status.state === 'downloading' && <progress max={1} value={status.progress ?? 0} aria-label={text} />}
      {action && (
        <span className="update-actions">
          <button type="button" className="link-button strong" onClick={install}>{action}</button>
          <span aria-hidden="true">·</span>
          <button type="button" className="link-button" onClick={later}>{t.updates.banner.later}</button>
        </span>
      )}
    </div>
  );
}

/** Settings section with the full update state and manual controls. */
export function UpdatesSection({ t, updater, status }: { t: Messages; updater: UpdateCapability; status: UpdateStatus | null }) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { error, install } = useInstall(updater, t);
  const check = () => {
    setChecking(true);
    setCheckError(null);
    updater.check().catch(failure => setCheckError(errorMessage(failure))).finally(() => setChecking(false));
  };
  const state = status?.state ?? 'idle';
  const canInstall = state === 'available' || state === 'ready';
  const problem = error ?? checkError ?? (state === 'error' || state === 'unsupported' ? status?.detail : undefined);

  return (
    <section className="card settings-section" aria-labelledby="settings-updates">
      <h2 id="settings-updates">{t.updates.title}</h2>
      <p className="muted small">{t.updates.lead}</p>
      <dl className="facts">
        <div><dt>{t.updates.current}</dt><dd>{status?.current ?? '—'}</dd></div>
        <div><dt>{t.updates.latest}</dt><dd>{status?.latest ?? '—'}</dd></div>
        <div><dt>{t.updates.state}</dt><dd role="status">{t.updates.states[state]}{state === 'downloading' && status?.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : ''}</dd></div>
      </dl>
      {problem && <p className="form-error"><Icon name="alert" />{problem}</p>}
      <div className="actions">
        <button type="button" disabled={checking || state === 'checking' || state === 'installing' || state === 'unsupported'} onClick={check}>
          <Icon name="refresh" className={checking ? 'spin' : ''} />{t.updates.check}
        </button>
        {canInstall && <button type="button" className="primary" onClick={install}><Icon name="download" />{t.updates.install}</button>}
      </div>
      {status?.command && (
        <div className="form-stack tight top-gap">
          <p className="muted small">{t.updates.commandHint}</p>
          <CommandLine command={status.command} />
        </div>
      )}
    </section>
  );
}
