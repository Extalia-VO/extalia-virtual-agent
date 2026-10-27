import { OFFICE_BUILDING } from '../layout';
import { FRONT_APPROACH } from '../campusSiteLayout';
import { F1_EMERGENCY_EXIT } from '../floor1Layout';
import { GLASS_ELEVATORS } from '../prefabs/architecture/elevatorController';
import { FixtureSpotLight } from '../interior/prefabs/architecture/FixtureSpotLight';
import { StaticCampusBatch } from '../StaticCampusBatch';
import { useSolarEnvironment } from '../Environment';

type Point = [number, number, number];

export interface CampusLightSource {
  id: string;
  kind: 'facade' | 'entrance' | 'street' | 'uplight';
  /** Emitter (lens) position in world space. */
  position: Point;
  aim: Point;
  intensity: number;
  distance: number;
  angle: number;
  color: string;
  /** Housing yaw: the fixture faces away from the wall it is mounted on. */
  rotationY: number;
}

const WARM = '#ffdcae';
const STREET = '#ffe6c4';
const MOUNT_Y = 2.75;
const OUT = 0.34;
const b = OFFICE_BUILDING;

const facade = (id: string, position: Point, aim: Point, rotationY: number): CampusLightSource =>
  ({ id, kind: 'facade', position, aim, rotationY, intensity: 30, distance: 6.5, angle: 0.95, color: WARM });

const clearOf = (value: number, keepOut: readonly [number, number][]) => keepOut.every(([center, half]) => Math.abs(value - center) > half);
const liftKeepOut = GLASS_ELEVATORS.map(({ z, shaftDepth }) => [z, shaftDepth / 2 + 1.2] as [number, number]);
const shellScaleX = OFFICE_BUILDING.width / 42;
const shellScaleZ = OFFICE_BUILDING.depth / 30;
/** The entrance canopy's two "real light" lenses (CampusBuildingShell, mirrored and scaled). */
const CANOPY_LENSES = [-3.25, 3.25].map(x => [OFFICE_BUILDING.centerX - x * shellScaleX, 3.41, -16.45 * shellScaleZ] as Point);

/**
 * World-space emitters for the campus at night: facade downlights on the paved ring,
 * the entrance canopy, grazing uplights on the front piers and street lights along the
 * arrival road. All are baked into the shared fixture irradiance volume (real pools,
 * no painted light planes) and follow the site photocell (`exteriorLightFactor`).
 */
export const CAMPUS_LIGHT_SOURCES: readonly CampusLightSource[] = [
  // Front: clear of the entrance canopy and its sconces.
  ...[-17, -11, 13, 19].map((x, i) => facade(`north-${i}`, [x, MOUNT_Y, b.north - OUT], [x, 0, b.north - 2.6], Math.PI)),
  ...[-17, -10, -3, 4, 11, 18].map((x, i) => facade(`south-${i}`, [x, MOUNT_Y, b.south + OUT], [x, 0, b.south + 2.6], 0)),
  ...[-15, -8, -1, 5, 15].filter(z => clearOf(z, [[F1_EMERGENCY_EXIT.center[2], 2]]))
    .map((z, i) => facade(`west-${i}`, [b.west - OUT, MOUNT_Y, z], [b.west - 2.6, 0, z], -Math.PI / 2)),
  ...[-15, -9, 9, 15].filter(z => clearOf(z, liftKeepOut))
    .map((z, i) => facade(`east-${i}`, [b.east + OUT, MOUNT_Y, z], [b.east + 2.6, 0, z], Math.PI / 2)),
  ...CANOPY_LENSES.map((position, i): CampusLightSource => ({ id: `entrance-${i}`, kind: 'entrance', position,
    aim: [position[0] * 0.7, 0, position[2] - 1.2], rotationY: 0, intensity: 42, distance: 6.5, angle: 0.9, color: '#ffe3bd' })),
  // Grazing uplights at the foot of the front piers read the facade from the road.
  ...[-14, -7, 10, 17].map((x, i): CampusLightSource => ({ id: `uplight-${i}`, kind: 'uplight', position: [x, 0.12, b.north - 0.9],
    aim: [x, 7.5, b.north + 0.2], rotationY: 0, intensity: 70, distance: 10, angle: 0.36, color: '#ffd9a6' })),
  // One row along the campus side of the arrival road, leaving the entrance walk to its own lamps.
  ...[-46, -34, -22, 22, 34, 46].map((x, i): CampusLightSource => ({ id: `street-${i}`, kind: 'street',
    position: [x, FRONT_APPROACH.roadTop + 6.2, FRONT_APPROACH.roadEdgeZ - 0.4], aim: [x, FRONT_APPROACH.roadTop, FRONT_APPROACH.roadCenterZ + 0.6],
    rotationY: 0, intensity: 75, distance: 11, angle: 1.05, color: STREET })),
];

