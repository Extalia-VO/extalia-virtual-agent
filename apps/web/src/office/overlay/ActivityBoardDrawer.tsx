import type { Messages } from '../../i18n';
import { Icon, type IconName } from '../../ui/Icon';
import type { OfficeActivity } from '../activityFeed';
import { formatAgo, timeAgo } from './activityBoard';

const ICON: Record<OfficeActivity['kind'], IconName> = {
  prompt: 'chat', reply: 'chat', tool: 'tool', approval: 'shield', delegated: 'users', done: 'check', failed: 'alert',
};

/**
 * "Recent activity": a left-side drawer of what characters did lately, newest
 * first. Clicking an item shows its character in the office.
 */
export function ActivityBoard({ t, id, items, names, now, onSelect, onClose }: {
  t: Messages; id: string; items: readonly OfficeActivity[]; names: ReadonlyMap<string, string>; now: number;
  onSelect(characterId: string): void; onClose(): void;
}) {
  const o = t.officeOverlay;
  return <section className="office-board" id={id} aria-label={o.board.title}>
    <div className="office-board-head">
      <strong>{o.board.title}</strong><span className="badge">{items.length}</span>
      <button type="button" className="icon-button small" aria-label={o.board.close} onClick={onClose}><Icon name="close" /></button>
    </div>
    {items.length === 0 ? <p className="office-board-empty">{o.board.empty}</p> : <ol className="office-board-list">
      {items.map(activity => {
        const name = names.get(activity.characterId) ?? activity.characterId;
        return <li key={activity.id}>
          <button type="button" className={`office-board-item kind-${activity.kind}`} title={o.board.open(name)} onClick={() => onSelect(activity.characterId)}>
            <Icon name={ICON[activity.kind]} />
            <span className="office-board-text">
              <span className="office-board-line"><strong>{name}</strong><time dateTime={activity.at}>{formatAgo(o.ago, timeAgo(activity.at, now))}</time></span>
              <small>{t.officeUx.toast[activity.kind]}{activity.text ? ` · ${activity.text}` : ''}</small>
            </span>
          </button>
        </li>;
      })}
    </ol>}
  </section>;
}
