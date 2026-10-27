import type { Messages } from '../../i18n';
import { Icon } from '../../ui/Icon';
import type { OfficeAgent } from '../presence';

/** Shown when more characters are present than desks exist: lists who waits instead of dropping them. */
export function OfficeFullNotice({ t, waiting, onSelect }: { t: Messages; waiting: readonly OfficeAgent[]; onSelect(characterId: string): void }) {
  if (!waiting.length) return null;
  const f = t.officeOverlay.full;
  return <div className="office-full" role="status">
    <p className="office-full-title"><Icon name="users" />{f.title(waiting.length)}</p>
    <p className="office-full-lead">{f.lead}</p>
    <ul>{waiting.map(agent => <li key={agent.id}>
      <button type="button" onClick={() => onSelect(agent.id)}><strong>{agent.displayName}</strong><small>{f.waitingDesk}</small></button>
    </li>)}</ul>
  </div>;
}
