import { useEffect, useSyncExternalStore } from 'react';
import { BoxGeometry, Color, CylinderGeometry, Float32BufferAttribute, TorusGeometry, type BufferGeometry, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MOBILITY_MODELS, VEHICLE_SPECS, isMobilityVehicle, type MobilityModel } from './campusMobilityLayout';

export interface MobilityGeometry { body: BufferGeometry; lamp: BufferGeometry }
export type MobilityLibrary = ReadonlyMap<MobilityModel, MobilityGeometry>;

const urls = import.meta.glob<string>('/public-assets/landscape/campus-mobility.glb', { eager: true, query: '?url', import: 'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mobility') === 'procedural';

/** Immutable vertex-coloured surfaces retain dark glazing, tires and coloured LEDs in two draws per model. */
function colouredGeometry(source: BufferGeometry, tint: Color): BufferGeometry {
  const shape = source.index ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(shape.attributes)) if (!['position', 'normal', 'color'].includes(name)) shape.deleteAttribute(name);
  if (!shape.getAttribute('normal')) shape.computeVertexNormals();
  const positions = shape.getAttribute('position');
  const existing = shape.getAttribute('color');
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    colors[i * 3] = tint.r * (existing?.getX(i) ?? 1);
    colors[i * 3 + 1] = tint.g * (existing?.getY(i) ?? 1);
    colors[i * 3 + 2] = tint.b * (existing?.getZ(i) ?? 1);
  }
  shape.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return shape;
}

const finishGeometry = (parts: BufferGeometry[]) => {
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error('Incompatible campus mobility surfaces');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

export function disposeMobilityLibrary(library: MobilityLibrary): void {
  for (const { body, lamp } of library.values()) { body.dispose(); lamp.dispose(); }
}

/** Reject an incomplete export as a whole; the complete procedural library stays visible. */
export function bakeCampusMobilityModels(scene: Object3D): MobilityLibrary | null {
  const library = new Map<MobilityModel, MobilityGeometry>();
  const parts: BufferGeometry[] = [];
  scene.updateWorldMatrix(true, true);
  try {
    for (const name of MOBILITY_MODELS) {
      const root = scene.getObjectByName(name);
      if (!root) throw new Error('Incomplete campus mobility library');
      const bodies: BufferGeometry[] = [], lamps: BufferGeometry[] = [];
      root.traverse(node => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material) || !mesh.geometry.getAttribute('position')) throw new Error('Invalid campus mobility surface');
        const material = mesh.material as Material & { color?: Color };
        const shape = colouredGeometry(mesh.geometry, material.color ?? new Color(1, 1, 1));
        parts.push(shape);
        shape.applyMatrix4(mesh.matrixWorld);
        (/Mobility lamp/i.test(material.name) ? lamps : bodies).push(shape);
      });
      if (!bodies.length || !lamps.length) throw new Error('Missing campus mobility material role');
      const body = finishGeometry(bodies);
      try {
        const lamp = finishGeometry(lamps);
        library.set(name, { body, lamp });
      } catch (error) { body.dispose(); throw error; }
    }
    return library;
  } catch {
    disposeMobilityLibrary(library);
    return null;
  } finally { parts.forEach(part => part.dispose()); }
}

