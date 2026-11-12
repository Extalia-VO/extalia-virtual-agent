import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import './officeStatus.css';

/** Keep manual camera tracking visible even after its character card closes. */
export function OfficeFollowStatus({ t, name, onStop }: { t: Messages; name: string; onStop(): void }) {
  const label = t.officeUx.followingCharacter(name);
  return <div className="office-follow-status">
    <Icon name="crosshair" />
    <span role="status" title={label}>{label}</span>
    <button type="button" className="icon-button" aria-label={t.officeOverlay.follow.stop} title={t.officeOverlay.follow.stop} onClick={onStop}>
      <Icon name="close" />
    </button>
  </div>;
}
