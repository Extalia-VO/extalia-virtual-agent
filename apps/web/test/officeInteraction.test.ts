import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { dockCharacterPopover, placeCharacterPopover, popoverState, popoverSummary, type Rect } from '../src/office/overlay/popoverModel';
import { initialOfficeSelection, officeSelectionReducer, type OfficeSelectionAction, type OfficeSelectionState } from '../src/office/overlay/officeSelection';

const t = MESSAGES.en;
const run = (actions: OfficeSelectionAction[], from: OfficeSelectionState = initialOfficeSelection) => actions.reduce(officeSelectionReducer, from);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('character card state and summary', () => {
  it('normalizes presence status to four states', () => {
    expect(popoverState({ status: 'working' })).toBe('working');
    expect(popoverState({ status: 'thinking' })).toBe('working');
    expect(popoverState({ status: 'waiting' })).toBe('waiting');
    expect(popoverState({ status: 'idle', pendingApprovalId: 'a1' })).toBe('waiting');
    expect(popoverState({ status: 'idle' })).toBe('idle');
    expect(popoverState({ status: 'idle' }, true)).toBe('break');
    // Someone working at a lounge seat is still working.
    expect(popoverState({ status: 'working' }, true)).toBe('working');
    expect(popoverState({ status: 'observing' })).toBe('idle');
  });

  it('says what a character does without paths or commands', () => {
    expect(popoverSummary(t, { status: 'working', activity: 'command' })).toBe(t.characterPopover.summary.activity.command);
    expect(popoverSummary(t, { status: 'working', activity: 'edit' })).toBe('Editing files');
    expect(popoverSummary(t, { status: 'thinking' })).toBe(t.characterPopover.summary.thinking);
    expect(popoverSummary(t, { status: 'idle', pendingApprovalId: 'a' })).toBe(t.characterPopover.summary.approval);
    expect(popoverSummary(t, { status: 'idle' }, true)).toBe(t.characterPopover.summary.break);
    expect(popoverSummary(MESSAGES.id, { status: 'offline' })).toBe(MESSAGES.id.characterPopover.summary.offline);
  });
});

describe('character card placement', () => {
  const size = [300, 200] as const;
  const viewport = [1200, 700] as const;

  it('sits above the head when there is room, pointing at the character', () => {
    const placement = placeCharacterPopover([500, 400], [500, 460], size, viewport);
    expect(placement.side).toBe('above');
    expect(placement.y + size[1]).toBeLessThanOrEqual(400);
    expect(placement.x + placement.arrow).toBe(500);
  });

  it('goes below the feet near the top edge', () => {
    const placement = placeCharacterPopover([500, 60], [500, 120], size, viewport);
    expect(placement.side).toBe('below');
    expect(placement.y).toBeGreaterThanOrEqual(120);
  });

  it('stays inside the stage at the edges', () => {
    const placement = placeCharacterPopover([5, 400], [5, 460], size, viewport);
    expect(placement.x).toBeGreaterThanOrEqual(8);
    expect(placement.arrow).toBeGreaterThanOrEqual(18);
  });

  it('avoids other overlays, then picks the side covering least', () => {
    const panel: Rect = { x: 350, y: 0, width: 400, height: 380 };
    const placement = placeCharacterPopover([500, 400], [500, 460], size, viewport, { obstacles: [panel] });
    expect(placement.side).not.toBe('above');
    expect(overlaps({ x: placement.x, y: placement.y, width: size[0], height: size[1] }, panel)).toBe(false);
    // Nowhere free: still a placement inside the stage.
    const everywhere: Rect = { x: 0, y: 0, width: 1200, height: 700 };
    const forced = placeCharacterPopover([500, 400], [500, 460], size, viewport, { obstacles: [everywhere] });
    expect(forced.x).toBeGreaterThanOrEqual(8);
    expect(forced.y).toBeGreaterThanOrEqual(8);
  });

  it('never covers the character it points at', () => {
    // A tall character in a short stage: above and below both clip, so the card goes beside it.
    const placement = placeCharacterPopover([600, 120], [600, 600], size, [1200, 720]);
    expect(['right', 'left']).toContain(placement.side);
    const card = { x: placement.x, y: placement.y, width: size[0], height: size[1] };
    expect(overlaps(card, { x: 590, y: 120, width: 20, height: 480 })).toBe(false);
  });

  it('docks at the top, away from overlays, when the character is out of view', () => {
    expect(dockCharacterPopover(size, viewport)).toMatchObject({ side: 'docked', x: 450, y: 8 });
    const docked = dockCharacterPopover(size, viewport, { obstacles: [{ x: 400, y: 0, width: 400, height: 220 }] });
    expect(docked.x).toBe(8);
  });
});

