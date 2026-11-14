import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import type { CameraTourCountdown } from './cameraCountdown';
import './autoCameraCountdown.css';

/** A passive warning; the camera director owns both the deadline and visibility. */
export function AutoCameraCountdown({ t, countdown, name }: { t: Messages; countdown: CameraTourCountdown | null; name?: string | undefined }) {
  if (!countdown) return null;
  return <aside className="office-camera-countdown" role="timer" aria-live="off" aria-label={`${t.office.autoCameraNext}: ${name ?? t.office.autoCamera} · ${t.office.autoCameraCountdown(countdown.seconds)}`}>
    <Icon name="monitor" />
    <span className="office-camera-countdown-time">{t.office.autoCameraCountdown(countdown.seconds)}</span>
    {name && <strong title={name}>{name}</strong>}
  </aside>;
}
