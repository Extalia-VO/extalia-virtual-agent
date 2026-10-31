/**
 * Office interaction state: the character picked in the scene (with its quick
 * card) and the session dialog are separate. Picking an avatar never touches
 * the agents board; opening the dialog collapses the board and closing it puts
 * the board back the way it was.
 */
export type SessionDialogTab = 'messages' | 'activity' | 'files';

export interface SessionDialogState {
  sessionId: string;
  characterId: string;
  tab: SessionDialogTab;
  /** `data-focus-key` of the control that opened the dialog; focus returns there on close. */
  returnFocus: string | null;
  /** Board state before the dialog opened. */
  boardCollapsedBefore: boolean;
}

export interface OfficeSelectionState {
  /** Highlight and quick card; camera movement requires a separate Locate or Follow request. */
  characterId: string | null;
  popoverOpen: boolean;
  boardCollapsed: boolean;
  /** At most one session dialog exists. */
  dialog: SessionDialogState | null;
}

export type OfficeSelectionAction =
  /** Avatar click or "show in office": select the character and open its card. */
  | { type: 'pick'; characterId: string }
  /** Select without the card (e.g. a session just started from the dock). */
  | { type: 'select'; characterId: string | null }
  | { type: 'closePopover' }
  | { type: 'openDialog'; sessionId: string; characterId: string; tab: SessionDialogTab; returnFocus: string | null }
  | { type: 'setTab'; tab: SessionDialogTab }
  | { type: 'closeDialog' }
  | { type: 'toggleBoard' }
  /** Characters that left the office lose their selection; an open dialog stays and explains instead. */
  | { type: 'prune'; present: ReadonlySet<string> };

export const initialOfficeSelection: OfficeSelectionState = { characterId: null, popoverOpen: false, boardCollapsed: false, dialog: null };

export function officeSelectionReducer(state: OfficeSelectionState, action: OfficeSelectionAction): OfficeSelectionState {
  switch (action.type) {
    case 'pick':
      return state.characterId === action.characterId && state.popoverOpen ? state : { ...state, characterId: action.characterId, popoverOpen: true };
    case 'select':
      return state.characterId === action.characterId && !state.popoverOpen ? state : { ...state, characterId: action.characterId, popoverOpen: false };
    case 'closePopover':
      return state.popoverOpen ? { ...state, popoverOpen: false } : state;
    case 'openDialog': {
      const current = state.dialog;
      // Never a second dialog: retarget the open one and keep what to restore on close.
      if (current) {
        if (current.sessionId === action.sessionId && current.characterId === action.characterId && current.tab === action.tab) return state;
        return { ...state, dialog: { ...current, sessionId: action.sessionId, characterId: action.characterId, tab: action.tab } };
      }
      return {
        ...state, boardCollapsed: true,
        dialog: { sessionId: action.sessionId, characterId: action.characterId, tab: action.tab, returnFocus: action.returnFocus, boardCollapsedBefore: state.boardCollapsed },
      };
    }
    case 'setTab':
      return state.dialog && state.dialog.tab !== action.tab ? { ...state, dialog: { ...state.dialog, tab: action.tab } } : state;
    case 'closeDialog':
      return state.dialog ? { ...state, boardCollapsed: state.dialog.boardCollapsedBefore, dialog: null } : state;
    case 'toggleBoard':
      // While the dialog is open the board stays collapsed; the user's choice applies after it closes.
      return state.dialog
        ? { ...state, dialog: { ...state.dialog, boardCollapsedBefore: !state.dialog.boardCollapsedBefore } }
        : { ...state, boardCollapsed: !state.boardCollapsed };
    case 'prune':
      return state.characterId && !action.present.has(state.characterId) ? { ...state, characterId: null, popoverOpen: false } : state;
  }
}
