import { OFFICE_BUILDING } from "./layout";
import { createRef, type RefObject } from "react";
import type { Group } from "three";
import { F3_TERRACE } from "./floor1Layout";
import { MAINTENANCE_STAIR_LAYOUT } from "./prefabs/architecture/RoofMaintenanceStair";
import { ROOF_FAN_MOTORS, RoofFanMotion } from "./roofFanMotion";

const ROOF_SURFACE = 19.33;

/** Low-profile rooftop water storage and central air-conditioning equipment. */
function WaterTank({ position }: { position: [number, number, number] }) {
  return (
    <group position={position} scale={1.38} name="roof-water-storage-tank">
      {/* Short service stand */}
      {([[-0.72, -0.7], [0.72, -0.7], [-0.72, 0.7], [0.72, 0.7]] as const).map(([x, z]) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, 0.24, z]}>
          <boxGeometry args={[0.12, 0.48, 0.12]} />
          <meshStandardMaterial color="#69777a" metalness={0.45} roughness={0.55} />
        </mesh>
      ))}
      <mesh castShadow position={[0, 0.53, 0]}>
        <cylinderGeometry args={[0.94, 0.94, 0.12, 24]} />
        <meshStandardMaterial color="#69777a" metalness={0.42} roughness={0.58} />
      </mesh>
      <mesh castShadow position={[0, 1.55, 0]}>
        <cylinderGeometry args={[0.86, 0.86, 1.95, 24]} />
        <meshStandardMaterial color="#9caeaa" metalness={0.35} roughness={0.48} />
      </mesh>
      <mesh castShadow position={[0, 2.55, 0]}>
        <cylinderGeometry args={[0.86, 0.86, 0.1, 24]} />
        <meshStandardMaterial color="#778b89" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh castShadow position={[0, 2.64, 0]}>
        <cylinderGeometry args={[0.19, 0.19, 0.1, 16]} />
        <meshStandardMaterial color="#56696a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh castShadow position={[0.87, 1.45, 0]}>
        <boxGeometry args={[0.08, 1.45, 0.08]} />
        <meshStandardMaterial color="#617677" metalness={0.5} roughness={0.48} />
      </mesh>
    </group>
  );
}

function AirHandler({ position, rotation = 0, rotors, motorOffset }: {
  position: [number, number, number]; rotation?: number;
  rotors: RefObject<Group | null>[]; motorOffset: number;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={1.4} name="roof-central-air-handler">
      <mesh castShadow position={[0, 0.66, 0]}>
        <boxGeometry args={[2.45, 1.32, 1.75]} />
        <meshStandardMaterial color="#a5aaa4" metalness={0.3} roughness={0.68} />
      </mesh>
      <mesh castShadow position={[0, 1.34, 0]}>
        <boxGeometry args={[2.5, 0.08, 1.8]} />
        <meshStandardMaterial color="#737e7d" metalness={0.42} roughness={0.55} />
      </mesh>
      {[ -0.68, 0.68 ].map((x, fanIndex) => (
        <group key={x} position={[x, 1.4, 0]}>
          <mesh>
            <cylinderGeometry args={[0.43, 0.43, 0.08, 20]} />
            <meshStandardMaterial color="#687575" metalness={0.5} roughness={0.48} />
          </mesh>
          <mesh position={[0, 0.064, 0]}>
            <cylinderGeometry args={[0.37, 0.37, 0.025, 20]} />
            <meshStandardMaterial color="#273939" metalness={0.35} roughness={0.72} />
          </mesh>
          {/* Four silver blades remain visible below the fine protective grille. */}
          <group name={`roof-fan-rotor-${motorOffset + fanIndex}`} ref={rotors[motorOffset + fanIndex]!}
            rotation={[0, ROOF_FAN_MOTORS[motorOffset + fanIndex]!.phase, 0]}
            userData={{ officeDynamic: true, officeCollision: false }}>
          {[0, 1, 2, 3].map(blade => {
            const angle = blade * Math.PI / 2 + 0.18;
            return <mesh key={`blade-${blade}`} position={[Math.cos(angle) * 0.19, 0.095, -Math.sin(angle) * 0.19]}
              rotation={[0, angle + 0.12, 0]}>
              <boxGeometry args={[0.29, 0.025, 0.11]} />
              <meshStandardMaterial color="#a3b1ad" metalness={0.38} roughness={0.45} />
            </mesh>;
          })}
          <mesh position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.088, 0.1, 0.07, 12]} />
            <meshStandardMaterial color="#a3b1ad" metalness={0.38} roughness={0.45} />
          </mesh>
          </group>
          {[-0.24, -0.12, 0, 0.12, 0.24].flatMap(offset => [0, 1].map(axis => (
            <mesh key={`grille-${axis}-${offset}`} position={[axis ? offset : 0, 0.154, axis ? 0 : offset]}
              rotation={[0, axis ? Math.PI / 2 : 0, 0]}>
              <boxGeometry args={[2 * Math.sqrt(0.38 ** 2 - offset ** 2), 0.012, 0.012]} />
              <meshStandardMaterial color="#687575" metalness={0.5} roughness={0.48} />
            </mesh>
          )))}
        </group>
      ))}
      <mesh position={[0, 0.66, 0.89]}>
        <boxGeometry args={[1.85, 0.92, 0.035]} />
        <meshStandardMaterial color="#899693" metalness={0.35} roughness={0.56} />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} position={[-0.78 + i * 0.22, 0.66, 0.92]}>
          <boxGeometry args={[0.045, 0.82, 0.025]} />
          <meshStandardMaterial color="#606d6c" metalness={0.35} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Louver screens conceal service equipment; gaps face the maintenance paths. */
