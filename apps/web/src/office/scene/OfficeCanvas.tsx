/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera, type Vector3 } from 'three';
import type { OfficeAgent } from '../presence';
import type { Language } from '../../i18n';
import { CampusNeighborhood } from './CampusNeighborhood';
import { CampusExterior } from './CampusExterior';
import { CampusBuildingShell } from './CampusBuildingShell';
import { RoofUtilities } from './RoofUtilities';
import { RoofSignage3D } from './prefabs/architecture/RoofSignage3D';
import { StaticCampusBatch } from './StaticCampusBatch';
import { SceneEnvironment } from './Environment';
import { FurnishedFloors, type FurnishedOfficeView } from './FurnishedFloors';
import { allocateOfficeAgents } from './interior/seating';
import { OfficeCharacter } from './avatars/OfficeCharacter';
import { CharacterTag } from './CharacterTag';
import { cameraProgress, characterFocusPose, panelClearance, type CameraPose } from './cameraFocus';
import type { Point3 } from './layout';

export interface OfficeCanvasProps {
  agents: readonly OfficeAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: FurnishedOfficeView;
  language: Language;
  dark: boolean;
  reducedMotion: boolean;
}
const initialCamera = { position: [-32, 22, -82] as [number, number, number], zoom: 9, near: 0.1, far: 600 };
const lerp3 = (from: Point3, to: Point3, t: number): Point3 => [0, 1, 2].map(axis => from[axis]! + (to[axis]! - from[axis]!) * t) as Point3;

/** Floor presets, plus a short move that frames the selected character (`focus` is its seat). */
function CameraView({ view, focus, reducedMotion }: { view: FurnishedOfficeView; focus?: Point3; reducedMotion: boolean }) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const controls = useThree(s => s.controls) as unknown as { target: Vector3; update(): void } | null;
  const move = useRef<{ elapsed: number; from: CameraPose; to: CameraPose } | null>(null);
  const level = typeof view === 'number' ? (view - 1) * 6.4 : view === 'campus' ? 9.2 : 6.4;
  const target = useMemo(() => [2, level + (typeof view === 'number' ? 0.7 : 0), view === 'campus' ? -3 : 0] as [number, number, number], [view, level]);
  useLayoutEffect(() => {
    if (!(camera instanceof OrthographicCamera)) return;
    const position: [number, number, number] = view === 'campus' ? [-32, 22, -82] : [35, level + 30, 38];
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.zoom = view === 'campus' ? Math.max(3, Math.min(size.width / 115, size.height / 70)) : Math.max(3, Math.min(size.width / 78, size.height / (view === 'stack' ? 68 : 56)));
    camera.updateProjectionMatrix();
  }, [camera, view, level, target, size.width, size.height]);
  const focusKey = focus?.join(',');
  useEffect(() => {
    if (!focus || !(camera instanceof OrthographicCamera)) return;
    const from: CameraPose = { position: camera.position.toArray() as Point3, target: controls ? controls.target.toArray() as Point3 : target, zoom: camera.zoom };
    move.current = { elapsed: 0, from, to: characterFocusPose(focus, undefined, panelClearance(size.width, size.height)) };
    // The focus key captures the seat; the pose is read once when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, camera, controls]);
  useFrame((_, delta) => {
    const current = move.current;
    if (!current || !(camera instanceof OrthographicCamera)) return;
    current.elapsed += delta;
    const t = cameraProgress(current.elapsed, 0.8, reducedMotion);
    camera.position.set(...lerp3(current.from.position, current.to.position, t));
    camera.zoom = current.from.zoom + (current.to.zoom - current.from.zoom) * t;
    camera.updateProjectionMatrix();
    if (controls) { controls.target.set(...lerp3(current.from.target, current.to.target, t)); controls.update(); }
    if (t >= 1) move.current = null;
  });
  return <OrbitControls makeDefault target={target} enableDamping={false} minZoom={2} maxZoom={65} minPolarAngle={0.25} maxPolarAngle={Math.PI * 0.48} />;
}

/** Shared Web/Desktop renderer: furnished geometry and characters consume the same host state. */
export default function OfficeCanvas({ view, language, dark, reducedMotion, agents, selectedId, onSelect }: OfficeCanvasProps) {
  const allocations = useMemo(() => allocateOfficeAgents(agents), [agents]);
  const byId = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const focus = allocations.find(seat => seat.agentId === selectedId)?.position;
  return <Canvas orthographic camera={initialCamera} dpr={[1, 1.25]} shadows gl={{ antialias: false, powerPreference: 'high-performance' }} style={{ width: '100%', height: '100%' }}>
    <SceneEnvironment dark={dark} reducedMotion={reducedMotion}>
      <color attach="background" args={[dark ? '#182536' : '#c4dce8']} />
      <ambientLight intensity={dark ? 0.75 : 1.2} />
      <hemisphereLight args={['#d8edff', '#687757', dark ? 0.6 : 1.5]} />
      <directionalLight position={[-25, 45, -30]} intensity={dark ? 0.6 : 2.5} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-60} shadow-camera-right={60} shadow-camera-top={60} shadow-camera-bottom={-60} shadow-camera-far={150} />
      <CameraView view={view} focus={focus} reducedMotion={reducedMotion} />
      <group visible={view === 'campus'}>
        <CampusNeighborhood /><RoofSignage3D />
        <StaticCampusBatch><CampusExterior /></StaticCampusBatch>
        <StaticCampusBatch><CampusBuildingShell /></StaticCampusBatch>
        <StaticCampusBatch><RoofUtilities /></StaticCampusBatch>
      </group>
      <FurnishedFloors view={view} agents={agents} language={language} />
      {allocations.map(seat => {
        const agent = byId.get(seat.agentId);
        if (!agent) return null;
        return <group key={agent.id} visible={view === 'campus' || view === 'stack' || view === seat.floor}>
          <OfficeCharacter agent={agent} position={seat.position} rotationY={seat.rotationY} seated selected={agent.id === selectedId} onSelect={onSelect} reducedMotion={reducedMotion} />
          {view !== 'campus' && (view === 'stack' || view === seat.floor) && (
            <CharacterTag agent={agent} position={seat.position} seated selected={agent.id === selectedId} label={agent.displayName} onSelect={onSelect} />
          )}
        </group>;
      })}
    </SceneEnvironment>
  </Canvas>;
}
