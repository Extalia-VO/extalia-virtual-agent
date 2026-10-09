/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useLayoutEffect } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera } from 'three';
import type { OfficeAgent } from '../presence';
import { CampusNeighborhood } from './CampusNeighborhood';
import { CampusExterior } from './CampusExterior';
import { CampusBuildingShell } from './CampusBuildingShell';
import { RoofUtilities } from './RoofUtilities';
import { RoofSignage3D } from './prefabs/architecture/RoofSignage3D';
import { StaticCampusBatch } from './StaticCampusBatch';
import { SceneEnvironment } from './Environment';

export interface OfficeCanvasProps {
  agents: readonly OfficeAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: 'campus' | 'work';
  dark: boolean;
  reducedMotion: boolean;
}
const initialCamera = { position: [-32, 22, -82] as [number, number, number], zoom: 9, near: 0.1, far: 600 };
function CameraView({ view, count }: { view: OfficeCanvasProps['view']; count: number }) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const target = view === 'campus' ? [0, 9.2, -3] as [number, number, number] : [0, 0, 0] as [number, number, number];
  useLayoutEffect(() => {
    if (!(camera instanceof OrthographicCamera)) return;
    const position: [number, number, number] = view === 'campus' ? [-32, 22, -82] : [22, 24, 28];
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(0, view === 'campus' ? 9.2 : 0, view === 'campus' ? -3 : 0);
    const rows = Math.max(2, Math.ceil(count / 6));
    camera.zoom = view === 'campus' ? Math.max(3, Math.min(size.width / 115, size.height / 70)) : Math.max(3, Math.min(size.width / 38, size.height / Math.max(27, rows * 6)));
    camera.updateProjectionMatrix();
  }, [camera, view, size.width, size.height, count]);
  return <OrbitControls makeDefault target={target} enableDamping={false} minZoom={2} maxZoom={60} minPolarAngle={0.25} maxPolarAngle={Math.PI * 0.48} />;
}
function statusColor(agent: OfficeAgent) {
  if (agent.pendingApprovalId || agent.status === 'blocked') return '#efaa45';
  if (agent.status === 'working') return '#36c69a';
  if (agent.status === 'thinking' || agent.status === 'delegating') return '#729eff';
  if (agent.status === 'waiting') return '#c99ae5';
  return '#92a4aa';
}
function Actor({ agent, position, selected, onSelect }: { agent: OfficeAgent; position: [number, number, number]; selected: boolean; onSelect: (id: string) => void }) {
  const color = statusColor(agent);
  const pick = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(agent.id); };
  return <group position={position} onClick={pick}>
    <mesh position={[0, 0.82, 0]} castShadow><capsuleGeometry args={[0.3, 0.65, 5, 8]} /><meshStandardMaterial color={color} roughness={0.65} /></mesh>
    <mesh position={[0, 1.53, 0]} castShadow><sphereGeometry args={[0.29, 12, 8]} /><meshStandardMaterial color="#d8c7b8" roughness={0.8} /></mesh>
    <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.48, selected ? 0.7 : 0.55, 24]} /><meshBasicMaterial color={selected ? '#d3eb7d' : color} /></mesh>
    <mesh position={[0, 0.9, 0]}><boxGeometry args={[1.4, 2.1, 1.4]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
  </group>;
}
function Workstations({ agents, selectedId, onSelect }: Pick<OfficeCanvasProps, 'agents' | 'selectedId' | 'onSelect'>) {
  const rows = Math.max(2, Math.ceil(agents.length / 6));
  return <group>
    <mesh receiveShadow position={[0, -0.18, 0]}><boxGeometry args={[30, 0.35, rows * 5 + 5]} /><meshStandardMaterial color="#b4b7ac" roughness={0.85} /></mesh>
    {agents.map((agent, index) => {
      const x = (index % 6 - 2.5) * 4.2, z = (Math.floor(index / 6) - (rows - 1) / 2) * 5;
      return <group key={agent.id} position={[x, 0, z]}>
        <mesh position={[0, 0.77, -0.72]} castShadow><boxGeometry args={[2.7, 0.12, 1.35]} /><meshStandardMaterial color="#c7ac88" /></mesh>
        {[-1, 1].map(side => <mesh key={side} position={[side * 1.05, 0.36, -0.72]}><boxGeometry args={[0.12, 0.72, 0.9]} /><meshStandardMaterial color="#435760" /></mesh>)}
        <mesh position={[0, 1.22, -1]}><boxGeometry args={[1.12, 0.65, 0.08]} /><meshStandardMaterial color="#26333c" emissive={statusColor(agent)} emissiveIntensity={0.22} /></mesh>
        <Actor agent={agent} position={[0, 0, 0.6]} selected={agent.id === selectedId} onSelect={onSelect} />
      </group>;
    })}
  </group>;
}
/** Shared Web/Desktop renderer: only host-derived presence enters this scene. */
export default function OfficeCanvas(props: OfficeCanvasProps) {
  const { view, dark, reducedMotion, agents, selectedId, onSelect } = props;
  return <Canvas orthographic camera={initialCamera} dpr={[1, 1.25]} shadows gl={{ antialias: false, powerPreference: 'high-performance' }} style={{ width: '100%', height: '100%' }}>
    <SceneEnvironment dark={dark} reducedMotion={reducedMotion}>
      <color attach="background" args={[dark ? '#182536' : '#c4dce8']} />
      <ambientLight intensity={dark ? 0.75 : 1.2} />
      <hemisphereLight args={['#d8edff', '#687757', dark ? 0.6 : 1.5]} />
      <directionalLight position={[-25, 45, -30]} intensity={dark ? 0.6 : 2.5} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-60} shadow-camera-right={60} shadow-camera-top={60} shadow-camera-bottom={-60} shadow-camera-far={150} />
      <CameraView view={view} count={agents.length} />
      <group visible={view === 'campus'}>
        <CampusNeighborhood />
        <RoofSignage3D />
        <StaticCampusBatch><CampusExterior /></StaticCampusBatch>
        <StaticCampusBatch><CampusBuildingShell /></StaticCampusBatch>
        <StaticCampusBatch><RoofUtilities /></StaticCampusBatch>
        {agents.map((agent, index) => <Actor key={agent.id} agent={agent} position={[(index % 12 - 5.5) * 2.2, 0, -31 - Math.floor(index / 12) * 2.5]} selected={agent.id === selectedId} onSelect={onSelect} />)}
      </group>
      <group visible={view === 'work'}><Workstations agents={agents} selectedId={selectedId} onSelect={onSelect} /></group>
    </SceneEnvironment>
  </Canvas>;
}
