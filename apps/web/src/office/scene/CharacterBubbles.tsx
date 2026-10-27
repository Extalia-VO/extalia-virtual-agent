import { useEffect, useState, useSyncExternalStore } from 'react';
import { Html } from '@react-three/drei';
import type { OfficeActivity } from '../activityFeed';
import type { OfficeAgent } from '../presence';
import type { FurnishedOfficeView } from './FurnishedFloors';
import type { OfficeAgentAllocation } from './interior/seating';
import { bubbleCharacters, quietCharacters, selectBubbles, trackArrivals } from './bubbles';
import { semanticBubble } from '../semanticBubble';
import { MESSAGES, type Language } from '../../i18n';
import { Icon } from '../../ui/Icon';
import { LiveAnchor } from './movement/LiveAnchor';
import type { CharacterPositionSource } from './movement/positionStore';
import { characterCallouts, type CalloutStore } from './callouts';

/**
 * Live speech/activity anchored to source characters (at their live position when walking). History does not replay on mount.
 * Bubbles show only the semantic phrase for the activity, never the raw command or path.
 */
export function CharacterBubbles({ activities, agents, allocations, view, selectedId, reducedMotion, positions, language, callouts = characterCallouts }: {
  activities: readonly OfficeActivity[]; agents: readonly OfficeAgent[]; allocations: readonly OfficeAgentAllocation[];
  view: FurnishedOfficeView; selectedId: string | null; reducedMotion: boolean;
  positions?: CharacterPositionSource | undefined; language: Language;
  /** v0.0.38: quick replies when a character is picked on the board (shown even while it walks). */
  callouts?: CalloutStore;
}) {
  useSyncExternalStore(callouts.subscribe, callouts.version);
  const [now, setNow] = useState(() => Date.now());
  const [arrivals, setArrivals] = useState<ReadonlyMap<string, number>>(() => trackArrivals(undefined, activities, Date.now()));
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const tick = Date.now();
      setNow(tick);
      setArrivals(current => trackArrivals(current, activities, tick));
    });
    return () => cancelAnimationFrame(frame);
  }, [activities]);
  const hasActiveAgent = agents.some(agent => agent.status === 'thinking' || agent.status === 'working' || agent.status === 'delegating' || agent.status === 'waiting' || agent.status === 'blocked');
  useEffect(() => {
    if (!activities.length && !hasActiveAgent) return;
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, [activities.length, hasActiveAgent]);
  // Characters on the stairs or in an elevator count for the floor they are on now.
  const floors = positions ? allocations.map(seat => ({ agentId: seat.agentId, floor: positions.floor(seat.agentId) ?? seat.floor })) : allocations;
  const bubbles = selectBubbles({
    activities,
    arrivals,
    now,
    visible: bubbleCharacters(floors, view),
    quiet: quietCharacters(agents),
    agents,
    selectedId,
    fadeMs: reducedMotion ? 0 : 380,
  });
  const t = MESSAGES[language];
  return <group>{allocations.map(seat => {
    const name = agents.find(agent => agent.id === seat.agentId)?.displayName;
    // Above a standing head while walking, above a seated one at the desk.
    const height = positions?.moving(seat.agentId) ? 2.1 : 1.75;
    // A board pick's reply takes the place of the activity bubble for its few seconds.
    const callout = callouts.current(seat.agentId);
    if (callout) return <LiveAnchor key={seat.agentId} source={positions} id={seat.agentId} fallback={seat.position}>
      <Html position={[0, height, 0]} center zIndexRange={[19, 13]} style={{ pointerEvents: 'none' }}>
        <div key={callout.key} className={`office-character-callout ${reducedMotion ? 'reduced' : ''}`} role="status" aria-label={name ? `${name}: ${callout.text}` : callout.text}>
          <span>{callout.text}</span>
        </div>
      </Html>
    </LiveAnchor>;
    const bubble = bubbles.get(seat.agentId);
    const phrase = bubble && semanticBubble(bubble.activity, t);
    if (!bubble || !phrase) return null;
    return <LiveAnchor key={seat.agentId} source={positions} id={seat.agentId} fallback={seat.position}>
      <Html position={[0, height, 0]} center zIndexRange={[18, 12]} style={{ pointerEvents: 'none' }}>
        <div className={`office-character-bubble tone-${bubble.tone} ${bubble.fading ? 'fading' : ''}`} aria-label={name}>
          {bubble.icon && <Icon name={bubble.icon} />}<span>{phrase}</span>
        </div>
      </Html>
    </LiveAnchor>;
  })}</group>;
}