describe('office selection and session dialog', () => {
  it('opens the card on an avatar click without touching the board', () => {
    const state = run([{ type: 'pick', characterId: 's1:primary' }]);
    expect(state).toMatchObject({ characterId: 's1:primary', popoverOpen: true, boardCollapsed: false, dialog: null });
  });

  it('collapses the board for the dialog and restores it on close', () => {
    const open = run([{ type: 'openDialog', sessionId: 's1', characterId: 's1:primary', tab: 'messages', returnFocus: 'row:s1:primary' }]);
    expect(open.boardCollapsed).toBe(true);
    expect(open.dialog).toMatchObject({ boardCollapsedBefore: false, returnFocus: 'row:s1:primary' });
    expect(run([{ type: 'closeDialog' }], open).boardCollapsed).toBe(false);
    // A board the user had collapsed stays collapsed.
    const collapsed = run([{ type: 'toggleBoard' }, { type: 'openDialog', sessionId: 's1', characterId: 's1:primary', tab: 'messages', returnFocus: null }, { type: 'closeDialog' }]);
    expect(collapsed.boardCollapsed).toBe(true);
  });

  it('keeps a single dialog and the original restore target', () => {
    const state = run([
      { type: 'openDialog', sessionId: 's1', characterId: 's1:primary', tab: 'messages', returnFocus: 'row:s1:primary' },
      { type: 'openDialog', sessionId: 's1', characterId: 's1:worker', tab: 'activity', returnFocus: null },
    ]);
    expect(state.dialog).toEqual({ sessionId: 's1', characterId: 's1:worker', tab: 'activity', returnFocus: 'row:s1:primary', boardCollapsedBefore: false });
    expect(run([{ type: 'closeDialog' }], state)).toMatchObject({ dialog: null, boardCollapsed: false });
  });

  it('keeps the card and the dialog separate', () => {
    const state = run([
      { type: 'pick', characterId: 's1:primary' },
      { type: 'openDialog', sessionId: 's1', characterId: 's1:primary', tab: 'activity', returnFocus: 'popover:activity' },
      { type: 'setTab', tab: 'messages' },
      { type: 'closeDialog' },
    ]);
    expect(state).toMatchObject({ characterId: 's1:primary', popoverOpen: true, dialog: null });
    expect(run([{ type: 'closePopover' }], state)).toMatchObject({ characterId: 's1:primary', popoverOpen: false });
  });

  it('drops the selection of a character that left, but not an open dialog', () => {
    const state = run([
      { type: 'pick', characterId: 's1:primary' },
      { type: 'openDialog', sessionId: 's1', characterId: 's1:primary', tab: 'messages', returnFocus: null },
      { type: 'prune', present: new Set() },
    ]);
    expect(state.characterId).toBeNull();
    expect(state.popoverOpen).toBe(false);
    expect(state.dialog?.sessionId).toBe('s1');
  });

  it('returns the same state for no-op actions', () => {
    const state = run([{ type: 'pick', characterId: 'a' }]);
    expect(officeSelectionReducer(state, { type: 'pick', characterId: 'a' })).toBe(state);
    expect(officeSelectionReducer(initialOfficeSelection, { type: 'closeDialog' })).toBe(initialOfficeSelection);
    expect(officeSelectionReducer(state, { type: 'prune', present: new Set(['a']) })).toBe(state);
  });
});
