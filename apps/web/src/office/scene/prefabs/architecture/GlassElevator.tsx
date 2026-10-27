/* eslint-disable react-hooks/immutability -- Mutable Three.js cab/material transforms are owned by the renderer. */
import { FixtureSpotLight } from "./FixtureSpotLight";
import { OFFICE_BUILDING } from "../../layout";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group} from "three";
import { DoubleSide, MeshStandardMaterial, Object3D } from "three";
import { useCampusModelReady } from "../../campusModels";
import { StaticCampusBatch } from "../../StaticCampusBatch";
import { useSolarEnvironment } from "../../Environment";
import type { FurnishedOfficeView } from "../../FurnishedFloors";
import { getElevatorGeometry, type ElevatorId, ELEVATOR_FLOOR_HEIGHT, elevatorSnapshot, floorElevation, tickElevator, type ElevatorFloor, type ElevatorSnapshot } from "./elevatorController";

const FLOORS: ElevatorFloor[] = [1, 2, 3];
const SHAFT_TOP = ELEVATOR_FLOOR_HEIGHT * 3 + 0.9;

/** A through-trip remains visible throughout the nearest floor's height band, as well as at its endpoints. */
export function elevatorCabVisible(snapshot: Pick<ElevatorSnapshot, "y" | "passengers">, view: FurnishedOfficeView): boolean {
  return view === "campus" || view === "stack" ||
    Math.abs(snapshot.y - floorElevation(view)) <= ELEVATOR_FLOOR_HEIGHT / 2 ||
    snapshot.passengers.some(passenger => view === passenger.from || view === passenger.to);
}

