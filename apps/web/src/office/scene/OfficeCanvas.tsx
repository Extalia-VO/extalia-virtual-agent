import { NaturalWalkingClearance } from './movement/NaturalWalkingClearance';
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useProgress } from '@react-three/drei';
import type { OfficeAgent } from '../presence';
import type { Language } from '../../i18n';
import { CampusNeighborhood } from './CampusNeighborhood';
import { CampusExterior } from './CampusExterior';
import { CampusBuilding, CampusElevatorFrames, CampusRoofSignage, CampusRoofStair, CampusRoofUtilities, CampusTerraceGuard } from './BuildingShellModel';
import { StaticCampusBatch } from './StaticCampusBatch';
import { SceneEnvironment, type LightOverride } from './Environment';
import { SceneLighting } from './environment/SceneLighting';
import { AdaptiveRenderBudget, useBudgetPixelRatio } from './environment/AdaptiveRenderBudget';
import { CanvasContinuity } from './environment/CanvasContinuity';
import { SceneBenchProbe } from './environment/SceneBenchProbe';
import { OverviewDetail } from './environment/OverviewDetail';
import { QA_HOOKS } from './qaHooks';
import { ModelInstanceBatches } from './ModelInstanceBatches';
import { CampusNightLighting } from './environment/CampusNightLighting';
import { FurnishedFloors, type FurnishedOfficeView } from './FurnishedFloors';
import type { OfficeAgentAllocation } from './interior/seating';
import { useOfficeAllocations } from './interior/useOfficeAllocations';
import type { CharacterAppearance } from './avatars/OfficeCharacter';
import { OfficeOccupants, useMovementDirector } from './movement/OfficeOccupants';
import { FacilityNpcs, useFacilityDirector } from './movement/FacilityStaff';
import { combinePositionSources, type CharacterFloor, type CharacterPositionStore } from './movement/positionStore';
import { GlassElevator } from './prefabs/architecture/GlassElevator';
import { GLASS_ELEVATORS } from './prefabs/architecture/elevatorController';
import type { FocusPoint } from './cameraFocus';
import { CameraView } from './CameraView';
export { MAX_ZOOM } from './CameraView';
import type { OfficeActivity } from '../activityFeed';
import { CharacterBubbles } from './CharacterBubbles';
import { PopoverAnchor } from './PopoverAnchor';

export interface OfficeCanvasProps {
  agents: readonly OfficeAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: FurnishedOfficeView;
  /** Explicit floor/view requests, separate from automatic Follow floor changes. */
  viewRequest?: number;
  language: Language;
  dark: boolean;
  reducedMotion: boolean;
  /** Saved (or previewed) looks by presence id; characters without one use their generated default. */
  appearances?: Readonly<Record<string, CharacterAppearance>>;
  activities?: readonly OfficeActivity[];
  onScene?(): void;
  onReady?(): void;
  /** Increment to explicitly frame the selected character. */
  focusRequest?: number;
  /** Keep the camera on the selected character while it walks. Off by default; Locate and Follow explicitly request camera movement. */
  follow?: boolean;
  /** The user dragged the view, which ends following. */
  onFollowEnd?(): void;
  /** Synchronize the displayed floor with a followed character's live height, including vertical transit. */
  onFollowFloor?(floor: CharacterFloor): void;
  /** Move the camera to a point (e.g. a room); each new object is one request. */
  focusPoint?: FocusPoint;
  /** Seat allocation shared with the page (see `useOfficeAllocations`); derived from `agents` when absent. */
  allocations?: readonly OfficeAgentAllocation[];
  /** Page-owned live character positions (see `createCharacterPositionStore`), e.g. to follow a walking character's floor. */
  positions?: CharacterPositionStore;
  /** Interior lights: `auto` follows the time of day; `on`/`off` are the user's override. */
  lightOverride?: LightOverride;
  /** Follow the real sun (the "Solar" app theme) instead of showing day or night from `dark`. */
  followSun?: boolean;
  /** Character whose card (`CharacterPopover`) is anchored beside it every frame. */
  popoverId?: string | null;
  /** A click that hit no character (not a camera drag). */
  onMiss?(): void;
}

