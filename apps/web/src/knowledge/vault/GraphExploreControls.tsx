import type { Messages } from '../../i18n';
import type { GraphExploreProjection } from './graphExplore';

export interface ExploreNote { nodeId: string; title: string }
export interface GraphExploreControlsProps {
  t: Messages;
  status: GraphExploreProjection['status'];
  currentTitle: string | null;
  trail: readonly ExploreNote[];
  neighbours: readonly ExploreNote[];
  canGoBack: boolean;
  onBack: () => void;
  onRelease: () => void;
  onExit: () => void;
  onNavigate: (nodeId: string) => void;
  onOpen: () => void;
}

/** DOM navigation remains usable when the canvas cannot create a WebGL context. */
export function GraphExploreControls({ t, status, currentTitle, trail, neighbours, canGoBack, onBack, onRelease, onExit, onNavigate, onOpen }: GraphExploreControlsProps) {
  if (status === 'off') return null;
  const k = t.knowledge.vaultGraph;
  const active = status === 'active' && currentTitle !== null;
  const message = status === 'missing' ? k.exploreMissing : status === 'filtered' ? k.exploreFiltered
    : active ? k.exploreCurrent(currentTitle) : k.exploreChoose;
  return <section className="graph-explore-controls" aria-label={k.explore}>
    <div className="graph-explore-header">
      <p role="status">{message}</p>
      <div className="graph-explore-actions">
        <button type="button" className="chip-button" disabled={!canGoBack} onClick={onBack}>{k.exploreBack}</button>
        {status !== 'choosing' && <button type="button" className="chip-button" onClick={onRelease}>{k.exploreRelease}</button>}
        {active && <button type="button" className="chip-button" onClick={onOpen}>{k.exploreOpen}</button>}
        <button type="button" className="chip-button" onClick={onExit}>{k.exploreExit}</button>
      </div>
    </div>
    {active && trail.length > 0 && <ol className="graph-explore-trail" aria-label={k.exploreTrail}>
      {trail.map((note, index) => <li key={`${index}-${note.nodeId}`} aria-current={index === trail.length - 1 ? 'step' : undefined}>{note.title}</li>)}
    </ol>}
    {active && <div className="graph-explore-neighbours" role="group" aria-label={k.exploreNeighbours}>
      <span className="muted small">{k.exploreNeighbours}</span>
      {neighbours.length ? neighbours.map(note => <button key={note.nodeId} type="button" className="chip-button"
        aria-label={k.exploreTravel(note.title)} onClick={() => onNavigate(note.nodeId)}>{note.title}</button>)
        : <span className="muted small">{k.exploreNoNeighbours}</span>}
    </div>}
    <p className="muted small graph-explore-help">{active ? k.exploreHint : k.exploreChooseHint}</p>
  </section>;
}
