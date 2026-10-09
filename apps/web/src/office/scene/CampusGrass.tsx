import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { InstancedMesh} from "three";
import { BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Object3D, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from "three";

const WIDTH = 104, DEPTH = 94, TOP = -0.258;
const TILE_METRES = 4;
/** Lower roadside verge between the campus plinth edge and the front road footway. */
const VERGE = { north: -53.5, south: -DEPTH / 2, top: -0.705 } as const;
function seededRandom() {
  let seed = 17931;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

/** A small seamless tile supplies blade detail; no image download or per-blade objects. */
function grassTexture() {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const random = seededRandom();
  ctx.fillStyle = "#587842"; ctx.fillRect(0, 0, 512, 512);
  const tones = ["#456437", "#4d703b", "#638346", "#6d8c4e", "#769555", "#567740"];
  for (let i = 0; i < 18000; i++) {
    const x = random() * 512, y = random() * 512;
    const dx = (random() - 0.5) * 5, dy = 2 + random() * 8;
    ctx.strokeStyle = tones[Math.floor(random() * tones.length)]!; ctx.lineWidth = 0.5 + random();
    // Wrap strokes at tile edges so repeating the texture has no border seams.
    const offsetsX = [0], offsetsY = [0];
    if (x < 8) offsetsX.push(512); else if (x > 504) offsetsX.push(-512);
    if (y < 10) offsetsY.push(512); else if (y > 502) offsetsY.push(-512);
    for (const ox of offsetsX) {
      for (const oy of offsetsY) {
        ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + dx, y + oy - dy); ctx.stroke();
      }
    }
  }
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(WIDTH / TILE_METRES, DEPTH / TILE_METRES);
  texture.anisotropy = 4;
  return texture;
}

function lawnGeometry() {
  const geometry = new PlaneGeometry(WIDTH, DEPTH, 26, 24);
  const positions = geometry.getAttribute("position"), colors = new Float32Array(positions.count * 3);
  const color = new Color();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getY(i);
    const variation = 0.035 * Math.sin(x * 0.18 + z * 0.11) + 0.025 * Math.cos(z * 0.22 - x * 0.07);
    color.setRGB(0.94 + variation, 0.98 + variation, 0.90 + variation);
    colors.set(color.toArray(), i * 3);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

function tuftGeometry() {
  const points: number[] = [];
  for (let blade = 0; blade < 3; blade++) {
    const yaw = blade * Math.PI / 3, c = Math.cos(yaw), s = Math.sin(yaw);
    const vertex = (x: number, y: number, z: number) => [x * c + z * s, y, -x * s + z * c];
    const a = vertex(-0.016, 0, 0), b = vertex(0.016, 0, 0), d = vertex(0.009, 0.045, 0.008), e = vertex(-0.009, 0.045, 0.008), tip = vertex(0, 0.085, 0.024);
    points.push(...a, ...b, ...d, ...a, ...d, ...e, ...e, ...d, ...tip);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3)); geometry.computeVertexNormals();
  return geometry;
}

/** Turf stays below the existing paving. Sparse opaque tufts share a single draw at close zoom. */
export function CampusGrass() {
  const texture = useMemo(() => grassTexture(), []), surface = useMemo(() => lawnGeometry(), []), tuft = useMemo(() => tuftGeometry(), []);
  const vergeTexture = useMemo(() => {
    const value = texture.clone();
    value.repeat.set(WIDTH / TILE_METRES, (VERGE.south - VERGE.north) / TILE_METRES);
    return value;
  }, [texture]);
  const detail = useRef<InstancedMesh>(null);
  const patches = useMemo(() => {
    const random = seededRandom(), points: [number, number, number][] = [];
    // Side lawn strips avoid the building, entrance, paved ring and outer sidewalks.
    for (const side of [-1, 1]) for (let i = 0; i < 160; i++) points.push([side * (35 + random() * 5), -15 + random() * 30, random() * Math.PI * 2]);
    return points;
  }, []);
  useLayoutEffect(() => {
    if (!detail.current) return;
    const dummy = new Object3D(), color = new Color();
    patches.forEach(([x, z, yaw], i) => {
      dummy.position.set(x, TOP, z); dummy.rotation.set(0, yaw, 0); dummy.updateMatrix();
      detail.current!.setMatrixAt(i, dummy.matrix);
      detail.current!.setColorAt(i, color.setHSL(0.24 + (i % 7) * 0.004, 0.32, 0.22 + (i % 5) * 0.014));
    });
    detail.current.instanceMatrix.needsUpdate = true;
    if (detail.current.instanceColor) detail.current.instanceColor.needsUpdate = true;
    detail.current.computeBoundingSphere();
  }, [patches]);
  useFrame(({ camera, size }) => {
    if (!detail.current) return;
    let pixels = 0.085 * size.height * camera.projectionMatrix.elements[5]! / 2;
    if (camera.projectionMatrix.elements[15] !== 1) pixels /= Math.max(1, camera.position.length());
    detail.current.visible = pixels >= 2.4;
  });
  useEffect(() => () => { texture.dispose(); vergeTexture.dispose(); surface.dispose(); tuft.dispose(); }, [texture, vergeTexture, surface, tuft]);
  return <group name="campus-grass" userData={{ officeCollision: false, officePassable: true }}>
    <mesh name="campus-turf-surface" position={[0, TOP, 0]} rotation={[-Math.PI / 2, 0, 0]} geometry={surface} receiveShadow>
      <meshStandardMaterial map={texture} vertexColors roughness={1} metalness={0} />
    </mesh>
    <mesh name="campus-front-verge-turf" position={[0, VERGE.top, (VERGE.north + VERGE.south) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[WIDTH, VERGE.south - VERGE.north]} />
      <meshStandardMaterial map={vergeTexture} color="#e9f0df" roughness={1} metalness={0} />
    </mesh>
    <instancedMesh ref={detail} name="campus-close-grass-tufts" args={[tuft, undefined, patches.length]} visible={false} receiveShadow>
      <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} side={DoubleSide} />
    </instancedMesh>
  </group>;
}
