import type { UpdateCapability, UpdateStatus } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { RestartTimeoutError } from '../host/bridgeHost';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { CommandLine } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';
import { subscribeUpdateStatus } from './updateStatusFeed';

export function useUpdateStatus(updater: UpdateCapability | undefined): UpdateStatus | null {
  const [snapshot, setSnapshot] = useState<{ updater: UpdateCapability; status: UpdateStatus }>();
  useEffect(() => {
    return updater ? subscribeUpdateStatus(updater, status => setSnapshot({ updater, status })) : undefined;
  }, [updater]);
  return snapshot?.updater === updater ? snapshot?.status ?? null : null;
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

function useInstall(updater: UpdateCapability | undefined, t: Messages, version?: string) {
  const [error, setError] = useState<string | null>(null);
  const install = () => {
    setError(null);
    updater?.install(version).catch(failure => setError(failure instanceof RestartTimeoutError ? t.updates.restartFailed : errorMessage(failure)));
  };
  return { error, install };
}

/** Slim banner for an available or downloaded update; hidden when there is nothing to do. */
export function UpdateBanner({ t, updater, status }: { t: Messages; updater: UpdateCapability | undefined; status: UpdateStatus | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [postponing, setPostponing] = useState(false);
  const [postponeError, setPostponeError] = useState<string>();
  const countdown = useCountdown(status?.state === 'ready' ? status.restartInSeconds : undefined);
  const { error, install } = useInstall(updater, t, status?.latest);
  if (!status || !updater) return null;
  const version = status.latest ?? '';
  const key = `${status.state}:${version}`;
  const visible = ['available', 'downloading', 'ready', 'installing', 'error'].includes(status.state) && Boolean(status.latest) && dismissed !== key;
  if (!visible) return null;

  const later = async () => {
    setPostponeError(undefined);
    if (status.state === 'ready') {
      setPostponing(true);
      try { await updater.postpone(); }
      catch (failure) { setPostponeError(errorMessage(failure)); return; }
      finally { setPostponing(false); }
    }
    setDismissed(key);
  };

  let text: string;
  let action: string | undefined;
  switch (status.state) {
    case 'available': text = t.updates.banner.available(version); action = t.updates.banner.update; break;
    case 'downloading': text = t.updates.banner.downloading(version, Math.round((status.progress ?? 0) * 100)); break;
    case 'ready':
      text = `${t.updates.banner.ready(version)}${countdown !== undefined ? ` ${t.updates.banner.restartIn(countdown)}` : status.detail ? ` ${status.detail}` : ''}`;
      action = t.updates.banner.restart;
      break;
    case 'error': text = status.detail ?? t.updates.states.error; break;
    default: text = t.updates.banner.installing;
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <Icon name="download" />
      <span className="update-text">{postponeError ?? error ?? text}</span>
      {status.state === 'downloading' && <progress max={1} value={status.progress ?? 0} aria-label={text} />}
      {status.state === 'error' && <button type="button" className="link-button strong" onClick={() => void updater.check().catch(() => undefined)}>{t.updates.check}</button>}
      {action && (
        <span className="update-actions">
          <button type="button" className="link-button strong" onClick={install}>{action}</button>
          <span aria-hidden="true">·</span>
          <button type="button" className="link-button" disabled={postponing} onClick={() => void later()}>{t.updates.banner.later}</button>
        </span>
      )}
    </div>
  );
}

/** Settings section with the full update state and manual controls. */
export function UpdatesSection({ t, updater, status }: { t: Messages; updater: UpdateCapability; status: UpdateStatus | null }) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { error, install } = useInstall(updater, t, status?.latest);
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
