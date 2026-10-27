import type { Messages } from '../../i18n';
import { Icon } from '../../ui/Icon';
import { OfficeSearch, type OfficeSearchSource } from './OfficeSearch';
import { RoomPicker } from './RoomPicker';
import type { OverlayRoom } from './rooms';

/** Toolbar controls for finding things: search, the room picker and the activity drawer toggle. */
export function OfficeTools({ t, source, rooms, currentRoom, boardOpen, boardId, boardCount, onAgent, onRoom, onToggleBoard }: {
  t: Messages; source: OfficeSearchSource; rooms: readonly OverlayRoom[]; currentRoom?: string | undefined;
  boardOpen: boolean; boardId: string; boardCount: number;
  onAgent(characterId: string): void; onRoom(roomId: string): void; onToggleBoard(): void;
}) {
  return <>
    <OfficeSearch t={t} source={source} onAgent={onAgent} onRoom={onRoom} />
    <RoomPicker t={t} rooms={rooms} current={currentRoom} onPick={onRoom} />
    <button type="button" className="office-tool-button" aria-pressed={boardOpen} aria-controls={boardOpen ? boardId : undefined} title={t.officeOverlay.board.title} onClick={onToggleBoard}>
      <Icon name="logs" /><span>{t.officeOverlay.board.toggle}</span>{boardCount > 0 && <span className="badge">{boardCount}</span>}
    </button>
  </>;
}