function ServiceScreen({ west, east, north, south, gateSide, gateZ }: {
  west: number; east: number; north: number; south: number; gateSide: "west" | "east" | "both"; gateZ: number;
}) {
  const segments = [
    { x: (west + east) / 2, z: north, length: east - west, side: false },
    { x: (west + east) / 2, z: south, length: east - west, side: false },
    ...(gateSide === "both" ? [] : [{ x: gateSide === "west" ? east : west,
      z: (north + south) / 2, length: south - north, side: true }]),
    ...(gateSide === "both" ? [west, east] : [gateSide === "west" ? west : east]).flatMap(x => [
      { x, z: (north + gateZ - 0.75) / 2, length: gateZ - 0.75 - north, side: true },
      { x, z: (gateZ + 0.75 + south) / 2, length: south - gateZ - 0.75, side: true }
    ])
  ];
  return <group name="roof-service-screen">
    {segments.map((segment, i) => <group key={i} position={[segment.x, ROOF_SURFACE, segment.z]} rotation={[0, segment.side ? Math.PI / 2 : 0, 0]}>
      {Array.from({ length: 6 }, (_, level) => <mesh key={level} castShadow position={[0, 0.22 + level * 0.27, 0]}>
        <boxGeometry args={[segment.length, 0.18, 0.07]} /><meshStandardMaterial color="#697b7b" metalness={0.56} roughness={0.48} />
      </mesh>)}
      {[-1, 1].map(side => <mesh key={side} castShadow position={[side * (segment.length / 2 - 0.025), 0.85, 0]}>
        <boxGeometry args={[0.065, 1.7, 0.085]} /><meshStandardMaterial color="#4b5c5c" metalness={0.62} roughness={0.42} />
      </mesh>)}
    </group>)}
  </group>;
}