/** One motor timeline drives both the panoramic cab and its actual passenger. */
export function GlassElevator({ elevatorId = "A", view }: { elevatorId?: ElevatorId; view: FurnishedOfficeView }) {
  const { state, lightsOn, lightOverride } = useSolarEnvironment();
  const focus = view;
  const night = Math.max(
    state.factors.exteriorLightFactor,
    state.factors.interiorLightFactor,
    state.factors.nightFactor,
    lightOverride === "off" || !lightsOn ? 0.92 : 0
  );
  const cab = useRef<Group>(null);
  const cabDoors = useRef<Group>(null);
  const landingDoors = useRef<Array<Group | null>>([]);
  // The cab's beam is a real light parented to the moving cab, so its pool travels with it. (A baked
  // fixture would stay where the cab was when the irradiance volume was last baked.) One wide spot per
  // cab replaces the former baked beam + point light pair, so the scene's light count does not grow.
  const cabBeamTarget = useMemo(() => new Object3D(), []);
  const materials = useMemo(() => ({
    glass: new MeshStandardMaterial({ color: "#b1cdd9", metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide }),
    door: new MeshStandardMaterial({ color: "#d7e0e5", metalness: 0.55, roughness: 0.3 }),
    rail: new MeshStandardMaterial({ color: "#d7e0e5", metalness: 0.55, roughness: 0.4 }),
    trim: new MeshStandardMaterial({ color: "#aebec8", metalness: 0.6, roughness: 0.28 }),
    floor: new MeshStandardMaterial({ color: "#425360", metalness: 0.25, roughness: 0.55 }),
    light: new MeshStandardMaterial({ color: "#ffe4be", emissive: "#ffdca8", emissiveIntensity: 0, roughness: 0.25, toneMapped: false }),
    led: new MeshStandardMaterial({ color: "#e8dfc9", emissive: "#ffdfa6", emissiveIntensity: 0, roughness: 0.28, toneMapped: false }),
    accent: new MeshStandardMaterial({ color: "#286c88", emissive: "#38bdf8", emissiveIntensity: 0, roughness: 0.3, toneMapped: false })
  }), []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  useEffect(() => {
    materials.light.emissiveIntensity = night * 2.2;
    materials.led.emissiveIntensity = night * 1.75;
    materials.accent.emissiveIntensity = night * 1.35;
  }, [materials, night]);
  const { x, z, doorX, doorWidth, shaftWidth: sw, shaftDepth: sd, cabWidth: cw, cabDepth: cd, cabHeight: ch } = getElevatorGeometry(elevatorId);
  const jambZ = doorWidth / 2 + 0.12;
  const bridgeHalfDepth = doorWidth / 2 + 0.25;
  const allFloors = focus === "campus" || focus === "stack";
  // With the Blender lift frames on screen, this shaft and the landing frames step aside in the
  // whole-building views (the model spans every floor); single-floor views keep these landings.
  const framesFromModel = useCampusModelReady("elevators") && allFloors;
  useFrame((_, delta) => {
    tickElevator(delta, elevatorId);
    const snapshot = elevatorSnapshot(elevatorId);
    if (cab.current) {
      cab.current.position.y = snapshot.y;
      cab.current.visible = elevatorCabVisible(snapshot, focus);
    }
    const slide = (group: Group | null, open: number) => {
      group?.children.forEach((panel, i) => { panel.position.z = (i === 0 ? -1 : 1) * (doorWidth / 4 + open * doorWidth / 2); });
    };
    slide(cabDoors.current, snapshot.doors);
    FLOORS.forEach((floor, i) => slide(landingDoors.current[i] ?? null, snapshot.openFloor === floor ? snapshot.doors : 0));
  });
  const doors = (material: MeshStandardMaterial) => [-1, 1].map((side) => (
    <mesh key={side} position={[0, 1.24, side * doorWidth / 4]} material={material}>
      <boxGeometry args={[0.065, 2.48, doorWidth / 2 - 0.015]} />
    </mesh>
  ));
  return (
    <group position={[x, 0, z]} name={`panoramic-glass-elevator-${elevatorId}`}>
      <group visible={allFloors && !framesFromModel} userData={{ officeCollision: false }}><StaticCampusBatch>
        <mesh position={[sw / 2, SHAFT_TOP / 2, 0]} rotation={[0, Math.PI / 2, 0]} material={materials.glass}><planeGeometry args={[sd, SHAFT_TOP]} /></mesh>
        {[-1, 1].map((side) => <mesh key={side} position={[0, SHAFT_TOP / 2, side * sd / 2]} material={materials.glass}><planeGeometry args={[sw, SHAFT_TOP]} /></mesh>)}
        {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <mesh key={`${sx}-${sz}`} position={[sx * sw / 2, SHAFT_TOP / 2, sz * sd / 2]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[0.16, SHAFT_TOP, 0.16]} /></mesh>))}
        {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <mesh key={`shaft-led-${sx}-${sz}`} position={[sx * (sw / 2 - 0.09), SHAFT_TOP / 2, sz * (sd / 2 - 0.09)]} material={materials.led} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-led` }}><boxGeometry args={[0.028, SHAFT_TOP - 0.3, 0.028]} /></mesh>))}
        {[-1, 1].map((side) => <mesh key={side} position={[0.7, SHAFT_TOP / 2, side * (cd / 2 + 0.1)]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.06, SHAFT_TOP, 0.06]} /></mesh>)}
        <mesh position={[0, SHAFT_TOP, 0]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[sw + 0.14, 0.24, sd + 0.14]} /></mesh>
      </StaticCampusBatch></group>
      {/* Recessed shaft base stays below the F1 cabin floor and landing bridge.
          Ground paving is cut around this structure in CampusExterior. */}
      <mesh name={`elevator-${elevatorId}-shaft-base`} position={[0, -0.23, 0]}
        visible={(allFloors || focus === 1) && !framesFromModel} material={materials.floor} userData={{ officeCollision: false }}>
        <boxGeometry args={[sw + 0.22, 0.08, sd + 0.22]} />
      </mesh>
      {FLOORS.map((floor, index) => (
        <group key={floor} position={[0, floorElevation(floor), 0]} visible={allFloors || focus === floor} name={`elevator-${elevatorId}-landing-F${floor}`}>
          <FixtureSpotLight name={`elevator-${elevatorId}-landing-light-F${floor}`} position={[doorX - x - 0.28, 2.68, 0]}
            aim={[doorX - x - 0.55, 0, 0]} intensity={night * 38} distance={3.8} angle={0.95} penumbra={0.55} color="#ffebd0" />
          <group visible={!framesFromModel}><StaticCampusBatch>
            {/* Steel perimeter rings tie every landing into the four shaft columns.
                Beams stay below the threshold or above the doorway, leaving the cab void clear. */}
            {[-0.18, 3.0].map((beamY) => (
              <group key={beamY} name={`elevator-${elevatorId}-floor-${floor}-frame-${beamY}`}>
                {[-1, 1].map((side) => <mesh key={`cross-${side}`} position={[side * sw / 2, beamY, 0]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[0.22, 0.28, sd + 0.2]} /></mesh>)}
                {[-1, 1].map((side) => <mesh key={`long-${side}`} position={[0, beamY, side * sd / 2]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[sw + 0.2, 0.28, 0.22]} /></mesh>)}
                {/* Bolted corner collars make the floor support visually legible. */}
                {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <mesh key={`${sx}-${sz}`} position={[sx * sw / 2, beamY, sz * sd / 2]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.27, 0.36, 0.27]} /></mesh>))}
              </group>
            ))}
            {/* Emissive landing LED strips and doorway accent bars for night illumination. */}
            {[-1, 1].map((side) => <mesh key={`led-side-${side}`} position={[0, 3.02, side * (sd / 2 + 0.12)]} material={materials.led} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-led` }}><boxGeometry args={[sw, 0.035, 0.025]} /></mesh>)}
            <mesh position={[sw / 2 + 0.12, 3.02, 0]} material={materials.led} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-led` }}><boxGeometry args={[0.025, 0.035, sd]} /></mesh>
            <mesh position={[doorX - x - 0.12, 2.65, 0]} material={materials.accent} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-accent` }}><boxGeometry args={[0.02, 0.025, doorWidth]} /></mesh>
            {/* Flush bridge stops before the cabin; no fixed slab crosses the shaft. */}
            <mesh name={`elevator-${elevatorId}-bridge-F${floor}`} position={[(OFFICE_BUILDING.east + x - cw / 2) / 2 - x, -0.08, 0]} material={materials.floor}><boxGeometry args={[x - cw / 2 - OFFICE_BUILDING.east, 0.16, bridgeHalfDepth * 2]} /></mesh>
            {[-1, 1].map((side) => <mesh key={`bridge-${side}`} position={[OFFICE_BUILDING.east + 0.35 - x, 0.55, side * bridgeHalfDepth]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[0.55, 1.1, 0.06]} /></mesh>)}
            {[-1, 1].map((side) => <mesh key={side} position={[doorX - x, 1.35, side * jambZ]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.2, 2.7, 0.16]} /></mesh>)}
            <mesh position={[doorX - x, 2.62, 0]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.2, 0.16, jambZ * 2 + 0.16]} /></mesh>
            <mesh position={[doorX - x - 0.11, 2.77, 0]} material={materials.trim}><boxGeometry args={[0.025, 0.075, 0.7]} /></mesh>
            <mesh position={[doorX - x - 0.15, 1.05, jambZ + 0.17]} material={materials.rail} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-frame` }}><boxGeometry args={[0.07, 0.28, 0.14]} /></mesh>
          </StaticCampusBatch></group>
          <group position={[doorX - x, 0, 0]} ref={(g) => { landingDoors.current[index] = g; }} userData={{ officeCollision: false, officeDynamic: true }} name={`elevator-${elevatorId}-landing-doors-F${floor}`}>{doors(materials.door)}</group>
        </group>
      ))}
      {/* Dynamic surfaces are gated by the transit controller, never baked into A*. */}
      <group ref={cab} userData={{ officeCollision: false, officeDynamic: true }} name={`elevator-${elevatorId}-cabin`}>
        <primitive object={cabBeamTarget} position={[0, 0.05, 0]} />
        {night > 0.01 && <spotLight name={`elevator-${elevatorId}-ceiling-light`} position={[0, ch - 0.06, 0]} target={cabBeamTarget}
          intensity={night * 62} distance={ch + 2.6} angle={1.1} penumbra={0.65} decay={2} color="#fff2de" />}
        <mesh name={`elevator-${elevatorId}-cabin-floor`} position={[0, -0.06, 0]} material={materials.floor} castShadow receiveShadow><boxGeometry args={[cw, 0.12, cd]} /></mesh>
        <mesh position={[0, ch + 0.04, 0]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[cw, 0.08, cd]} /></mesh>
        {/* Frosted ceiling panel: luminous underside and thin edges, opaque upper housing. */}
        <mesh name={`elevator-${elevatorId}-ceiling-diffuser`} position={[0, ch - 0.04, 0]}
          material={[materials.light, materials.light, materials.trim, materials.light, materials.light, materials.light]}>
          <boxGeometry args={[cw * 0.72, 0.07, cd * 0.72]} />
        </mesh>
        {[-1, 1].map((side) => <mesh key={`cab-led-${side}`} position={[0, ch - 0.02, side * (cd / 2 - 0.04)]} material={materials.led}><boxGeometry args={[cw * 0.88, 0.022, 0.022]} /></mesh>)}
        <mesh position={[cw / 2, ch / 2, 0]} rotation={[0, Math.PI / 2, 0]} material={materials.glass}><planeGeometry args={[cd, ch]} /></mesh>
        {[-1, 1].map((side) => <mesh key={side} position={[0, ch / 2, side * cd / 2]} material={materials.glass}><planeGeometry args={[cw, ch]} /></mesh>)}
        <mesh position={[cw / 2 - 0.06, 1.1, 0]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.04, 0.04, cd * 0.8]} /></mesh>
        <mesh position={[cw / 2 - 0.06, 1.07, 0]} material={materials.accent}><boxGeometry args={[0.024, 0.014, cd * 0.76]} /></mesh>
        {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <mesh key={`${sx}-${sz}`} position={[sx * cw / 2, ch / 2, sz * cd / 2]} material={materials.trim} userData={{ officeMaterialDynamic: `elevator-${elevatorId}-trim` }}><boxGeometry args={[0.045, ch, 0.045]} /></mesh>))}
        <group position={[-cw / 2, 0, 0]} ref={cabDoors}>{doors(materials.door)}</group>
      </group>
    </group>
  );
}
