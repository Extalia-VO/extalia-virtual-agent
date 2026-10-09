/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useLayoutEffect, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera } from 'three';
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
function CameraView({ view }: { view: FurnishedOfficeView }) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
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
  return <OrbitControls makeDefault target={target} enableDamping={false} minZoom={2} maxZoom={65} minPolarAngle={0.25} maxPolarAngle={Math.PI * 0.48} />;
}

/** Shared Web/Desktop renderer: furnished geometry and characters consume the same host state. */
export default function OfficeCanvas({ view, language, dark, reducedMotion, agents, selectedId, onSelect }: OfficeCanvasProps) {
  const allocations = useMemo(() => allocateOfficeAgents(agents), [agents]);
  const byId = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  return <Canvas orthographic camera={initialCamera} dpr={[1, 1.25]} shadows gl={{ antialias: false, powerPreference: 'high-performance' }} style={{ width: '100%', height: '100%' }}>
    <SceneEnvironment dark={dark} reducedMotion={reducedMotion}>
      <color attach="background" args={[dark ? '#182536' : '#c4dce8']} />
      <ambientLight intensity={dark ? 0.75 : 1.2} />
      <hemisphereLight args={['#d8edff', '#687757', dark ? 0.6 : 1.5]} />
      <directionalLight position={[-25, 45, -30]} intensity={dark ? 0.6 : 2.5} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-60} shadow-camera-right={60} shadow-camera-top={60} shadow-camera-bottom={-60} shadow-camera-far={150} />
      <CameraView view={view} />
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
        </group>;
      })}
    </SceneEnvironment>
  </Canvas>;
}
