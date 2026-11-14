import { NaturalWalkingClearance } from './movement/NaturalWalkingClearance';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { officePointerEvents } from './officePointerEvents';
import { useProgress } from '@react-three/drei';
import type { OfficeAgent } from '../presence';
import { MESSAGES, type Language } from '../../i18n';
import { CampusNeighborhood } from './CampusNeighborhood';
import { CampusExterior, CampusFrontContext } from './CampusExterior';
import { CampusBuilding, CampusElevatorFrames, CampusRoofSignage, CampusRoofStair, CampusRoofUtilities, CampusTerraceGuard } from './BuildingShellModel';
import { StaticCampusBatch } from './StaticCampusBatch';
import { SceneEnvironment, type LightOverride } from './Environment';
import { SceneLighting } from './environment/SceneLighting';
import { AdaptiveRenderBudget, useBudgetPixelRatio } from './environment/AdaptiveRenderBudget';
import { OfficeRenderStats } from './environment/OfficeRenderStats';
import { OfficeContextLifecycle } from './environment/OfficeContextLifecycle';
import { publishOfficeFps } from './environment/renderStats';
import type { OfficeContextState } from '../contextRecovery';
import { createSceneReadiness } from '../sceneReadiness';
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
import { publishLoad } from '../loadFeed';
import type { CameraDirectorCommand } from '../cameraDirector';

export interface OfficeCanvasProps {
  automaticShot?: CameraDirectorCommand | null;
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
  /** Renderer availability is independent from the host connection and scene allocation. */
  onContextState?(state: OfficeContextState): void;
  /** Explicitly rebuild only the Office view if the graphics device cannot recover. */
  onRetryScene?(): void;
  /** Increment to explicitly frame the selected character. */
  focusRequest?: number;
  /** Receipt for an entered explicit character focus; false means camera input or another request canceled it. */
  onFocusFinished?: (request: number, completed: boolean) => void;
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
  const readiness = useMemo(() => createSceneReadiness(ready => requestAnimationFrame(ready), frame => cancelAnimationFrame(frame)), []);
  useLayoutEffect(() => { readiness.mount(); return () => readiness.unmount(); }, [readiness]);
  useEffect(() => { onScene?.(); }, [onScene]);
  // Feed the DOM loading overlay (which cannot import three/drei) with the real loader progress.
  useEffect(() => {
    const push = () => { const { active, loaded, total, item } = useProgress.getState(); publishLoad({ active, loaded, total, item }); };
    push();
    return useProgress.subscribe(push);
  }, []);
  useFrame(() => {
    readiness.frame(useProgress.getState().active, () => onReady?.());
  });
  return null;
}
const initialCamera = { position: [-32, 22, -82] as [number, number, number], zoom: 9, near: 0.1, far: 600 };
/** Shared Web/Desktop renderer: furnished geometry and characters consume the same host state. */
export default function OfficeCanvas({ automaticShot, view, viewRequest, language, dark, reducedMotion, agents, selectedId, onSelect, appearances, activities = [], onScene, onReady, onContextState, onRetryScene, focusRequest, onFocusFinished, follow, onFollowEnd, onFollowFloor, focusPoint, allocations: givenAllocations, positions, lightOverride, followSun, popoverId = null, onMiss }: OfficeCanvasProps) {
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
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [context, setContext] = useState<OfficeContextState>('ready');
  const contextChanged = useCallback((next: OfficeContextState) => {
    setContext(next); onContextState?.(next);
    if (next !== 'ready') publishOfficeFps(null);
  }, [onContextState]);
  const dpr = useBudgetPixelRatio(canvas);
  const text = MESSAGES[language].officeUx;
  return <div style={{ position: 'relative', width: '100%', height: '100%' }}><Canvas ref={setCanvas} events={officePointerEvents} frameloop={context === 'lost' ? 'never' : 'always'} orthographic camera={initialCamera} dpr={dpr} shadows="percentage" gl={{ antialias: false, powerPreference: 'high-performance' }} style={{ width: '100%', height: '100%' }} onPointerMissed={onMiss}>
    <OfficeContextLifecycle onState={contextChanged} />
    <CanvasContinuity />
    <ModelInstanceBatches />
    <SceneEnvironment dark={dark} reducedMotion={reducedMotion} lightOverride={lightOverride} followSun={followSun}>
      <SceneReadiness onScene={onScene} onReady={onReady} />
      {/* Sky, fog and sun/moon follow the solar environment; adaptive resolution targets a 30 fps floor. */}
      <SceneLighting />
      <AdaptiveRenderBudget />
      {QA_HOOKS && <SceneBenchProbe />}
      <OverviewDetail campus={view === 'campus'} />
      <CameraView automaticShot={automaticShot} automaticSeat={allocations.find(seat => seat.agentId === automaticShot?.targetId)?.position} view={view} viewRequest={viewRequest} focus={focus} focusId={selectedId} live={live} focusRequest={focusRequest} onFocusFinished={onFocusFinished} reducedMotion={reducedMotion} following={follow} focusPoint={focusPoint} onFollowEnd={onFollowEnd} onFollowFloor={onFollowFloor} />
      <group visible={view === 'campus'} name="campus-site">
        <CampusNeighborhood /><CampusRoofSignage />
        <StaticCampusBatch><CampusExterior frontContext={false} /></StaticCampusBatch>
        {/* The Blender building model when present locally; the three.js shell is its backup. */}
        <CampusBuilding />
        <CampusRoofUtilities />
        <CampusNightLighting />
      </group>
      <group visible={view === 'campus' || view === 1} name="campus-front-context">
        <StaticCampusBatch><CampusFrontContext /></StaticCampusBatch>
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
  </Canvas><OfficeRenderStats language={language} />
    {context !== 'ready' && <div className="office-render-recovery" role="status" aria-live="polite">
      <div className="office-render-recovery-card">
        <h3>{context === 'restoring' ? text.restoringRenderer : text.rendererLost}</h3>
        <p>{text.rendererLostDetail}</p>
        {onRetryScene && <button type="button" className="button" onClick={onRetryScene}>{text.retryRenderer}</button>}
      </div>
    </div>}
  </div>;
}
