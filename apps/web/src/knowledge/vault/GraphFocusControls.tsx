import type { Messages } from '../../i18n';
import type { FocusHops, GraphFocus } from './graphFocus';

export interface GraphFocusControlsProps {
  t: Messages;
  selectedTitle: string | null;
  rootTitle: string | null;
  status: GraphFocus['status'];
  hops: FocusHops;
  onFocus: () => void;
  onClear: () => void;
  onHops: (hops: FocusHops) => void;
}

/** The same explicit focus controls work with the 3D canvas and the accessible list. */
export function GraphFocusControls({ t, selectedTitle, rootTitle, status, hops, onFocus, onClear, onHops }: GraphFocusControlsProps) {
  const k = t.knowledge.vaultGraph;
  return (
    <div className="vault-graph-focus" role="group" aria-label={k.focus}>
      <button type="button" className="chip-button" disabled={selectedTitle === null}
        title={selectedTitle === null ? k.focusHint : k.focusSelectedTitle(selectedTitle)} onClick={onFocus}>{k.focusSelected}</button>
      {rootTitle !== null && <>
        <div className="segmented" role="group" aria-label={k.focusDepth}>
          {([1, 2, 3] as const).map(depth => <button key={depth} type="button" className="chip-button" aria-pressed={hops === depth}
            onClick={() => onHops(depth)}>{k.focusHops(depth)}</button>)}
        </div>
        <button type="button" className="chip-button" onClick={onClear}>{k.clearFocus}</button>
      </>}
      <p className="muted small" role="status">{rootTitle === null ? k.focusHint
        : status === 'missing' ? k.focusMissing(rootTitle)
          : status === 'filtered' ? k.focusFiltered(rootTitle) : k.focusOn(rootTitle)}</p>
    </div>
  );
}
