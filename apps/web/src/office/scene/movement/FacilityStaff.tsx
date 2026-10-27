import { walkingClearanceFor } from './naturalClearance';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { Group } from 'three';
import type { FurnishedOfficeView } from '../FurnishedFloors';
import { CharacterBody } from '../avatars/OfficeCharacter';
import { deskReachForSeat } from '../avatars/deskReach';
import { MESSAGES, type Language } from '../../../i18n';
import { getNearbyMovingOccupantsSnapshot, trackMovingOccupant, trackStationaryOccupant } from '../interior/occupants/movingOccupants';
import { doorTraffic } from '../interior/doorTrafficRegistry';
import { visibleOnFloor, type MovementDirector } from './director';
import { liveElevatorAccess } from './elevatorAccess';
import { FacilityNpcDirector, type FacilityNpc } from './facilityDirector';
import { barServicePhase, type FacilityCharacterState } from './facilityNpcs';
import { officeNavigation } from './navGraph';
import { bindFacilityStatus } from './facilityStatus';
import { useHoverReveal } from '../hoverReveal';
import { CharacterTag } from '../CharacterTag';

/** One facility director per mounted Office; it reads the agents' movers for arrivals and bar guests. */
export function useFacilityDirector(characters: MovementDirector): FacilityNpcDirector {
  const director = useMemo(() => new FacilityNpcDirector(
    { navigation: officeNavigation(), elevators: liveElevatorAccess, trackWalker: trackMovingOccupant, trackBody: trackStationaryOccupant, doors: doorTraffic,
      walkable: walkingClearanceFor(characters).segmentClear, seatContactClear: walkingClearanceFor(characters).seatContactClear,
      nearbyWalkers: getNearbyMovingOccupantsSnapshot },
    () => characters.list,
  ), [characters]);
  useEffect(() => {
    // Development inspection hook for headless checks of the facility staff.
    if (import.meta.env.DEV) (window as { __EXTALIA_FACILITY__?: FacilityNpcDirector }).__EXTALIA_FACILITY__ = director;
    bindFacilityStatus(director);
    return () => { bindFacilityStatus(null); director.dispose(); };
  }, [director]);
  return director;
}

const inView = (view: FurnishedOfficeView, low: number, high: number) => view === 'stack' || (typeof view === 'number' && view >= low && view <= high);

/**
 * The receptionist and the bartender: facility staff, not agents. Clicking one
 * opens a staff card without session actions; they never appear in agent lists
 * or counters, and their speech is building flavour, styled apart from agent bubbles.
 */
export function FacilityNpcs({ director, view, reducedMotion, language, selectedId, onSelect }: {
  director: FacilityNpcDirector; view: FurnishedOfficeView; reducedMotion: boolean; language: Language;
  selectedId: string | null; onSelect: (id: string) => void;
}) {
  useEffect(() => { director.setReducedMotion(reducedMotion); }, [director, reducedMotion]);
  useSyncExternalStore(director.subscribe, director.version);
  const groups = useRef(new Map<string, Group>());
  useFrame((_, delta) => {
    director.tick(delta);
    for (const { mover } of director.npcs) {
      const group = groups.current.get(mover.id);
      if (!group) continue;
      group.position.set(mover.position[0], mover.position[1], mover.position[2]);
      group.rotation.y = mover.yaw;
      group.visible = view === 'campus' || view === 'stack' || visibleOnFloor(mover, view);
    }
  }, -1);
  const register = useCallback((id: string, group: Group | null) => {
    if (group) groups.current.set(id, group); else groups.current.delete(id);
  }, []);
  return <>{director.npcs.map(npc => <FacilityCharacter key={npc.definition.id} npc={npc} state={npc.brain.state}
    servingSince={npc.brain.serving?.since ?? null} seated={npc.mover.motion.sit >= 0.5}
    shown={view === 'campus' || view === 'stack' || visibleOnFloor(npc.mover, view)}
    tagged={view !== 'campus' && inView(view, npc.mover.floorLow, npc.mover.floorHigh)}
    selected={npc.definition.id === selectedId} onSelect={onSelect}
    reducedMotion={reducedMotion} language={language} register={register} />)}</>;
}

const FacilityCharacter = memo(function FacilityCharacter({ npc, state, servingSince, seated, shown, tagged, onSelect, reducedMotion, language, register }: {
  npc: FacilityNpc; state: FacilityCharacterState; servingSince: number | null; seated: boolean; shown: boolean; tagged: boolean;
  selected: boolean; onSelect: (id: string) => void;
  reducedMotion: boolean; language: Language; register: (id: string, group: Group | null) => void;
}) {
  const { definition, mover } = npc;
  const id = definition.id;
  const ref = useCallback((group: Group | null) => register(id, group), [register, id]);
  const t = MESSAGES[language].facility;
  const atStation = mover.seat?.seatId === definition.homeResourceId && (state === 'ON_DUTY' || state === 'SERVING');
  // Working pose: the receptionist types at the desk; the bartender's hands are busy while serving.
  const typing = atStation && (definition.role === 'receptionist' ? seated : state === 'SERVING');
  const role = t.roles[definition.role];
  const pick = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(id); };
  // Same hover-only tag rule as agents; R3F hit-tests the body meshes it already raycasts for clicks.
  const hover = useHoverReveal();
  return <group ref={ref} position={[mover.position[0], mover.position[1], mover.position[2]]} rotation={[0, mover.yaw, 0]} visible={shown}>
    <group onClick={pick} onPointerOver={event => { event.stopPropagation(); hover.enter(); }} onPointerOut={hover.leave}>
      <CharacterBody id={id} resourceId={mover.seat?.seatId} appearance={definition.appearance} seated={seated} typing={typing} seatHeight={mover.seat?.seatHeight} seatFront={mover.seat?.seatFront}
        reducedMotion={reducedMotion} motion={mover.motion} desk={definition.role === 'receptionist' && atStation ? deskReachForSeat(mover.seat?.seatId) : undefined} />
    </group>
    {/* Same name-only hover label as agents: the role, on pointer hover. */}
    {tagged && <CharacterTag position={[0, 0, 0]} seated={seated} revealed={hover.hovered} name={role} />}
    {tagged && state === 'SERVING' && servingSince !== null &&
      <FacilityServiceLine npc={npc} seated={seated} language={language} />}
  </group>;
});

/** Facility flavour line while serving a guest; never an agent message. */
function FacilityServiceLine({ npc, seated, language }: { npc: FacilityNpc; seated: boolean; language: Language }) {
  const role = npc.definition.role;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (role !== 'bartender') return;
    const update = () => setElapsed(performance.now() - (npc.brain.serving?.since ?? performance.now()));
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [role, npc]);
  const lines = MESSAGES[language].facility.lines;
  const text = role === 'receptionist' ? lines.greet : lines[barServicePhase(elapsed)];
  return <Html position={[0, (seated ? 1.75 : 2.1) + 0.55, 0]} center zIndexRange={[11, 0]} style={{ pointerEvents: 'none' }}>
    <div className="office-facility-bubble">{text}</div>
  </Html>;
}
