import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Messages } from '../../i18n';
import { Icon } from '../../ui/Icon';
import { groupRooms, type OverlayRoom } from './rooms';
import { useDismiss } from './useDismiss';

/** A compact menu of rooms by floor and the outdoor campus; choosing one moves the camera there. */
export function RoomPicker({ t, rooms, current, onPick }: {
  t: Messages; rooms: readonly OverlayRoom[]; current?: string | undefined; onPick(roomId: string): void;
}) {
  const o = t.officeOverlay;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);
  // Focus lands on the current room (or the first one) when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    (items.find(item => item.getAttribute('aria-current') === 'true') ?? items[0])?.focus();
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return <div className="office-room-picker" ref={root}>
    <button ref={trigger} type="button" className="office-tool-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      title={o.rooms.menu} onClick={() => setOpen(value => !value)}>
      <Icon name="pin" /><span>{o.rooms.button}</span>
    </button>
    {open && <div className="office-room-menu" id={menuId} ref={menu} role="menu" aria-label={o.rooms.menu} onKeyDown={onKeyDown}>
      {groupRooms(rooms).map(group => <div key={group.key} role="group" aria-label={group.floor ? o.rooms.floor(group.floor) : o.rooms.outdoor}>
        <p className="office-room-group" aria-hidden="true">{group.floor ? o.rooms.floor(group.floor) : o.rooms.outdoor}</p>
        {group.rooms.map(room => <button key={room.id} type="button" role="menuitem" className="office-room-item" aria-current={room.id === current ? 'true' : undefined}
          onClick={() => { onPick(room.id); setOpen(false); }}>{room.label}</button>)}
      </div>)}
    </div>}
  </div>;
}