/** Complete, bounded fallback while the local Blender file is absent, pending or failed. */
export function createMobilityFallbackModels(): MobilityLibrary {
  const library = new Map<MobilityModel, MobilityGeometry>();
  const paint = '#75969b', white = '#d4d9cf', trim = '#26383d', glass = '#1d3947', rubber = '#11181d', alloy = '#8a999e';
  for (const name of MOBILITY_MODELS) {
    const bodies: BufferGeometry[] = [], lamps: BufferGeometry[] = [];
    const add = (geometry: BufferGeometry, color: string, x: number, y: number, z: number, lamp = false) => {
      const shape = colouredGeometry(geometry, new Color(color));
      geometry.dispose();
      shape.translate(x, y, z);
      (lamp ? lamps : bodies).push(shape);
    };
    const box = (size: readonly [number, number, number], color: string, x: number, y: number, z: number, lamp = false) => add(new BoxGeometry(...size), color, x, y, z, lamp);
    if (name === 'mobility-charger') {
      box([.72, .08, .55], trim, 0, .04, 0);
      box([.62, 1.64, .36], white, 0, .88, 0);
      box([.45, .65, .025], trim, 0, 1.2, .19);
      box([.32, .24, .02], glass, 0, 1.32, .21);
      box([.3, .035, .018], '#4ceab4', 0, 1.11, .23, true);
      add(new TorusGeometry(.26, .024, 4, 16), rubber, .37, .65, .1);
      box([.10, .20, .12], trim, .36, .91, .10);
    } else if (name === 'mobility-cycle-shelter') {
      for (const x of [-2.1, 2.1]) for (const z of [-.9, .9]) {
        box([.09, 2.5, .09], trim, x, 1.25, z);
        box([.2, .12, .2], alloy, x, .06, z);
      }
      box([4.7, .13, 2.45], trim, 0, 2.54, 0);
      for (let i = 0; i < 6; i++) box([.71, .035, 2.25], glass, -1.88 + i * .75, 2.62, 0);
      box([3.8, .022, .035], '#ffe5b4', 0, 2.45, -.8, true);
    } else {
      if (!isMobilityVehicle(name)) throw new Error('Unknown campus vehicle');
      const spec = VEHICLE_SPECS[name];
      const { length, width, height, wheel: radius, cabinZ, cabinLength, cabinBase } = spec;
      const bodyColor = name === 'mobility-ev' || name === 'mobility-mpv' ? white : paint;
      const bodyY = radius + .25;
      const rear = cabinZ - cabinLength / 2, front = cabinZ + cabinLength / 2;
      if (spec.cargo) {
        box([width * .91, .24, length], trim, 0, radius + .10, 0);
        const frontLength = length / 2 - rear;
        box([width, .59, frontLength], bodyColor, 0, bodyY, (length / 2 + rear) / 2);
        const bedFront = rear - .10, bedBack = -length / 2 + .08;
        const bedLength = bedFront - bedBack, bedZ = (bedFront + bedBack) / 2;
        box([width, .12, bedLength], trim, 0, .66, bedZ);
        for (const side of [-1, 1]) {
          box([.11, .48, bedLength], bodyColor, side * (width / 2 - .055), .91, bedZ);
          box([.12, .045, bedLength], trim, side * (width / 2 - .055), 1.16, bedZ);
        }
        for (const z of [bedBack, bedFront]) box([width, .48, .10], bodyColor, 0, .91, z);
      } else box([width, .58, length], bodyColor, 0, bodyY, 0);
      const cabinWidth = width * .84;
      box([cabinWidth, height - cabinBase, cabinLength], bodyColor, 0, (height + cabinBase) / 2, cabinZ);
      const windowHeight = Math.min(.43, height - cabinBase - .15);
      const windowY = height - windowHeight / 2 - .085;
      box([cabinWidth * .89, windowHeight, .035], glass, 0, windowY, front + .018);
      box([cabinWidth * .87, windowHeight * .92, .035], glass, 0, windowY, rear - .018);
      for (const side of [-1, 1]) {
        const bay = cabinLength / spec.windows;
        for (let i = 0; i < spec.windows; i++) {
          const z = rear + bay * (i + .5);
          box([.025, windowHeight, bay * .80], glass, side * (cabinWidth / 2 + .012), windowY, z);
          box([.025, .035, .16], alloy, side * (width / 2 + .012), cabinBase + .05, z - bay * .18);
        }
        box([.10, .12, length * .76], trim, side * (width / 2 - .025), radius + .01, 0);
        box([.12, .12, .21], bodyColor, side * (width / 2 + .015), cabinBase + .23, front - .18);
        for (const z of [-length * .31, length * .31]) {
          const tire = new CylinderGeometry(radius, radius, .19, 12); tire.rotateZ(Math.PI / 2);
          add(tire, rubber, side * width * .46, radius, z);
          const hub = new CylinderGeometry(radius * .67, radius * .67, .195, 10); hub.rotateZ(Math.PI / 2);
          add(hub, alloy, side * width * .46, radius, z);
          if (name === 'mobility-jeep' || name === 'mobility-suv' || name === 'mobility-double-cabin') box([.12, .11, radius * 2.15], trim, side * (width / 2 + .02), radius * 1.85, z);
        }
        box([.38, .11, .035], '#ffedc8', side * width * .33, radius + .36, length / 2 + .012, true);
        box([.30, .13, .035], '#ec3e21', side * width * .34, radius + .36, -length / 2 - .012, true);
        if (name === 'mobility-suv' || name === 'mobility-mpv' || name === 'mobility-jeep') {
          for (const offset of [-cabinLength * .35, cabinLength * .35]) box([.06, .07, .09], trim, side * cabinWidth * .39, height + .035, cabinZ + offset);
          box([.055, .045, cabinLength * .85], alloy, side * cabinWidth * .39, height + .09, cabinZ);
        }
      }
      box([.76, .13, .04], trim, 0, radius + .16, length / 2 + .018);
      box([.30, .075, .012], white, 0, radius + .30, length / 2 + .04);
      box([width * .86, .13, .08], trim, 0, radius + .07, -length / 2);
      if (name === 'mobility-jeep') {
        for (const x of [-.30, -.20, -.10, 0, .10, .20, .30]) box([.045, .29, .04], trim, x, .78, length / 2 + .025);
        const spare = new CylinderGeometry(radius, radius, .21, 12); spare.rotateX(Math.PI / 2);
        add(spare, rubber, 0, 1.01, -length / 2 - .16);
      } else if (name === 'mobility-sedan') box([width * .91, .10, .65], bodyColor, 0, .87, rear - .36);
      else if (name === 'mobility-hatchback' || name === 'mobility-ev') box([cabinWidth + .12, .065, .16], trim, 0, height - .015, rear - .055);
      else if (name === 'mobility-mpv') for (const side of [-1, 1]) box([.026, .035, 1.25], trim, side * (width / 2 + .02), .96, cabinZ - .48);

    }
    try { library.set(name, { body: finishGeometry(bodies), lamp: finishGeometry(lamps) }); }
    finally { [...bodies, ...lamps].forEach(shape => shape.dispose()); }
  }
  return library;
}

function disposeImportedScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>();
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value && typeof value === 'object' && (value as Texture).isTexture) textures.add(value as Texture);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
}

let cached: MobilityLibrary | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
async function load() {
  if (requested) return;
  requested = true;
  const url = procedural ? undefined : urls['/public-assets/landscape/campus-mobility.glb'];
  if (!url) return;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    try { cached = bakeCampusMobilityModels(gltf.scene); }
    finally { disposeImportedScene(gltf.scene); }
  } catch { cached = null; }
  finally { listeners.forEach(listener => listener()); }
}

/** Renderer-lifetime shared cache; pending and failed loads both leave the fallback mounted. */
export function useCampusMobilityModels(): MobilityLibrary | null {
  const models = useSyncExternalStore(subscribe, () => cached, () => null);
  useEffect(() => { void load(); }, []);
  return models;
}
