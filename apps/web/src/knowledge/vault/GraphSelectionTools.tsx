import type { Messages } from '../../i18n';
import type { FocusHops, GraphFocus } from './graphFocus';

/** Only mount beside note content that is visible in the final graph mask. */
export function GraphSelectionTools({ t, title, focused, onFocus, onClose }: {
  t: Messages; title: string; focused: boolean; onFocus: () => void; onClose: () => void;
}) {
  const k = t.knowledge.vaultGraph;
  return <div className="graph-selection-tools">
    <button type="button" className="chip-button" aria-pressed={focused}
      title={k.focusSelectedTitle(title)} onClick={onFocus}>{k.focusSelected}</button>
    <button type="button" className="chip-button" onClick={onClose}>{k.closeFilteredNote}</button>
  </div>;
}

/** Focus remains recoverable even when appearance controls or the note panel are closed. */
export function GraphFocusTrail({ t, status, rootTitle, hops, onHops, onClear }: {
  t: Messages; status: GraphFocus['status']; rootTitle: string | null; hops: FocusHops;
  onHops: (hops: FocusHops) => void; onClear: () => void;
}) {
  if (status === 'none') return null;
  const k = t.knowledge.vaultGraph;
  // A stale remembered title is never displayed for a filtered or removed note.
  const message = status === 'missing' ? k.focusMissingNote
    : status === 'filtered' ? k.focusFilteredNote
      : k.focusOn(rootTitle ?? k.focus);
  return <div className="graph-focus-trail" role="group" aria-label={k.focus}>
    <p role="status">{message}</p>
    <div className="segmented" role="group" aria-label={k.focusDepth}>
      {([1, 2, 3] as const).map(depth => <button key={depth} type="button" className="chip-button"
        aria-pressed={hops === depth} onClick={() => onHops(depth)}>{k.focusHops(depth)}</button>)}
    </div>
    <button type="button" className="chip-button" onClick={onClear}>{k.clearFocus}</button>
  </div>;
}
