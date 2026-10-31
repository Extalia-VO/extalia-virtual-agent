/* eslint-disable react-hooks/immutability -- Instanced Three.js matrices and materials are renderer-owned mutable resources. */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  BoxGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Matrix4, MeshStandardMaterial, SRGBColorSpace,
  type BufferGeometry, type InstancedMesh, type Mesh, type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useSolarEnvironment, type LightOverride } from './Environment';
import { useExteriorInstancedGeometries } from './ExteriorPart';
import { FixtureSpotLight } from './prefabs/architecture/FixtureSpotLight';
import { ALL_PARKING_BAYS, ALL_PARKING_LIGHTS, PARKING, PARKING_BAYS, PARKING_LIGHT_HEIGHT } from './campusMobilityLayout';

type Slab = { x: number; z: number; w: number; d: number; y: number; h: number; color: string };
export function parkingSlabs(): Slab[] {
  const ground=PARKING.top;
  const out: Slab[] = [{x:(PARKING.west+PARKING.east)/2,z:(PARKING.north+PARKING.south)/2,w:PARKING.east-PARKING.west,d:PARKING.south-PARKING.north,y:ground-.04,h:.08,color:'#454c50'},
    // Aisle stub to the Blender-authored access apron (campus-parking.glb), which starts at z=-25.5.
    {x:PARKING.aisleX,z:-18.75,w:6,d:13.5,y:ground-.04,h:.08,color:'#454c50'},
    {x:PARKING.footwayX,z:3,w:2,d:36,y:ground+.025,h:.06,color:'#c9c9bc'},
    {x:-28,z:8.5,w:9,d:2.8,y:ground+.025,h:.06,color:'#d9d4c8'}];
  // Low wheel stops, green EV pads and bright perpendicular bay divisions.
  for(const bay of PARKING_BAYS) {
    if(bay.ev) out.push({x:bay.x,z:bay.z,w:5.25,d:2.95,y:ground+.004,h:.008,color:'#446e62'});
    out.push({x:bay.x,z:bay.z-1.55,w:5.4,d:.075,y:ground+.012,h:.012,color:'#d4d6cd'});
    out.push({x:bay.x+(bay.x<-42?-1.95:1.95),z:bay.z,w:.15,d:1.5,y:ground+.045,h:.09,color:'#b9c0b7'});
  }
  for(const x of [PARKING.west+.12,PARKING.east-.12]) out.push({x,z:3,w:.22,d:34,y:ground+.07,h:.14,color:'#afb6a8'});
  // A one-way center guide and pedestrian crossing to the separate footway.
  for(let z=-11;z<17;z+=5) out.push({x:PARKING.aisleX,z,w:.1,d:2,y:ground+.008,h:.012,color:'#d8cfaa'});
  for(let z=7.5;z<9.5;z+=.45)out.push({x:-34.4,z,w:2,d:.22,y:ground+.012,h:.012,color:'#deded0'});
  return out;
}
function evStencil() {
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;
  const ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,256,128);
  ctx.fillStyle='#eef5e6';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 64px sans-serif';ctx.fillText('EV',128,64);
  const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;return texture;
}
export function parkingLightPower(night: number, override: LightOverride): number {
  return override === 'off' ? 0 : override === 'on' ? 1 : Math.max(0, Math.min(1, night));
}

/** Reuse the normalized Blender walk-lamp roles in two draws for the poles of both lots. */
function ParkingLights() {
  const { state, lightOverride } = useSolarEnvironment();
  const factor = parkingLightPower(state.factors.exteriorLightFactor, lightOverride);
  const exterior = useExteriorInstancedGeometries();
  const body = useRef<InstancedMesh>(null), optics = useRef<InstancedMesh>(null);
  const fallback = useMemo(() => {
    const shaft = new CylinderGeometry(.375, .458, .96, 8); shaft.translate(0, -.02, 0);
    const cap = new BoxGeometry(3.3, .028, 3.3); cap.translate(0, .48, 0);
    const body = mergeGeometries([shaft, cap])!;
    shaft.dispose(); cap.dispose();
    const optics = new CylinderGeometry(1.4, 1.4, .02, 12); optics.translate(0, .458, 0);
    return { body, optics };
  }, []);
  const materials = useMemo(() => ({
    body: new MeshStandardMaterial({ color: '#44565b', metalness: .4, roughness: .45 }),
    optics: new MeshStandardMaterial({ color: '#fff2da', emissive: '#ffd3a0', emissiveIntensity: 0, roughness: .4, toneMapped: false }),
  }), []);
  useEffect(() => () => { fallback.body.dispose(); fallback.optics.dispose(); materials.body.dispose(); materials.optics.dispose(); }, [fallback, materials]);
  useEffect(() => { materials.optics.emissiveIntensity = factor * 2.4; }, [materials, factor]);
  useLayoutEffect(() => {
    const matrix = new Matrix4();
    ALL_PARKING_LIGHTS.forEach((pole, index) => {
      // ExteriorPart normalizes both lamp roles to y=[-.5,.5] and a .12m horizontal unit.
      matrix.makeScale(.12, PARKING_LIGHT_HEIGHT, .12);
      matrix.setPosition(pole.x, PARKING.top + PARKING_LIGHT_HEIGHT / 2, pole.z);
      body.current?.setMatrixAt(index, matrix); optics.current?.setMatrixAt(index, matrix);
    });
    for (const mesh of [body.current, optics.current]) if (mesh) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
  }, [exterior, fallback]);
  return <group name="parking-perimeter-lighting" userData={{ officeDynamic: true }}>
    <instancedMesh ref={body} name="parking-pole-bodies" args={[exterior?.lamp ?? fallback.body, materials.body, ALL_PARKING_LIGHTS.length]} dispose={null} />
    <instancedMesh ref={optics} name="parking-pole-optics" args={[exterior?.lampOptics ?? fallback.optics, materials.optics, ALL_PARKING_LIGHTS.length]} dispose={null} />
    {ALL_PARKING_LIGHTS.map(pole => <FixtureSpotLight key={pole.id} name={pole.id}
      position={[pole.x, PARKING.top + PARKING_LIGHT_HEIGHT - .18, pole.z]} aim={[pole.poolX, PARKING.top, pole.z]}
      intensity={70 * factor} distance={12} angle={1.1} penumbra={.65} color="#ffdeaa" floorY={PARKING.top} bakedOnly />)}
  </group>;
}

