import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Group, Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createTeamPodDesktopGeometry, createTeamPodDividerGeometry, TEAM_POD_DESKTOP as PROFILE } from './teamPodDesktopGeometry';

const urls = import.meta.glob<string>('/public-assets/furniture/team-pod-desktop.glb', { eager: true, query: '?url', import: 'default' });
const forceProcedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('desks') === 'procedural';
let model: Group | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => model;

async function load(): Promise<void> {
  const url = forceProcedural ? undefined : urls['/public-assets/furniture/team-pod-desktop.glb'];
  if (!url || requested) return;
  requested = true;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (gltf.scene.getObjectByName('TeamPodDesktop')) model = gltf.scene;
  } catch { /* Missing or broken models retain the contour-matched backup. */ }
  listeners.forEach(listener => listener());
}

function ProceduralTeamPodDesktop() {
  const geometry = useMemo(() => createTeamPodDesktopGeometry(), []);
  const divider = useMemo(() => createTeamPodDividerGeometry(), []);
  useEffect(() => () => { geometry.dispose(); divider.dispose(); }, [geometry, divider]);
  const underside = PROFILE.top - PROFILE.thickness;
  const legHeight = underside - PROFILE.footHeight;
  return <group name="procedural-team-pod-structure">
    <mesh name="procedural-team-pod-desktop" geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial attach="material-0" color="#bf9367" roughness={.72} />
      <meshStandardMaterial attach="material-1" color="#a77e58" roughness={.76} />
    </mesh>
    {[[PROFILE.legOffset, 0], [-PROFILE.legOffset, 0], [0, PROFILE.legOffset], [0, -PROFILE.legOffset]].map(([x, z], i) => <group key={i}>
      <mesh name="pod-leg" position={[x!, PROFILE.footHeight + legHeight/2, z!]} castShadow>
        <boxGeometry args={[PROFILE.legWidth, legHeight, PROFILE.legWidth]} /><meshStandardMaterial color="#637174" roughness={.52} />
      </mesh>
      <mesh position={[x!, PROFILE.footHeight/2, z!]}><cylinderGeometry args={[PROFILE.footRadius, PROFILE.footRadius, PROFILE.footHeight, 16]} /><meshStandardMaterial color="#303b3c" roughness={.85} /></mesh>
    </group>)}
    {[0, Math.PI/2].map(yaw => <mesh key={yaw} position={[0, underside-PROFILE.frameHeight/2, 0]} rotation={[0, yaw, 0]} castShadow>
      <boxGeometry args={[2.62, PROFILE.frameHeight, .055]} /><meshStandardMaterial color="#637174" roughness={.52} />
    </mesh>)}
    <mesh position={[0, underside/2, 0]} castShadow><boxGeometry args={[PROFILE.columnWidth, underside, PROFILE.columnWidth]} /><meshStandardMaterial color="#637174" roughness={.52} /></mesh>
    <mesh position={[0, (PROFILE.top+PROFILE.dividerTop)/2, 0]}><cylinderGeometry args={[.014, .014, PROFILE.dividerTop-PROFILE.top, 12]} /><meshStandardMaterial color="#637174" roughness={.52} /></mesh>
    {[-.15, .15].flatMap(x => [-.15, .15].map(z => <mesh key={`${x}:${z}`} position={[x, PROFILE.top+.003, z]}>
      <cylinderGeometry args={[.035, .035, .006, 16]} /><meshStandardMaterial color="#303b3c" roughness={.85} />
    </mesh>))}
    {[0, Math.PI/2, Math.PI, -Math.PI/2].map(yaw => <group key={yaw} rotation={[0, yaw, 0]}>
      <mesh name="pod-divider-glass" geometry={divider}><meshPhysicalMaterial color="#c3d7d3" transparent opacity={.23} depthWrite={false} roughness={.2} /></mesh>
      {PROFILE.clampPositions.map(x => <group key={x}>
        <mesh position={[x, PROFILE.top+.027, 0]} castShadow><boxGeometry args={[.055, .054, .025]} /><meshStandardMaterial color="#637174" roughness={.52} /></mesh>
        <mesh position={[x, PROFILE.top+.004, 0]}><boxGeometry args={[.065, .008, .045]} /><meshStandardMaterial color="#637174" roughness={.52} /></mesh>
      </group>)}
    </group>)}
  </group>;
}

/** One complete fixed Blender structure per pod; devices and animated chairs remain independent. */
export function TeamPodDesktop() {
  const source = useSyncExternalStore(subscribe, snapshot, () => null);
  useEffect(() => { void load(); }, []);
  const clone = useMemo(() => {
    if (!source) return null;
    const scene = source.clone(true);
    scene.traverse(node => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const glass = materials.every(material => material.transparent);
      mesh.castShadow = !glass;
      mesh.receiveShadow = true;
      for (const material of materials) if (material.transparent) material.depthWrite = false;
    });
    return scene;
  }, [source]);
  // A floor-wide batch must never retain a baked copy of the temporary backup.
  return <group name="team-pod-desktop" userData={{ officeDynamic: true, teamPodAuthored: !!clone }}>
    {clone ? <primitive name="blender-team-pod-desktop" object={clone} dispose={null} /> : <ProceduralTeamPodDesktop />}
  </group>;
}
