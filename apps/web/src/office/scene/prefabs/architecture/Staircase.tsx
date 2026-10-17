/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useEffect, useMemo } from "react";
import { BufferGeometry, DoubleSide, Float32BufferAttribute, MeshStandardMaterial } from "three";
import { OFFICE_STAIRCASE, OFFICE_STAIR_LAYOUT } from "../../layout";
import { useSolarEnvironment } from "../../Environment";
import { FixtureSpotLight } from "./FixtureSpotLight";

const GUARD_HEIGHT = 1.12;
const GLASS_BOTTOM = 0.08;
const STAIR_LIGHT_COLOR = "#fff0db";
const LED_DYNAMIC = { officeMaterialDynamic: "stair-led:interior:#fff0db:factor*1.5" };

/** The same finishes and warm night lighting continue over flights and landings. */
function useStairMaterials(ledEmissive?: number, exterior = false) {
  const { state } = useSolarEnvironment();
  const intensity = ledEmissive ?? (exterior ? state.factors.exteriorLightFactor * 6 : state.factors.interiorLightFactor * 1.5);
  const materials = useMemo(() => ({
    glass: new MeshStandardMaterial({ color: "#d7e8e7", transparent: true, opacity: 0.23,
      roughness: 0.12, metalness: 0.08, depthWrite: false, side: DoubleSide }),
    metal: new MeshStandardMaterial({ color: "#b8c1c4", roughness: 0.26, metalness: 0.82 }),
    structure: new MeshStandardMaterial({ color: "#30363b", roughness: 0.5, metalness: 0.65 }),
    oak: new MeshStandardMaterial({ color: "#b59a78", roughness: 0.66, metalness: 0.02 }),
    stone: new MeshStandardMaterial({ color: "#d7d4cb", roughness: 0.86 }),
    grip: new MeshStandardMaterial({ color: "#6d716e", roughness: 0.92 }),
    led: new MeshStandardMaterial({ color: "#eee5d7", emissive: exterior ? "#ffd4a3" : STAIR_LIGHT_COLOR, emissiveIntensity: 0,
      roughness: 0.5, toneMapped: false })
  }), [exterior]);
  // StaticCampusBatch retains this material reference, so every merged LED follows dusk.
  materials.led.emissiveIntensity = intensity;
  useEffect(() => () => Object.values(materials).forEach(material => material.dispose()), [materials]);
  return materials;
}

/** Small downlights fixed below the outside handrails; no fittings enter the walking lanes. */
function StairFlightLighting({ width, rise, run, midLandingDepth, floorY }: {
  width: number; rise: number; run: number; midLandingDepth: number; floorY: number;
}) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const gap = OFFICE_STAIRCASE.gap;
  const halfRise = rise / 2;
  const xOffset = (width + gap) / 2;
  const outerX = width + gap / 2 + OFFICE_STAIR_LAYOUT.padOverhang - OFFICE_STAIR_LAYOUT.guardInset;
  const fixtures: { position: [number, number, number]; aim: [number, number, number]; name: string }[] = [];
  for (const direction of [1, -1] as const) {
    const baseY = direction === 1 ? 0 : halfRise;
    const centerX = -direction * (width + gap) / 2;
    for (const t of [0.18, 0.46, 0.74, 0.94]) {
      const surfaceY = baseY + halfRise * t;
      const z = direction * run * (t - 0.5);
      fixtures.push({ position: [-direction * outerX, surfaceY + 1.02, z],
        aim: [centerX, surfaceY + 0.035, z], name: `stair-rail-downlight-${direction}-${t}` });
    }
  }
  // The rear rail illuminates both passing lanes (0.65 m and 1.95 m) and the central crossing.
  const turnZ = run / 2 + midLandingDepth - OFFICE_STAIR_LAYOUT.guardInset;
  const turnAimZ = run / 2 + midLandingDepth / 2;
  const turnStops = [-xOffset, -xOffset * 0.35, xOffset * 0.35, xOffset];
  for (const x of turnStops) {
    const isCenter = Math.abs(x) < xOffset * 0.5;
    const aimZ = isCenter ? run / 2 + (x > 0 ? OFFICE_STAIRCASE.midLandingDownOffset : OFFICE_STAIRCASE.midLandingUpOffset) : turnAimZ;
    fixtures.push({ position: [x, halfRise + 1.02, turnZ],
      aim: [x, halfRise + 0.035, aimZ], name: `stair-turn-downlight-${x.toFixed(2)}` });
  }
  return <group name="stair-rail-downlights">
    {fixtures.map(({ position, aim, name }) => <group key={name} position={position}>
      <mesh><boxGeometry args={[0.06, 0.1, 0.06]} />
        <meshStandardMaterial color="#60686b" roughness={0.36} metalness={0.7} /></mesh>
      <mesh position={[0, -0.053, 0]} userData={LED_DYNAMIC}>
        <boxGeometry args={[0.045, 0.009, 0.045]} />
        <meshStandardMaterial color="#eee5d7" emissive={STAIR_LIGHT_COLOR} emissiveIntensity={factor * 1.5} roughness={0.45} toneMapped={false} />
      </mesh>
      <FixtureSpotLight position={[0, -0.06, 0]} aim={[aim[0] - position[0]!, aim[1] - position[1]!, aim[2] - position[2]!]}
        intensity={28 * factor} color={STAIR_LIGHT_COLOR} distance={3.8} angle={0.88} floorY={floorY} name={name} />
    </group>)}
  </group>;
}

