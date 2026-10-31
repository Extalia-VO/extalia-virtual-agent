import { useEffect, useSyncExternalStore } from 'react';
import { BoxGeometry, Color, CylinderGeometry, Float32BufferAttribute, Matrix4, TorusGeometry, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CYCLE_SHELTER, EV_CHARGERS, GENERATED_MOBILITY_MODELS, MOBILITY_MODELS, PARKED_VEHICLES, TRAFFIC_SCHEDULE, VEHICLE_SPECS,
  isMobilityVehicle, vehicleCategory, type MobilityModel,
} from './campusMobilityLayout';

/** One wheel hub in model space; `side` is +1 on the car's left (+X), -1 on its right. */
export interface WheelHub { x: number; y: number; z: number; side: 1 | -1 }
/** A single wheel (axle along X, visible face +X) instanced on every hub. */
export interface MobilityWheels { geometry: BufferGeometry; radius: number; hubs: readonly WheelHub[] }
export interface MobilityGeometry { body: BufferGeometry; lamp: BufferGeometry; wheels?: MobilityWheels }
export type MobilityLibrary = ReadonlyMap<MobilityModel, MobilityGeometry>;

const campusUrls = import.meta.glob<string>('/public-assets/landscape/campus-mobility.glb', { eager: true, query: '?url', import: 'default' });
const vehicleUrls = import.meta.glob<string>('/public-assets/vehicles/*.glb', { eager: true, query: '?url', import: 'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mobility') === 'procedural';
const TAIL_LAMP = /lamp tail|taillight|tail lamp|brake/i;

/** Immutable vertex-coloured surfaces; the authored (smooth, weighted) normals are kept as exported. */
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

/** Lamp surfaces carry a per-vertex tail flag so brake lamps can brighten independently. */
function lampGeometry(shape: BufferGeometry, tail: boolean): BufferGeometry {
  shape.setAttribute('mobilityTail', new Float32BufferAttribute(new Float32Array(shape.getAttribute('position').count).fill(tail ? 1 : 0), 1));
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
  for (const { body, lamp, wheels } of library.values()) { body.dispose(); lamp.dispose(); wheels?.geometry.dispose(); }
}

const isWheelTemplate = (node: Object3D) => node.name.startsWith('wheel-template');
function insideTemplate(node: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = node; current && current !== root; current = current.parent) if (isWheelTemplate(current)) return true;
  return false;
}

/**
 * Bake each named root into body, lamp and (for vehicles) one wheel template plus four hubs.
 * Reject the file as a whole when any requested model is incomplete; its fallback stays visible.
 */
export function bakeCampusMobilityModels(scene: Object3D, names: readonly MobilityModel[] = MOBILITY_MODELS): MobilityLibrary | null {
  const library = new Map<MobilityModel, MobilityGeometry>();
  const parts: BufferGeometry[] = [];
  scene.updateWorldMatrix(true, true);
  try {
    for (const name of names) {
      const root = scene.getObjectByName(name);
      if (!root) throw new Error('Incomplete campus mobility library');
      const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
      const bodies: BufferGeometry[] = [], lamps: BufferGeometry[] = [], tyres: BufferGeometry[] = [];
      let template: Object3D | undefined;
      const hubs: WheelHub[] = [];
      let radius = 0;
      root.traverse(node => {
        if (isWheelTemplate(node) && !template) template = node;
        if (node.userData.wheel_side !== undefined && !isWheelTemplate(node)) {
          const position = new Vector3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(rootInverse);
          hubs.push({ x: position.x, y: position.y, z: position.z, side: Number(node.userData.wheel_side) < 0 ? -1 : 1 });
          radius = Number(node.userData.wheel_radius) || radius;
        }
      });
      const templateInverse = template ? new Matrix4().copy(template.matrixWorld).invert() : undefined;
      root.traverse(node => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material) || !mesh.geometry.getAttribute('position')) throw new Error('Invalid campus mobility surface');
        const material = mesh.material as Material & { color?: Color };
        const shape = colouredGeometry(mesh.geometry, material.color ?? new Color(1, 1, 1));
        parts.push(shape);
        if (templateInverse && insideTemplate(mesh, root)) {
          shape.applyMatrix4(new Matrix4().multiplyMatrices(templateInverse, mesh.matrixWorld));
          tyres.push(shape);
          return;
        }
        shape.applyMatrix4(mesh.matrixWorld);
        if (/Mobility lamp/i.test(material.name)) lamps.push(lampGeometry(shape, TAIL_LAMP.test(material.name)));
        else bodies.push(shape);
      });
      if (!bodies.length || !lamps.length) throw new Error('Missing campus mobility material role');
      if (isMobilityVehicle(name) && (!tyres.length || hubs.length !== 4 || !(radius > 0))) throw new Error('Missing campus vehicle wheels');
      const body = finishGeometry(bodies);
      const built: BufferGeometry[] = [body];
      try {
        const lamp = finishGeometry(lamps);
        built.push(lamp);
        const wheels = tyres.length ? { geometry: finishGeometry(tyres), radius, hubs } : undefined;
        library.set(name, wheels ? { body, lamp, wheels } : { body, lamp });
      } catch (error) { built.forEach(geometry => geometry.dispose()); throw error; }
    }
    return library;
  } catch {
    disposeMobilityLibrary(library);
    return null;
  } finally { parts.forEach(part => part.dispose()); }
}