/** Ready follows the first drawn frames and all pending model/texture loads. */
function SceneReadiness({ onScene, onReady }: Pick<OfficeCanvasProps, 'onScene' | 'onReady'>) {
  // Read loader state per frame instead of subscribing: loaders report progress while other components render.
  const frames = useRef(0);
  const notified = useRef(false);
  useEffect(() => { onScene?.(); }, [onScene]);
  useFrame(() => {
    const active = useProgress.getState().active;
    if (notified.current || active) { if (active) frames.current = 0; return; }
    if (++frames.current < 2) return;
    notified.current = true;
    requestAnimationFrame(() => onReady?.());
  });
  return null;
}
const initialCamera = { position: [-32, 22, -82] as [number, number, number], zoom: 9, near: 0.1, far: 600 };
/** Shared Web/Desktop renderer: furnished geometry and characters consume the same host state. */
export default function OfficeCanvas({ view, viewRequest, language, dark, reducedMotion, agents, selectedId, onSelect, appearances, activities = [], onScene, onReady, focusRequest, follow, onFollowEnd, onFollowFloor, focusPoint, allocations: givenAllocations, positions, lightOverride, followSun, popoverId = null, onMiss }: OfficeCanvasProps) {
  const ownAllocations = useOfficeAllocations(agents);
  const allocations = givenAllocations ?? ownAllocations;
  const director = useMovementDirector();
  const facility = useFacilityDirector(director);
  // Agents and facility staff share one live position source (camera locate/follow, character card, page floor lookups).
  const live = useMemo(() => combinePositionSources(director, facility), [director, facility]);
  useEffect(() => {
    if (!positions) return;
    positions.bind(live);
    return () => positions.bind(null);
  }, [positions, live]);
  const focus = allocations.find(seat => seat.agentId === selectedId)?.position;
  const dpr = useBudgetPixelRatio();
  return <Canvas orthographic camera={initialCamera} dpr={dpr} shadows gl={{ antialias: false, powerPreference: 'high-performance' }} style={{ width: '100%', height: '100%' }} onPointerMissed={onMiss}>
    <CanvasContinuity />
    <ModelInstanceBatches />
    <SceneEnvironment dark={dark} reducedMotion={reducedMotion} lightOverride={lightOverride} followSun={followSun}>
      <SceneReadiness onScene={onScene} onReady={onReady} />
      {/* Sky, fog and sun/moon follow the solar environment; the budget keeps the frame rate above 40 fps. */}
      <SceneLighting />
      <AdaptiveRenderBudget />
      {QA_HOOKS && <SceneBenchProbe />}
      <OverviewDetail campus={view === 'campus'} />
      <CameraView view={view} viewRequest={viewRequest} focus={focus} focusId={selectedId} live={live} focusRequest={focusRequest} reducedMotion={reducedMotion} following={follow} focusPoint={focusPoint} onFollowEnd={onFollowEnd} onFollowFloor={onFollowFloor} />
      <group visible={view === 'campus'} name="campus-site">
        <CampusNeighborhood /><CampusRoofSignage />
        <StaticCampusBatch><CampusExterior /></StaticCampusBatch>
        {/* The Blender building model when present locally; the three.js shell is its backup. */}
        <CampusBuilding />
        <CampusRoofUtilities />
        <CampusNightLighting />
      </group>
      <NaturalWalkingClearance owner={director} />
      <FurnishedFloors view={view} agents={agents} language={language} allocations={allocations} />
      <group name="office-glass-elevators">{GLASS_ELEVATORS.map(({ id }) => <GlassElevator key={id} elevatorId={id} view={view} />)}</group>
      {/* Blender lift frames span every floor, so they show only in the whole-building views. */}
      <group visible={view === 'campus' || view === 'stack'}><CampusElevatorFrames /></group>
      <group visible={view === 'campus' || view === 'stack' || view === 3}><CampusRoofStair view={view} /><CampusTerraceGuard /></group>
      {/* Characters walk in, sit, and walk out at their live positions; tags follow them. */}
      <group name="office-characters">
        <OfficeOccupants director={director} allocations={allocations} agents={agents} appearances={appearances} view={view}
          selectedId={selectedId} onSelect={onSelect} reducedMotion={reducedMotion} />
        {/* Receptionist and bartender: facility staff owned by the scene, never agent sessions. */}
        <FacilityNpcs director={facility} view={view} reducedMotion={reducedMotion} language={language} selectedId={selectedId} onSelect={onSelect} appearances={appearances} />
      </group>
      <CharacterBubbles activities={activities} agents={agents} allocations={allocations} view={view} selectedId={selectedId} reducedMotion={reducedMotion} positions={director} language={language} />
      <PopoverAnchor characterId={popoverId} live={live} view={view} />
    </SceneEnvironment>
  </Canvas>;
}
