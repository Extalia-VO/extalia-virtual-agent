import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

/** Keep the current view visible while the host is unavailable. */
export function HostConnectionBanner({ t, error, desktop, onRetry }: {
  t: Messages; error: string | null; desktop: boolean; onRetry(): void;
}) {
  if (!error) return null;
  return <section className="host-connection-banner" role="alert">
    <Icon name="alert" />
    <div className="host-connection-text">
      <strong>{t.hostConnection.title}</strong>
      <span>{desktop ? t.hostConnection.desktop : t.hostConnection.bridge}</span>
      <span className="muted">{t.hostConnection.snapshot}</span>
    </div>
    <div className="host-connection-actions">
      <button type="button" className="button small" onClick={onRetry}>{t.common.retry}</button>
      {!desktop && <button type="button" className="button small secondary" onClick={() => window.location.reload()}>{t.restart.reloadPage}</button>}
    </div>
  </section>;
}