type StairMaterials = ReturnType<typeof useStairMaterials>;

/** A glass prism with vertical ends: rotating a tall box would tilt the guard itself. */
function slopedGlass(run: number, rise: number, direction: 1 | -1, t0: number, t1: number) {
  const positions: number[] = [];
  for (const x of [-0.014, 0.014]) {
    positions.push(
      x, rise * t0 + GLASS_BOTTOM, direction * run * t0,
      x, rise * t1 + GLASS_BOTTOM, direction * run * t1,
      x, rise * t1 + GUARD_HEIGHT, direction * run * t1,
      x, rise * t0 + GUARD_HEIGHT, direction * run * t0
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  // Opposite flights reverse Z, so keep outward-facing winding consistent.
  if (direction === 1) for (let i = 0; i < indices.length; i += 3) [indices[i + 1]!, indices[i + 2]!] = [indices[i + 2]!, indices[i + 1]!];
  geometry.setIndex(indices);
  const faceted = geometry.toNonIndexed();
  faceted.computeVertexNormals();
  geometry.dispose();
  return faceted;
}

function FlightGlassRail({ x, baseY, startZ, run, rise, direction, materials }: {
  x: number; baseY: number; startZ: number; run: number; rise: number;
  direction: 1 | -1; materials: StairMaterials;
}) {
  const panelCount = Math.ceil(run / 1.15);
  const panels = useMemo(() => Array.from({ length: panelCount }, (_, i) =>
    slopedGlass(run, rise, direction, (i + 0.004) / panelCount, (i + 0.996) / panelCount)
  ), [panelCount, run, rise, direction]);
  useEffect(() => () => panels.forEach(panel => panel.dispose()), [panels]);
  const length = Math.hypot(run, rise);
  const angle = -Math.atan2(rise, run) * direction;
  return (
    <group position={[x, baseY, startZ]}>
      {panels.map((geometry, i) => <mesh key={i} geometry={geometry} material={materials.glass} />)}
      {/* Brushed top cap and base shoe share the exact glass slope and vertical offset. */}
      <mesh position={[0, rise / 2 + GUARD_HEIGHT, direction * run / 2]} rotation={[angle, 0, 0]} material={materials.metal}>
        <boxGeometry args={[0.052, 0.036, length]} />
      </mesh>
      <mesh position={[0, rise / 2 + 0.055, direction * run / 2]} rotation={[angle, 0, 0]} material={materials.metal}>
        <boxGeometry args={[0.058, 0.055, length]} />
      </mesh>
      <mesh position={[0, rise / 2 + GUARD_HEIGHT - 0.026, direction * run / 2]} rotation={[angle, 0, 0]} material={materials.led} userData={LED_DYNAMIC}>
        <boxGeometry args={[0.022, 0.012, length]} />
      </mesh>
      {Array.from({ length: panelCount + 1 }, (_, i) => {
        const t = (i + 0.08) / (panelCount + 0.16);
        return <mesh key={i} position={[0, rise * t + 0.15, direction * run * t]} rotation={[0, 0, Math.PI / 2]} material={materials.metal}>
          <cylinderGeometry args={[0.025, 0.025, 0.064, 12]} />
        </mesh>;
      })}
    </group>
  );
}

function LandingGlassRail({ position, length, rotationY = 0, materials, ledDynamic = LED_DYNAMIC }: {
  position: [number, number, number]; length: number; rotationY?: number; materials: StairMaterials;
  ledDynamic?: { officeMaterialDynamic: string };
}) {
  const panelCount = Math.max(1, Math.ceil(length / 1.15));
  const panelWidth = length / panelCount;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {Array.from({ length: panelCount }, (_, i) => (
        <group key={i} position={[-length / 2 + panelWidth * (i + 0.5), 0, 0]}>
          <mesh position={[0, (GUARD_HEIGHT + GLASS_BOTTOM) / 2, 0]} material={materials.glass}>
            <boxGeometry args={[panelWidth - 0.008, GUARD_HEIGHT - GLASS_BOTTOM, 0.028]} />
          </mesh>
          {[-0.32, 0.32].map(side => <mesh key={side} position={[panelWidth * side, 0.15, 0]} rotation={[Math.PI / 2, 0, 0]} material={materials.metal}>
            <cylinderGeometry args={[0.025, 0.025, 0.064, 12]} />
          </mesh>)}
        </group>
      ))}
      <mesh position={[0, GUARD_HEIGHT, 0]} material={materials.metal}>
        <boxGeometry args={[length, 0.036, 0.052]} />
      </mesh>
      <mesh position={[0, 0.055, 0]} material={materials.metal}>
        <boxGeometry args={[length, 0.055, 0.058]} />
      </mesh>
      <mesh position={[0, GUARD_HEIGHT - 0.026, 0]} material={materials.led} userData={ledDynamic}>
        <boxGeometry args={[length, 0.012, 0.022]} />
      </mesh>
    </group>
  );
}

/** Shared safety glass for every exposed floor edge, with automatic night lighting. */
export function LandingRail({ position, length, rotationY = 0, ledEmissive, exterior = false }: {
  position: [number, number, number]; length: number; rotationY?: number; ledEmissive?: number; exterior?: boolean;
}) {
  const materials = useStairMaterials(ledEmissive, exterior);
  return <LandingGlassRail position={position} length={length} rotationY={rotationY} materials={materials}
    ledDynamic={exterior ? { officeMaterialDynamic: "terrace-led:exterior:#ffd4a3:factor*6" } : LED_DYNAMIC} />;
}

/** Wide oak switchback stairs with continuous glass protection and recessed tread LEDs. */
export function Staircase({
  position = [0, 0, 0], width = OFFICE_STAIRCASE.width, rise = OFFICE_STAIRCASE.rise,
  runPerFlight = OFFICE_STAIRCASE.runPerFlight, stepsPerFlight = OFFICE_STAIRCASE.stepsPerFlight,
  midLandingDepth = OFFICE_STAIRCASE.midLandingDepth
}: {
  position?: [number, number, number]; width?: number; rise?: number;
  runPerFlight?: number; stepsPerFlight?: number; midLandingDepth?: number;
}) {
  const materials = useStairMaterials();
  const halfRise = rise / 2;
  const tread = runPerFlight / stepsPerFlight;
  const stepRise = halfRise / stepsPerFlight;
  const gap = OFFICE_STAIRCASE.gap;
  const xOffset = (width + gap) / 2;
  const fullWidth = width * 2 + gap + OFFICE_STAIR_LAYOUT.padOverhang * 2;
  // Keep fittings inside the slab boundary, including their 32 mm standoff radius.
  const guardInset = OFFICE_STAIR_LAYOUT.guardInset;
  const outerRailX = fullWidth / 2 - guardInset;
  const flightLength = Math.hypot(runPerFlight, halfRise);
  const landingDepth = OFFICE_STAIRCASE.landingDepth;
  const landingZ = runPerFlight / 2 + midLandingDepth / 2;

  return (
    <group position={position} name="office-passable-stairs" userData={{ officePassable: true }}>
      <StairFlightLighting width={width} rise={rise} run={runPerFlight} midLandingDepth={midLandingDepth} floorY={position[1]!} />
      {[0, rise].map((y, i) => (
        <mesh key={i} receiveShadow position={[i ? xOffset : -xOffset, y - 0.06, -runPerFlight / 2 - landingDepth / 2]} material={materials.stone}>
          <boxGeometry args={[width + OFFICE_STAIR_LAYOUT.padOverhang * 2, 0.12, landingDepth]} />
        </mesh>
      ))}
      {[1, -1].map(direction => {
        const baseY = direction === 1 ? 0 : halfRise;
        const centerX = direction === 1 ? -xOffset : xOffset;
        return (
          <group key={direction}>
            {/* Paired inset steel spines support the broader treads without narrowing the lanes. */}
            {[-0.28, 0.28].map(side => (
              <mesh key={side} castShadow position={[centerX + width * side, baseY + halfRise / 2 - 0.22, 0]} rotation={[-Math.atan2(halfRise, runPerFlight) * direction, 0, 0]} material={materials.structure}>
                <boxGeometry args={[0.12, 0.24, flightLength]} />
              </mesh>
            ))}
            {Array.from({ length: stepsPerFlight }, (_, i) => (
              <group key={i} name={`stair-flight-${direction === 1 ? 1 : 2}-tread-${i + 1}`} position={[
                centerX, baseY + stepRise * (i + 1),
                direction * (-runPerFlight / 2 + tread * (i + 0.5))
              ]}>
                {/* Surface elevation matches the semantic walking route. */}
                <mesh castShadow receiveShadow position={[0, -0.045, 0]} material={materials.oak}>
                  <boxGeometry args={[width, 0.09, tread + 0.025]} />
                </mesh>
                <mesh position={[0, -stepRise / 2 - 0.045, -direction * (tread / 2 - 0.025)]} material={materials.structure}>
                  <boxGeometry args={[width - 0.08, Math.max(0.04, stepRise - 0.045), 0.035]} />
                </mesh>
                {/* Front nosing faces the approaching foot on each opposite flight. */}
                <mesh position={[0, -0.09, -direction * (tread / 2 - 0.006)]} material={materials.metal}>
                  <boxGeometry args={[width - 0.12, 0.023, 0.047]} />
                </mesh>
                <mesh position={[0, -0.099, -direction * (tread / 2 + 0.004)]} material={materials.led} userData={LED_DYNAMIC}>
                  <boxGeometry args={[width - 0.16, 0.015, 0.028]} />
                </mesh>
                {[0.04, 0.064].map(inset => (
                  <mesh key={inset} position={[0, 0.001, -direction * (tread / 2 - inset)]} material={materials.grip}>
                    <boxGeometry args={[width - 0.14, 0.002, 0.007]} />
                  </mesh>
                ))}
              </group>
            ))}
            {[-1, 1].map(side => (
              <FlightGlassRail key={side}
                x={side === direction ? -direction * gap / 2 : -direction * outerRailX}
                baseY={baseY} startZ={-direction * runPerFlight / 2}
                run={runPerFlight} rise={halfRise} direction={direction as 1 | -1} materials={materials} />
            ))}
          </group>
        );
      })}
      <group position={[0, halfRise, landingZ]}>
        <mesh receiveShadow position={[0, -0.065, 0]} material={materials.stone}>
          <boxGeometry args={[fullWidth, 0.13, midLandingDepth]} />
        </mesh>
        <mesh castShadow position={[0, -0.15, 0]} material={materials.structure}>
          <boxGeometry args={[fullWidth, 0.04, midLandingDepth]} />
        </mesh>
        <mesh position={[0, -0.12, midLandingDepth / 2 - 0.018]} material={materials.led} userData={LED_DYNAMIC}>
          <boxGeometry args={[fullWidth - 0.1, 0.018, 0.025]} />
        </mesh>
      </group>
      {/* Short horizontal glass returns join sloped flight ends to the arrival guard.
          They stop before the cross-floor walking lanes, keeping the bridge open. */}
      {[{ x: -outerRailX, y: 0 }, { x: -gap / 2, y: 0 },
        { x: gap / 2, y: rise }, { x: outerRailX, y: rise }].map(({ x, y }) => (
        <LandingGlassRail key={`arrival-${x}-${y}`}
          position={[x, y, -runPerFlight / 2 - 0.15]} length={0.3}
          rotationY={Math.PI / 2} materials={materials} />
      ))}
      {/* Close the narrow central well without crossing either walking lane. */}
      <LandingGlassRail position={[0, halfRise, runPerFlight / 2]} length={gap} materials={materials} />
      {/* Three connected guards close the rear and both sides of the turning platform. */}
      <LandingGlassRail position={[0, halfRise, runPerFlight / 2 + midLandingDepth - guardInset]} length={outerRailX * 2} materials={materials} />
      {[-1, 1].map(side => (
        <LandingGlassRail key={side} position={[side * outerRailX, halfRise, landingZ - guardInset / 2]}
          length={midLandingDepth - guardInset} rotationY={Math.PI / 2} materials={materials} />
      ))}
    </group>
  );
}
