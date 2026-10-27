import { walkingClearanceFor } from './naturalClearance';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { OfficeAgent } from '../../presence';
import type { Point3 } from '../layout';
import type { FurnishedOfficeView } from '../FurnishedFloors';
import type { OfficeAgentAllocation } from '../interior/seating';
import { OfficeCharacter, type CharacterAppearance } from '../avatars/OfficeCharacter';
import { deskReachForSeat } from '../avatars/deskReach';
import { gaitParameters } from '../avatars/gait';
import { CharacterTag } from '../CharacterTag';
import { useHoverReveal } from '../hoverReveal';
import { DestinationGuideLine } from './DestinationGuideLine';
import { applyCharacterOpacity } from './fade';
import { MovementDirector, visibleOnFloor } from './director';
import type { Mover } from './mover';
import { liveElevatorAccess } from './elevatorAccess';
import { clearFitnessPresence, publishFitnessPresence } from '../interior/fitnessMechanics';
import { getNearbyMovingOccupantsSnapshot, trackMovingOccupant, trackStationaryOccupant } from '../interior/occupants/movingOccupants';
import { doorTraffic } from '../interior/doorTrafficRegistry';
import { officeNavigation } from './navGraph';
import type { CharacterPositionStore } from './positionStore';

const ORIGIN: Point3 = [0, 0, 0];

/** One movement director per mounted Office; optionally exposed through a page-owned position store. */
export function useMovementDirector(store?: CharacterPositionStore): MovementDirector {
  const director = useMemo(() => {
    const instance: MovementDirector = new MovementDirector({ navigation: officeNavigation(), elevators: liveElevatorAccess,
      trackWalker: trackMovingOccupant, trackBody: trackStationaryOccupant, doors: doorTraffic,
      walkable: (from, to, radius) => walkingClearanceFor(instance).segmentClear(from, to, radius),
      seatContactClear: (seat, from, to, radius) => walkingClearanceFor(instance).seatContactClear(seat, from, to, radius),
      nearbyWalkers: getNearbyMovingOccupantsSnapshot });
    return instance;
  }, []);
  useEffect(() => {
    if (!store) return;
    store.bind(director);
    return () => store.bind(null);
  }, [store, director]);
  useEffect(() => {
    // Development inspection hook for headless checks of walking characters.
    if (import.meta.env.DEV) (window as { __EXTALIA_OFFICE_MOVEMENT__?: MovementDirector }).__EXTALIA_OFFICE_MOVEMENT__ = director;
    if (import.meta.env.DEV) (window as { __EXTALIA_DOORS__?: typeof doorTraffic }).__EXTALIA_DOORS__ = doorTraffic;
    return () => director.dispose();
  }, [director]);
  return director;
}

const inView = (view: FurnishedOfficeView, low: number, high: number) => view === 'stack' || (typeof view === 'number' && view >= low && view <= high);

/**
 * Characters at their live positions: walking in, sitting, walking out. Each
 * frame moves existing Three.js groups only; React renders again just for
 * arrivals, departures, sit/stand and floor changes.
 */
export function OfficeOccupants({ director, allocations, agents, appearances, view, selectedId, onSelect, reducedMotion }: {
  director: MovementDirector;
  allocations: readonly OfficeAgentAllocation[];
  agents: readonly OfficeAgent[];
  appearances?: Readonly<Record<string, CharacterAppearance>> | undefined;
  view: FurnishedOfficeView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reducedMotion: boolean;
}) {
  const gaitOf = useCallback((id: string) => {
    const look = appearances?.[id];
    return gaitParameters(look ? { gait: look.gait, ...(look.heightCm !== undefined ? { heightCm: look.heightCm } : {}) } : undefined);
  }, [appearances]);
  useLayoutEffect(() => {
    director.update({ allocations, agents, reducedMotion, gaitOf });
  }, [director, allocations, agents, reducedMotion, gaitOf]);
  useSyncExternalStore(director.subscribe, director.version);
  const groups = useRef(new Map<string, Group>());
  useEffect(() => () => clearFitnessPresence(director), [director]);
  // Publish movement before furniture transforms and avatar IK consume it.
  useFrame((_, delta) => {
    director.tick(delta);
    const list = director.list;
    publishFitnessPresence(director, list);
    for (let index = 0; index < list.length; index++) {
      const mover = list[index]!;
      const group = groups.current.get(mover.id);
      if (!group) continue;
      group.position.set(mover.position[0], mover.position[1], mover.position[2]);
      group.rotation.y = mover.yaw;
      group.visible = mover.opacity > 0 && (view === 'campus' || view === 'stack' || visibleOnFloor(mover, view));
      // Arrivals fade in at their arrival point, departures fade out at their exit.
      applyCharacterOpacity(group, mover.opacity);
    }
  }, -1);
  const byId = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const register = useCallback((id: string, group: Group | null) => {
    if (group) groups.current.set(id, group); else groups.current.delete(id);
  }, []);
  return <>{director.roster().map(({ mover, agent: lastKnown }) => {
    const agent = byId.get(mover.id) ?? lastKnown;
    return <MovingCharacter key={agent.id} mover={mover} agent={agent} seated={MovementDirector.seatedPose(mover)}
      shown={view === 'campus' || view === 'stack' || visibleOnFloor(mover, view)}
      tagged={view !== 'campus' && inView(view, mover.floorLow, mover.floorHigh)}
      selected={agent.id === selectedId} onSelect={onSelect} reducedMotion={reducedMotion} appearance={appearances?.[agent.id]} register={register} />;
  })}
  <DestinationGuideLine director={director} selectedId={selectedId} view={view} /></>;
}

/** One character; re-renders only when its own pose, tag or presence data changes. */
const MovingCharacter = memo(function MovingCharacter({ mover, agent, seated, shown, tagged, selected, onSelect, reducedMotion, appearance, register }: {
  mover: Mover; agent: OfficeAgent; seated: boolean; shown: boolean; tagged: boolean; selected: boolean;
  onSelect: (id: string) => void; reducedMotion: boolean; appearance: CharacterAppearance | undefined;
  register: (id: string, group: Group | null) => void;
}) {
  const id = agent.id;
  const ref = useCallback((group: Group | null) => register(id, group), [register, id]);
  const hover = useHoverReveal();
  return <group ref={ref} position={[mover.position[0], mover.position[1], mover.position[2]]} rotation={[0, mover.yaw, 0]} visible={shown}>
    <OfficeCharacter agent={agent} position={ORIGIN} rotationY={0} seated={seated} seatHeight={mover.seat?.seatHeight} seatFront={mover.seat?.seatFront}
      selected={selected} onSelect={onSelect} reducedMotion={reducedMotion} appearance={appearance} motion={mover.motion} resourceId={mover.seat?.seatId} desk={deskReachForSeat(mover.seat?.seatId)}
      onHoverStart={hover.enter} onHoverEnd={hover.leave} />
    {/* Name on pointer hover only, while on the viewed floor; never for selection or follow. */}
    {tagged && <CharacterTag position={ORIGIN} seated={seated} revealed={hover.hovered} name={agent.displayName} />}
  </group>;
});