/** A five-spoke wheel in template space (axle X, face +X) so rotation stays readable. */
function fallbackWheel(radius: number, width: number, rubber: string, alloy: string, well: string): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  const add = (geometry: BufferGeometry, color: string, x = 0, rotate = 0) => {
    if (rotate) geometry.rotateX(rotate);
    const shape = colouredGeometry(geometry, new Color(color));
    geometry.dispose();
    shape.translate(x, 0, 0);
    pieces.push(shape);
  };
  const tyre = new CylinderGeometry(radius, radius, width, 14); tyre.rotateZ(Math.PI / 2); add(tyre, rubber);
  const disc = new CylinderGeometry(radius * .68, radius * .68, .01, 14); disc.rotateZ(Math.PI / 2); add(disc, well, width / 2 + .004);
  for (let i = 0; i < 5; i++) add(new BoxGeometry(.012, radius * .5, radius * .13).translate(0, radius * .35, 0), alloy, width / 2 + .011, i * Math.PI * 2 / 5);
  try { return finishGeometry(pieces); } finally { pieces.forEach(piece => piece.dispose()); }
}

/** Complete, bounded fallback while a public GLB is absent, pending or failed. */
export function createMobilityFallbackModels(names: readonly MobilityModel[] = MOBILITY_MODELS): MobilityLibrary {
  const library = new Map<MobilityModel, MobilityGeometry>();
  const paint = '#c9cfd2', white = '#d4d9cf', trim = '#26383d', glass = '#1d3947', rubber = '#11181d', alloy = '#8a999e';
  for (const name of names) {
    const bodies: BufferGeometry[] = [], lamps: BufferGeometry[] = [];
    const add = (geometry: BufferGeometry, color: string, x: number, y: number, z: number, lamp: 'head' | 'tail' | false = false) => {
      const shape = colouredGeometry(geometry, new Color(color));
      geometry.dispose();
      shape.translate(x, y, z);
      (lamp ? lamps : bodies).push(lamp ? lampGeometry(shape, lamp === 'tail') : shape);
    };
    const box = (size: readonly [number, number, number], color: string, x: number, y: number, z: number, lamp: 'head' | 'tail' | false = false) => add(new BoxGeometry(...size), color, x, y, z, lamp);
    let wheels: MobilityWheels | undefined;
    if (name === 'mobility-charger') {
      box([.72, .08, .55], trim, 0, .04, 0);
      box([.62, 1.64, .36], white, 0, .88, 0);
      box([.45, .65, .025], trim, 0, 1.2, .19);
      box([.32, .24, .02], glass, 0, 1.32, .21);
      box([.3, .035, .018], '#4ceab4', 0, 1.11, .23, 'head');
      add(new TorusGeometry(.26, .024, 4, 16), rubber, .37, .65, .1);
      box([.10, .20, .12], trim, .36, .91, .10);
    } else if (name === 'mobility-cycle-shelter') {
      for (const x of [-2.1, 2.1]) for (const z of [-.9, .9]) {
        box([.09, 2.5, .09], trim, x, 1.25, z);
        box([.2, .12, .2], alloy, x, .06, z);
      }
      box([4.7, .13, 2.45], trim, 0, 2.54, 0);
      for (let i = 0; i < 6; i++) box([.71, .035, 2.25], glass, -1.88 + i * .75, 2.62, 0);
      box([3.8, .022, .035], '#ffe5b4', 0, 2.45, -.8, 'head');
    } else {
      if (!isMobilityVehicle(name)) throw new Error('Unknown campus vehicle');
      const spec = VEHICLE_SPECS[name]!;
      const { length, height, wheel: radius, cabinZ, cabinLength, cabinBase, wheelbase, track } = spec;
      // Mirrors are part of the measured width; the fallback body uses the track instead.
      const width = Math.min(spec.width, track + .3);
      const bodyColor = vehicleCategory(name) === 'ev' || name === 'mobility-mpv' ? white : paint;
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
        if (name === 'mobility-jeep' || name === 'mobility-ev-suv' || name === 'mobility-pickup') {
          for (const z of [-wheelbase / 2, wheelbase / 2]) box([.12, .11, radius * 2.15], trim, side * (width / 2 + .02), radius * 1.85, z);
        }
        box([.38, .11, .035], '#ffedc8', side * width * .33, radius + .36, length / 2 + .012, 'head');
        box([.30, .13, .035], '#ec3e21', side * width * .34, radius + .36, -length / 2 - .012, 'tail');
        if (name === 'mobility-ev-suv' || name === 'mobility-mpv' || name === 'mobility-jeep' || name === 'mobility-van') {
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
        add(spare, rubber, 0, 1.01, -length / 2 + .2);
      } else if (name === 'mobility-sedan' || name === 'mobility-sports') box([width * .91, .10, .65], bodyColor, 0, .87 * height / 1.45, rear - .36);
      else if (name === 'mobility-hatchback' || name === 'mobility-ev-sedan') box([cabinWidth + .12, .065, .16], trim, 0, height - .015, rear - .055);
      else if (name === 'mobility-mpv' || name === 'mobility-ev-mpv' || name === 'mobility-van') for (const side of [-1, 1]) box([.026, .035, 1.25], trim, side * (width / 2 + .02), .96, cabinZ - .48);
      const hubs: WheelHub[] = [];
      for (const z of [wheelbase / 2, -wheelbase / 2]) for (const side of [1, -1] as const) hubs.push({ x: side * track / 2, y: radius, z, side });
      wheels = { geometry: fallbackWheel(radius, .2, rubber, alloy, trim), radius, hubs };
    }
    try {
      library.set(name, { body: finishGeometry(bodies), lamp: finishGeometry(lamps), ...(wheels ? { wheels } : {}) });
    } finally { [...bodies, ...lamps].forEach(shape => shape.dispose()); }
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

/** Models that actually appear on campus today (the daily rotation); only their files are fetched. */
export const USED_MOBILITY_MODELS: readonly MobilityModel[] = MOBILITY_MODELS.filter(model =>
  [...PARKED_VEHICLES, ...EV_CHARGERS, CYCLE_SHELTER].some(item => item.model === model) || TRAFFIC_SCHEDULE.some(({ cars }) => cars.some(car => car.model === model)));

/** Public file and model names for every lazily loaded source. */
export function mobilitySources(used: readonly MobilityModel[] = USED_MOBILITY_MODELS): { path: string; names: MobilityModel[] }[] {
  const sources: { path: string; names: MobilityModel[] }[] = [];
  const generated = used.filter(model => GENERATED_MOBILITY_MODELS.includes(model));
  if (generated.length) sources.push({ path: '/public-assets/landscape/campus-mobility.glb', names: generated });
  for (const model of used) if (!GENERATED_MOBILITY_MODELS.includes(model)) sources.push({ path: `/public-assets/vehicles/${model.replace(/^mobility-/, '')}.glb`, names: [model] });
  return sources;
}

let cached: MobilityLibrary | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (models: MobilityLibrary) => {
  cached = new Map([...(cached ?? []), ...models]);
  listeners.forEach(listener => listener());
};

async function loadSource(path: string, names: readonly MobilityModel[]): Promise<void> {
  const url = { ...campusUrls, ...vehicleUrls }[path];
  if (!url) return;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    try {
      const models = bakeCampusMobilityModels(gltf.scene, names);
      if (models) publish(models);
    } finally { disposeImportedScene(gltf.scene); }
  } catch { /* This file's models keep their procedural fallback. */ }
}

function load() {
  if (requested || procedural) return;
  requested = true;
  for (const { path, names } of mobilitySources()) void loadSource(path, names);
}

/** Renderer-lifetime shared cache; each model shows its fallback until its own file has loaded. */
export function useCampusMobilityModels(): MobilityLibrary | null {
  const models = useSyncExternalStore(subscribe, () => cached, () => null);
  useEffect(() => { load(); }, []);
  return models;
}