const housing = { color: '#273038', metalness: 0.55, roughness: 0.5 } as const;

function FacadeDownlight({ source, factor }: { source: CampusLightSource; factor: number }) {
  return <group position={source.position} rotation={[0, source.rotationY, 0]}>
    <mesh position={[0, 0.07, -0.1]} castShadow>
      <boxGeometry args={[0.36, 0.14, 0.3]} />
      <meshStandardMaterial {...housing} />
    </mesh>
    <mesh position={[0, -0.004, -0.06]} userData={{ officeMaterialDynamic: 'campus-facade-lens:exterior' }}>
      <boxGeometry args={[0.26, 0.012, 0.2]} />
      <meshStandardMaterial color="#ddd6c9" emissive={source.color} emissiveIntensity={factor * 1.6} toneMapped={false} />
    </mesh>
  </group>;
}

function GroundUplight({ source, factor }: { source: CampusLightSource; factor: number }) {
  return <group position={source.position}>
    <mesh position={[0, -0.06, 0]}>
      <cylinderGeometry args={[0.16, 0.16, 0.12, 14]} />
      <meshStandardMaterial {...housing} />
    </mesh>
    <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ officeMaterialDynamic: 'campus-uplight-lens:exterior' }}>
      <circleGeometry args={[0.11, 14]} />
      <meshStandardMaterial color="#e8dcc6" emissive={source.color} emissiveIntensity={factor * 2.2} toneMapped={false} />
    </mesh>
  </group>;
}

/** Slim LED street light: tapered pole, short outreach arm and a flat shielded head. */
function StreetLight({ source, factor }: { source: CampusLightSource; factor: number }) {
  const [x, y, z] = source.position;
  const base = FRONT_APPROACH.roadTop;
  const height = y - base + 0.12;
  const reach = 1.25;
  // The pole stands on the footway; the head (the emitter) reaches out over the kerb.
  return <group position={[x, base, z + reach + 0.25]}>
    <mesh position={[0, height / 2, 0]} castShadow>
      <cylinderGeometry args={[0.055, 0.085, height, 10]} />
      <meshStandardMaterial color="#3c464d" metalness={0.5} roughness={0.45} />
    </mesh>
    <mesh position={[0, height - 0.04, -reach / 2]} castShadow>
      <boxGeometry args={[0.07, 0.07, reach + 0.1]} />
      <meshStandardMaterial color="#3c464d" metalness={0.5} roughness={0.45} />
    </mesh>
    <mesh position={[0, height - 0.06, -reach - 0.25]} castShadow>
      <boxGeometry args={[0.3, 0.09, 0.62]} />
      <meshStandardMaterial {...housing} />
    </mesh>
    <mesh position={[0, height - 0.112, -reach - 0.25]} userData={{ officeMaterialDynamic: 'campus-street-lens:exterior' }}>
      <boxGeometry args={[0.22, 0.012, 0.5]} />
      <meshStandardMaterial color="#e9e4da" emissive={source.color} emissiveIntensity={factor * 2.4} toneMapped={false} />
    </mesh>
  </group>;
}

/** Night pools around the building and along the arrival road; geometry batches, beams bake. */
export function CampusNightLighting() {
  const { state } = useSolarEnvironment();
  const factor = state.factors.exteriorLightFactor;
  return <group name="campus-night-lighting">
    <StaticCampusBatch>
      {CAMPUS_LIGHT_SOURCES.map(source => source.kind === 'facade' ? <FacadeDownlight key={source.id} source={source} factor={factor} />
        : source.kind === 'uplight' ? <GroundUplight key={source.id} source={source} factor={factor} />
        : source.kind === 'street' ? <StreetLight key={source.id} source={source} factor={factor} /> : null)}
    </StaticCampusBatch>
    {factor > 0.001 && CAMPUS_LIGHT_SOURCES.map(source => <FixtureSpotLight key={source.id} name={`campus-${source.kind}-${source.id}`}
      position={source.position} aim={source.aim} intensity={source.intensity * factor} distance={source.distance}
      angle={source.angle} penumbra={0.6} color={source.color} />)}
  </group>;
}