const urls = import.meta.glob<string>('/public-assets/landscape/campus-parking.glb', { eager: true, query: '?url', import: 'default' });
/** Roots of the Blender-authored parking GLB: the east lot and both access connectors. */
export const PARKING_GLB_ROOTS = ['parking-east-lot', 'parking-access-west', 'parking-access-east'] as const;
let parkingGeometry: BufferGeometry | null = null, requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Merge every authored part into one vertex-coloured geometry (material colours become vertex colours): one draw. */
export function bakeParkingGeometry(scene: Object3D): BufferGeometry | null {
  scene.updateWorldMatrix(true, true);
  const shapes: BufferGeometry[] = [], color = new Color();
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial | undefined;
    const raw = mesh.geometry.clone(), shape = raw.index ? raw.toNonIndexed() : raw;
    if (shape !== raw) raw.dispose();
    shape.applyMatrix4(mesh.matrixWorld);
    for (const key of Object.keys(shape.attributes)) if (key !== 'position' && key !== 'normal') shape.deleteAttribute(key);
    const count = shape.getAttribute('position').count, colors = new Float32Array(count * 3);
    color.copy(material?.color ?? new Color('#ffffff'));
    for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
    shape.setAttribute('color', new Float32BufferAttribute(colors, 3));
    shapes.push(shape);
  });
  if (!shapes.length) return null;
  const merged = mergeGeometries(shapes, false);
  shapes.forEach(shape => shape.dispose());
  merged?.computeBoundingBox(); merged?.computeBoundingSphere();
  return merged ?? null;
}
async function loadParking() {
  const url = urls['/public-assets/landscape/campus-parking.glb'];
  if (!url || requested) return;
  requested = true;
  try { parkingGeometry = bakeParkingGeometry((await new GLTFLoader().loadAsync(url)).scene); }
  catch { /* Without the published GLB only the west lot's instanced slabs remain. */ }
  listeners.forEach(listener => listener());
}
function useParkingGeometry(): BufferGeometry | null {
  const geometry = useSyncExternalStore(subscribe, () => parkingGeometry, () => null);
  useEffect(() => { void loadParking(); }, []);
  return geometry;
}

/** East lot and both access connectors (ramps, kerb returns, footway crossings) from Blender, in one draw. */
function AuthoredParking() {
  const geometry = useParkingGeometry();
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: .92, metalness: 0, side: DoubleSide }), []);
  useEffect(() => () => material.dispose(), [material]);
  if (!geometry) return null;
  return <mesh name="parking-blender-lot-and-access" geometry={geometry} material={material} receiveShadow castShadow />;
}

/** Instanced hardscape, separated access and EV wayfinding; vehicle geometry is shared with traffic. */
export function CampusParking() {
  const slabs=useMemo(() => parkingSlabs(),[]);const ref=useRef<InstancedMesh>(null);const stencil=useMemo(() => evStencil(),[]);
  useEffect(()=>()=>stencil.dispose(),[stencil]);
  useLayoutEffect(()=>{const mesh=ref.current;if(!mesh)return;const matrix=new Matrix4(),color=new Color();
    slabs.forEach((s,i)=>{matrix.makeScale(s.w,s.h,s.d);matrix.setPosition(s.x,s.y,s.z);mesh.setMatrixAt(i,matrix);mesh.setColorAt(i,color.set(s.color));});
    mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;mesh.computeBoundingSphere();
  },[slabs]);
  return <group name="campus-parking-and-ev-bays" userData={{officePassable:true,officeCollision:false}}>
    <ParkingLights />
    <AuthoredParking />
    <instancedMesh name="parking-paving-and-markings" ref={ref} args={[undefined,undefined,slabs.length]} receiveShadow>
      <boxGeometry/><meshStandardMaterial roughness={.95} color="#ffffff"/>
    </instancedMesh>
    {/* EV stencils sit at the head of each charging bay, reading from the aisle. */}
    {ALL_PARKING_BAYS.filter(b=>b.ev).map(b=>{const head=Math.sign(Math.sin(b.yaw))||1;return <mesh key={b.id} position={[b.x-head*.8,PARKING.top+.021,b.z]} rotation={[-Math.PI/2,0,head*Math.PI/2]}>
      <planeGeometry args={[1.3,.65]}/><meshBasicMaterial map={stencil} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-1}/>
    </mesh>;})}
  </group>;
}