/** Roof details use the same setback as the enclosed F3 volume, leaving its terrace open. */
function RoofSurfaceDetails() {
  const north = OFFICE_BUILDING.north + 0.8;
  const south = F3_TERRACE.north - 0.8;
  return <group name="roof-maintenance-details">
    {/* Sparse standing seams give the membrane a readable construction scale. */}
    {[-18, -12, -6, 0, 6, 12, 18].map(x => <mesh key={`seam-x-${x}`} position={[x, ROOF_SURFACE, (north + south) / 2]}>
      <boxGeometry args={[0.026, 0.007, south - north]} /><meshStandardMaterial color="#9ba8aa" roughness={0.9} />
    </mesh>)}
    {[-15, -9, -3, 3, 9].filter(z => z < south).map(z => <mesh key={`seam-z-${z}`} position={[OFFICE_BUILDING.centerX, ROOF_SURFACE, z]}>
      <boxGeometry args={[OFFICE_BUILDING.width - 1.6, 0.007, 0.026]} /><meshStandardMaterial color="#9ba8aa" roughness={0.9} />
    </mesh>)}
    {/* Non-slip paths connect the hatch to two screened service bays. */}
    {[
      { position: [2, ROOF_SURFACE + 0.015, -1] as const, size: [32, 0.025, 1.15] as const },
      { position: [-10, ROOF_SURFACE + 0.015, 4.8] as const, size: [1.15, 0.025, 11.6] as const },
      { position: [7.7, ROOF_SURFACE + 0.015, 4.6] as const, size: [1.15, 0.025, 11.2] as const },
      { position: [4.4, ROOF_SURFACE + 0.015, -2.8] as const, size: [1.15, 0.025, 3.6] as const },
      { position: [(MAINTENANCE_STAIR_LAYOUT.landingEast - 10) / 2, ROOF_SURFACE + 0.015, MAINTENANCE_STAIR_LAYOUT.roofGate[2]!] as const,
        size: [-10 - MAINTENANCE_STAIR_LAYOUT.landingEast, 0.025, MAINTENANCE_STAIR_LAYOUT.gateWidth] as const }
    ].map((path, i) => <mesh key={i} receiveShadow position={[...path.position]}>
      <boxGeometry args={[...path.size]} /><meshStandardMaterial color="#71817d" roughness={0.96} />
    </mesh>)}
    <group name="roof-maintenance-hatch" position={[4.4, ROOF_SURFACE, -4.6]}>
      <mesh castShadow position={[0, 0.13, 0]}><boxGeometry args={[1.9, 0.26, 2.35]} /><meshStandardMaterial color="#5e6d6d" metalness={0.45} roughness={0.64} /></mesh>
      <mesh castShadow position={[0, 0.29, 0]}><boxGeometry args={[1.8, 0.07, 2.25]} /><meshStandardMaterial color="#b3bdb7" metalness={0.52} roughness={0.5} /></mesh>
      <mesh position={[0.55, 0.36, 0.65]}><boxGeometry args={[0.32, 0.055, 0.065]} /><meshStandardMaterial color="#394b4c" metalness={0.75} roughness={0.3} /></mesh>
      {[-0.57, 0.57].map(x => <mesh key={x} position={[x, 0.32, -1.05]}><boxGeometry args={[0.25, 0.07, 0.15]} /><meshStandardMaterial color="#4b5d5e" metalness={0.68} roughness={0.35} /></mesh>)}
    </group>
    {/* Drain sumps near each parapet corner and capped ventilation risers. */}
    {[OFFICE_BUILDING.west + 1.2, OFFICE_BUILDING.east - 1.2].flatMap(x => [north + 0.55, south - 0.55].map(z =>
      <group key={`drain-${x}-${z}`} position={[x, ROOF_SURFACE + 0.014, z]} name="roof-drain-outlet">
        <mesh><cylinderGeometry args={[0.23, 0.23, 0.025, 16]} /><meshStandardMaterial color="#526264" metalness={0.52} roughness={0.6} /></mesh>
        <mesh position={[0, 0.019, 0]}><boxGeometry args={[0.26, 0.015, 0.055]} /><meshStandardMaterial color="#253839" roughness={0.8} /></mesh>
      </group>))}
    {[-3, 0, 3].map(x => <group key={x} name="roof-vent-riser" position={[x, ROOF_SURFACE, 8.8]}>
      <mesh castShadow position={[0, 0.28, 0]}><cylinderGeometry args={[0.14, 0.14, 0.56, 12]} /><meshStandardMaterial color="#84948f" metalness={0.55} roughness={0.46} /></mesh>
      <mesh castShadow position={[0, 0.59, 0]}><cylinderGeometry args={[0.23, 0.23, 0.065, 12]} /><meshStandardMaterial color="#596d69" metalness={0.58} roughness={0.48} /></mesh>
    </group>)}
  </group>;
}

export function RoofUtilities() {
  const rotors = ROOF_FAN_MOTORS.map(() => createRef<Group>());
  return (
    <group name="extalia-roof-services">
      <RoofFanMotion rotors={rotors} />
      <RoofSurfaceDetails />
      {/* Screened mechanical bays stop well before the F3 terrace starts at z=13. */}
      {[-16.65, -13.25].map(x => <WaterTank key={x} position={[x, 19.3, 9]} />)}
      {[11.9, 17.3].flatMap((x, row) => [2.8, 7.4].map((z, column) =>
        <AirHandler key={`${x}-${z}`} position={[x, 19.3, z]} rotors={rotors} motorOffset={(row * 2 + column) * 2} />))}
      <ServiceScreen west={-19} east={-11.1} north={4.8} south={11.6} gateSide="both" gateZ={6.2} />
      <ServiceScreen west={8.9} east={20.8} north={0.6} south={10.8} gateSide="west" gateZ={5.4} />
    </group>
  );
}
