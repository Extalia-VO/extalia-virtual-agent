/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { ElevatorGarden } from "./prefabs/architecture/ElevatorGarden";
import { FixtureSpotLight } from "./prefabs/architecture/FixtureSpotLight";
import { useFrame } from "@react-three/fiber";
import { outdoorKioskState } from "./movement/outdoorKiosk";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh, Mesh, MeshStandardMaterial} from "three";
import { BoxGeometry, CanvasTexture, DoubleSide, Object3D, QuadraticBezierCurve3, SRGBColorSpace, Vector3 } from "three";
import { useSolarEnvironment } from "./Environment";
import { OFFICE_BUILDING } from "./layout";
import { CampusLandscape } from "./CampusLandscape";
import { FRONT_APPROACH } from "./campusSiteLayout";
import { GLASS_ELEVATORS } from "./prefabs/architecture/elevatorController";
import { CampusGrass } from "./CampusGrass";
import { PARKING_ACCESS_NOTCHES, rectsWithout } from "./campusParkingLots";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ExteriorPart } from "./ExteriorPart";
import { OutdoorSolids } from "./movement/OutdoorSolids";
import { OUTDOOR_FACILITIES_BLUEPRINT as outdoor } from "./spatialBlueprints";

/**
 * Ground level context for the Virtual Office campus: a calm stone forecourt,
 * clear main approach, restrained planting, discreet wayfinding and a planted
 * perimeter. The facade remains the visual focus from the campus overview.
 * The exterior entrance aligns with the shared CAMPUS_ENTRY_LAYOUT.
 *
 * NAVIGATION CLEARANCE INVARIANT — do not violate:
 * Agents spawn at CAMPUS_ROAD_SPAWN (the front road edge, z = -56.5) and walk
 * north along the centered paved walkway and ramp into the lobby at x = 0. The
 * corridor X in [-3.2, 3.2] from the road edge to the lobby door must stay free
 * of collidable meshes (planters, signs, benches, bikes, bollards, lamp poles,
 * trees). Only flat paving and flush LED strips may occupy that band.
 *
 * NIGHT LIGHTING: every exterior luminaire uses FixtureSpotLight, which bakes its
 * pool into the shared irradiance volume instead of adding a per-pixel light.
 * All trees and planters sit at |X| >= 24 or |Z| >= 18 (outside the building envelope).
 */


/** Warm low-contrast limestone palette used in the exterior reference. */
const PAVER_TONES = ["#aeb5b5", "#bcc2c0", "#c8cdca", "#d4d7d2", "#dde0da"];

function Tree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const crowns: [number, number, number, number, string][] = [
    [0, 4.15, 0, 1.24, "#5b8152"],
    [-0.86, 3.55, 0.15, 1.0, "#6c9258"],
    [0.82, 3.75, -0.3, 1.02, "#789b60"],
    [0.1, 3.7, 0.86, 0.94, "#557b4c"],
    [-0.22, 4.8, -0.1, 0.9, "#8baa64"]
  ] as const;
  return (
    <group position={position} scale={scale}>
      <ExteriorPart model="exterior-shade-tree">
        <mesh castShadow position={[0, 1.58, 0]}>
          <cylinderGeometry args={[0.10, 0.21, 3.16, 10]} />
          <meshStandardMaterial color="#756452" roughness={0.96} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={`fork-${side}`} castShadow position={[side * 0.26, 2.65, 0]} rotation={[0.12, 0, -side * 0.4]}>
            <cylinderGeometry args={[0.04, 0.095, 1.9, 8]} />
            <meshStandardMaterial color="#756452" roughness={0.96} />
          </mesh>
        ))}
        {crowns.map(([x, y, z, radius, color], index) => (
          <mesh key={index} castShadow receiveShadow position={[x, y, z]} scale={[1, 0.85, 1]}>
            <icosahedronGeometry args={[radius, 2]} />
            <meshStandardMaterial color={color} roughness={0.98} />
          </mesh>
        ))}
      </ExteriorPart>
    </group>
  );
}

/** Slender multi-stem ornamental tree with a lighter, airier canopy. */
function OrnamentalTree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <ExteriorPart model="exterior-ornamental-tree">
        {[-0.16, 0.14].map((x, i) => (
          <mesh key={`stem-${x}`} castShadow position={[x, 0.85, i * 0.1]} rotation={[0, 0, x * 0.5]}>
            <cylinderGeometry args={[0.055, 0.085, 1.7, 6]} />
            <meshStandardMaterial color="#7d6a58" roughness={0.94} />
          </mesh>
        ))}
        <mesh castShadow position={[0, 1.95, 0]}>
          <icosahedronGeometry args={[0.78, 1]} />
          <meshStandardMaterial color="#8fa87c" roughness={0.96} flatShading />
        </mesh>
        <mesh castShadow position={[-0.42, 1.62, 0.2]}>
          <icosahedronGeometry args={[0.5, 1]} />
          <meshStandardMaterial color="#9db687" roughness={0.96} flatShading />
        </mesh>
        <mesh castShadow position={[0.44, 1.7, -0.16]}>
          <icosahedronGeometry args={[0.46, 1]} />
          <meshStandardMaterial color="#87a176" roughness={0.96} flatShading />
        </mesh>
      </ExteriorPart>
    </group>
  );
}

/** Pedestrian pole luminaire: shielded warm head with a baked ground pool (no per-pixel light). */
function WalkLamp({ x, z, y = 0, pool = [0, 0] }: {
  x: number; z: number; y?: number;
  /** Horizontal offset of the pool centre, letting edge poles light the middle of a path. */
  pool?: [number, number];
}) {
  const { state } = useSolarEnvironment();
  const extFactor = state.factors.exteriorLightFactor;
  const emissiveIntensity = extFactor * 1.2;

  return (
    <group position={[x, y, z]}>
      <ExteriorPart model="exterior-walk-lamp">
        <mesh castShadow position={[0, 1.23, 0]}>
          <cylinderGeometry args={[0.045, 0.055, 2.46, 10]} />
          <meshStandardMaterial color="#44565b" metalness={0.4} roughness={0.45} />
        </mesh>
        <mesh position={[0, 2.5, 0]} userData={{ officeDynamic: true }}>
          <cylinderGeometry args={[0.2, 0.14, 0.14, 12]} />
          <meshStandardMaterial color="#ece3ca" emissive="#ffc470" emissiveIntensity={emissiveIntensity} roughness={0.48} toneMapped={false} />
        </mesh>
      </ExteriorPart>
      {extFactor > 0 && (
        <FixtureSpotLight name="walk-lamp-downlight" position={[0, 2.38, 0]} aim={[pool[0]!, 0, pool[1]!]}
          intensity={40 * extFactor} distance={9} angle={1.2} penumbra={0.45} color="#ffdeaa" />
      )}
    </group>
  );
}

/** Short modern pathway bollard with a warm glowing cap and a baked low ground wash. */
function BollardLight({ x, z, y = 0 }: { x: number; z: number; y?: number }) {
  const { state } = useSolarEnvironment();
  const extFactor = state.factors.exteriorLightFactor;
  const emissiveIntensity = extFactor === 0 ? 0 : 0.8 + extFactor * 5.0;

  return (
    <group position={[x, y, z]}>
      <ExteriorPart model="exterior-bollard-light">
        <mesh castShadow position={[0, 0.36, 0]}>
          <cylinderGeometry args={[0.055, 0.07, 0.72, 10]} />
          <meshStandardMaterial color="#334155" metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.74, 0]} userData={{ officeDynamic: true }}>
          <cylinderGeometry args={[0.075, 0.06, 0.09, 10]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive="#ffd699"
            emissiveIntensity={emissiveIntensity}
            roughness={0.2}
            toneMapped={false}
          />
        </mesh>
      </ExteriorPart>
      {extFactor > 0 && (
        <FixtureSpotLight name="bollard-wash" position={[0, 0.7, 0]} aim={[0, 0, 0]}
          intensity={9 * extFactor} distance={4} angle={1.5} penumbra={0.55} color="#ffe2b0" />
      )}
    </group>
  );
}

/** Ground-recessed linear LED walk light strip flush with the paving. */
function LinearLedWalk({ x, z, length, rotationY = 0, surfaceY = -0.195 }: { x: number; z: number; length: number; rotationY?: number; surfaceY?: number }) {
  const { state } = useSolarEnvironment();
  const extFactor = state.factors.exteriorLightFactor;
  const emissiveIntensity = 0.2 + extFactor * 3.5;

  return (
    <group position={[x, surfaceY - 0.03, z]} rotation={[0, rotationY, 0]}>
      <mesh receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[0.22, 0.03, length]} />
        <meshStandardMaterial color="#1e293b" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.018, 0]} userData={{ officeDynamic: true }}>
        <boxGeometry args={[0.12, 0.012, length - 0.14]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffe9b8"
          emissiveIntensity={emissiveIntensity}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** Recessed ground uplight beside a trunk; its baked beam washes the canopy above. */
function TreeUplight({ x, z, tree, canopyY = 3.2 }: { x: number; z: number; tree: [number, number]; canopyY?: number }) {
  const { state } = useSolarEnvironment();
  const extFactor = state.factors.exteriorLightFactor;
  return (
    <group position={[x, -0.22, z]}>
      <ExteriorPart model="exterior-tree-uplight">
        <mesh position={[0, 0.02, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 0.04, 12]} />
          <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.041, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ officeDynamic: true }}>
          <circleGeometry args={[0.11, 12]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffd8a8" emissiveIntensity={extFactor * 3.5} toneMapped={false} />
        </mesh>
      </ExteriorPart>
      {extFactor > 0 && (
        <FixtureSpotLight name="tree-uplight" position={[0, 0.12, 0]} aim={[tree[0] - x, canopyY, tree[1] - z]}
          intensity={34 * extFactor} distance={7} angle={0.62} penumbra={0.6} color="#ffd09a" />
      )}
    </group>
  );
}

function GardenBed({ position, size }: { position: [number, number, number]; size: [number, number] }) {
  return (
    <group position={position}>
      <mesh receiveShadow position={[0, -0.13, 0]}>
        <boxGeometry args={[size[0]!, 0.22, size[1]!]} />
        <meshStandardMaterial color="#8a8679" roughness={0.9} />
      </mesh>
      <mesh receiveShadow position={[0, -0.015, 0]}>
        <boxGeometry args={[size[0] - 0.16, 0.035, size[1] - 0.16]} />
        <meshStandardMaterial color="#463f35" roughness={0.98} />
      </mesh>
    </group>
  );
}

function Shrub({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <ExteriorPart model="exterior-shrub">
        <mesh castShadow>
          <icosahedronGeometry args={[0.48, 1]} />
          <meshStandardMaterial color="#7f9873" roughness={0.98} flatShading />
        </mesh>
      </ExteriorPart>
    </group>
  );
}

/** Lavender / purple flowering perennial clump. */
function LavenderShrub({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const spikes = useMemo(() => {
    const values: [number, number, number, number][] = [];
    let seed = Math.round(Math.abs(position[0] * 53 + position[2] * 29 + 11)) + 5;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 9; i += 1) {
      values.push([(rand() - 0.5) * 0.7, 0.18 + rand() * 0.12, (rand() - 0.5) * 0.7, rand()]);
    }
    return values;
  }, [position]);
  return (
    <group position={position} scale={scale}>
      <ExteriorPart model="exterior-lavender">
        <mesh castShadow position={[0, 0.1, 0]}>
          <icosahedronGeometry args={[0.3, 1]} />
          <meshStandardMaterial color="#6f8a63" roughness={0.98} flatShading />
        </mesh>
        {spikes.map(([x, y, z, roll], i) => (
          <mesh key={`spike-${i}`} castShadow position={[x, y, z]}>
            <coneGeometry args={[0.05 + (roll < 0.5 ? 0.015 : 0), 0.3, 5]} />
            <meshStandardMaterial color={roll < 0.5 ? "#9b72c9" : "#b794d6"} roughness={0.85} flatShading />
          </mesh>
        ))}
      </ExteriorPart>
    </group>
  );
}

/** Clean wayfinding pylon / totem with illuminated directory face. */
function WayfindingPylon({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  // Size the canvas before its texture exists: resizing after the first GPU upload leaves the texture blank.
  const canvas = useMemo(() => Object.assign(document.createElement("canvas"), { width: 256, height: 768 }), []);
  const texture = useMemo(() => {
    const value = new CanvasTexture(canvas);
    value.colorSpace = SRGBColorSpace;
    return value;
  }, [canvas]);
  useEffect(() => {
    canvas.width = 256;
    canvas.height = 768;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "700 40px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CAMPUS", canvas.width / 2, 70);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(48, 92, 160, 4);
    const rows = ["LOBBY  ↑", "MEETING  →", "PARKING  →", "GARDEN  ←"];
    ctx.font = "500 30px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#cbd5e1";
    rows.forEach((row, i) => ctx.fillText(row, canvas.width / 2, 180 + i * 110));
    ctx.fillStyle = "#f2c879";
    ctx.fillRect(60, canvas.height - 60, 136, 6);
    texture.needsUpdate = true;
  }, [canvas, texture]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ExteriorPart model="exterior-wayfinding-pylon">
        <mesh castShadow receiveShadow position={[0, -0.14, 0]}>
          <boxGeometry args={[0.9, 0.18, 0.7]} />
          <meshStandardMaterial color="#475569" roughness={0.8} />
        </mesh>
        <mesh castShadow position={[0, 1.1, 0]}>
          <boxGeometry args={[0.5, 2.3, 0.16]} />
          <meshStandardMaterial color="#1e293b" metalness={0.5} roughness={0.35} />
        </mesh>
        <mesh position={[0, 2.28, 0]}>
          <boxGeometry args={[0.54, 0.05, 0.2]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.85} roughness={0.2} />
        </mesh>
      </ExteriorPart>
      <mesh position={[0, 1.1, 0.085]}>
        <planeGeometry args={[0.42, 2.05]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Park bench: wooden slats on brushed metal legs. */
function Bench({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const slats = [-0.17, -0.03, 0.11, 0.25];
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      <ExteriorPart model="exterior-park-bench">
        {[-0.72, 0.72].map((x) => (
          <group key={`leg-${x}`}>
            <mesh castShadow position={[x, 0.21, 0]}>
              <boxGeometry args={[0.07, 0.42, 0.46]} />
              <meshStandardMaterial color="#9aa3a5" metalness={0.68} roughness={0.34} />
            </mesh>
            <mesh castShadow position={[x, 0.62, -0.2]} >
              <boxGeometry args={[0.07, 0.5, 0.07]} />
              <meshStandardMaterial color="#9aa3a5" metalness={0.68} roughness={0.34} />
            </mesh>
          </group>
        ))}
        {slats.map((z) => (
          <mesh key={`seat-${z}`} castShadow position={[0, outdoor.parkSeatHeight - 0.03, z + 0.06]}>
            <boxGeometry args={[1.86, 0.06, 0.11]} />
            <meshStandardMaterial color="#a97f52" roughness={0.82} />
          </mesh>
        ))}
        {[-0.17, -0.03, 0.11].map((y, i) => (
          <mesh key={`back-${y}`} castShadow position={[0, 0.66 + y * 0.42, -0.235 + i * 0.012]}>
            <boxGeometry args={[1.86, 0.11, 0.06]} />
            <meshStandardMaterial color="#b18a5c" roughness={0.82} />
          </mesh>
        ))}
      </ExteriorPart>
    </group>
  );
}

/** Contemporary public bench: concrete plinth base + timber seat slats. */
function PlinthBench({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      <ExteriorPart model="exterior-plinth-bench">
        <mesh castShadow receiveShadow position={[0, 0.12, 0]}>
          <boxGeometry args={[2.3, 0.48, 0.62]} />
          <meshStandardMaterial color="#94a3b8" roughness={0.9} />
        </mesh>
        {[-0.09, 0.09].map((z, i) => (
          <mesh key={`slat-${i}`} castShadow position={[0, outdoor.plinthSeatHeight - 0.035, z * 2.1]}>
            <boxGeometry args={[2.34, 0.07, 0.24]} />
            <meshStandardMaterial color="#b18a5c" roughness={0.8} />
          </mesh>
        ))}
      </ExteriorPart>
    </group>
  );
}

/** Low stone garden islands with timber seating built into the edge, framing the clear arrival axis. */
function ArrivalGarden({ position }: { position: readonly [number, number, number] }) {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  return (
    <group position={[...position]} userData={{ officeSeatStation: true }}>
      {night > 0 && <FixtureSpotLight name="arrival-garden-uplight" position={[-0.95, 0.66, 0.55]}
        aim={[-1.7, 4.2, 0]} intensity={30 * night} distance={6.5} angle={0.62} penumbra={0.6} color="#ffd09a" />}
      <group userData={{ officePassable: true }}>
      <ExteriorPart model="exterior-garden-planter">
        <mesh position={[-0.95, 0.59, 0.55]} rotation={[-Math.PI / 2, 0, 0]} userData={{ officeDynamic: true }}>
          <circleGeometry args={[0.09, 12]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffd8a8" emissiveIntensity={night * 3.5} toneMapped={false} />
        </mesh>
        <mesh castShadow receiveShadow position={[0, 0.28, 0]}>
          <boxGeometry args={[6.4, 0.56, 2.6]} />
          <meshStandardMaterial color="#bdc3bf" roughness={0.8} />
        </mesh>
        <mesh receiveShadow position={[0, 0.57, 0]}>
          <boxGeometry args={[6.08, 0.025, 2.28]} />
          <meshStandardMaterial color="#48553d" roughness={1} />
        </mesh>
      </ExteriorPart>
      </group>
      <OutdoorSolids kind="planter" />
      <Tree position={[-1.7, 0.58, 0]} scale={0.94} />
      {/* Broadleaf understory fills the bed beneath the tree canopy. */}
      <Shrub position={[-0.9, 0.64, -0.1]} scale={0.62} />
      <Shrub position={[-0.15, 0.63, 0.66]} scale={0.54} />
      {[0.2, 1.25, 2.3].map((offset, index) => (
        <LavenderShrub key={offset} position={[offset, 0.6, index % 2 ? 0.4 : -0.25]} scale={0.8} />
      ))}
      {/* Slats sit on the low planter wall, making the garden edge a continuous seat. */}
      {outdoor.gardenSeatSlots.map(x => <group key={`garden-seat-${x}`} position={[x, 0, outdoor.gardenSeatZ]} userData={{ officeSeat: true }}>
        <ExteriorPart model="exterior-garden-seat">
          {[-0.11, 0, 0.11].map(z => <mesh key={`seat-slat-${z}`} castShadow position={[0, outdoor.gardenSeatHeight - 0.035, z]}>
            <boxGeometry args={[1.88, 0.07, 0.09]} />
            <meshStandardMaterial color={z === 0 ? "#b18a5c" : "#a77d52"} roughness={0.82} />
          </mesh>)}
        </ExteriorPart>
      </group>)}
    </group>
  );
}

/** Contemporary picnic-style bench table: wood top + dark charcoal A-frame. */
function PicnicBenchTable({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
      <group userData={{ officePassable: true }}>
      <ExteriorPart model="exterior-picnic-table">
        {/* Table top slats */}
        {[-0.22, -0.07, 0.08, 0.23].map((z, i) => (
          <mesh key={`top-${i}`} castShadow position={[0, 0.72, z]}>
            <boxGeometry args={[1.9, 0.05, 0.13]} />
            <meshStandardMaterial color="#c09a6b" roughness={0.78} />
          </mesh>
        ))}
        {/* Charcoal A-frame legs */}
        {[-0.72, 0.72].map((x) => (
          <group key={`frame-${x}`}>
            <mesh castShadow position={[x, 0.37, 0]} rotation={[0, 0, 0]}>
              <boxGeometry args={[0.07, 0.74, 0.09]} />
              <meshStandardMaterial color="#2b3238" metalness={0.4} roughness={0.5} />
            </mesh>
            {outdoor.picnicSeatSides.map((z) => (
              <mesh key={`leg-${z}`} castShadow position={[x, 0.21, z * 0.86]} rotation={[z * 0.24, 0, 0]}>
                <boxGeometry args={[0.06, 0.44, 0.07]} />
                <meshStandardMaterial color="#2b3238" metalness={0.4} roughness={0.5} />
              </mesh>
            ))}
            {outdoor.picnicSeatSides.map((z) => (
              <mesh key={`seat-rail-${z}`} castShadow position={[x, 0.36, z * 0.94]}>
                <boxGeometry args={[0.06, 0.06, 0.34]} />
                <meshStandardMaterial color="#2b3238" metalness={0.4} roughness={0.5} />
              </mesh>
            ))}
          </group>
        ))}
      </ExteriorPart>
      </group>
      <OutdoorSolids kind="picnic-table" />
      {/* Bench seats both sides */}
      {outdoor.picnicSeatSides.map(z => <group key={`bench-${z}`} position={[0, 0, z]} userData={{ officeSeat: true }}>
        <ExteriorPart model="exterior-picnic-bench">
          {[-0.07, 0.07].map((dz, i) => <mesh key={`seat-${i}`} castShadow position={[0, outdoor.picnicSeatHeight - 0.025, dz]}>
            <boxGeometry args={[1.9, 0.05, 0.12]} />
            <meshStandardMaterial color="#b18a5c" roughness={0.8} />
          </mesh>)}
        </ExteriorPart>
      </group>)}
    </group>
  );
}

/** Square cafe parasol: hipped canvas canopy on a slim mast with a warm table light beneath. */
function SquareParasol({ position, canopy = "#e7e2d4" }: { position: [number, number, number]; canopy?: string }) {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  return (
    <group position={position}>
      <group userData={{ officePassable: true }}>
      <ExteriorPart model="exterior-parasol" canopyColor={canopy}>
        <mesh castShadow position={[0, 1.25, 0]}>
          <cylinderGeometry args={[0.035, 0.045, 2.5, 10]} />
          <meshStandardMaterial color="#334155" metalness={0.6} roughness={0.35} />
        </mesh>
        {/* Each panel yaws to its side first, then tilts down and outward from the hub. */}
        {[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => (
          <mesh key={`panel-${a}`} castShadow position={[Math.sin(a) * 0.56, 2.52, Math.cos(a) * 0.56]} rotation={[0.34, a, 0, "YXZ"]}>
            <boxGeometry args={[1.6, 0.03, 0.72]} />
            <meshStandardMaterial color={canopy} roughness={0.88} side={DoubleSide} />
          </mesh>
        ))}
        <mesh position={[0, 2.68, 0]}>
          <boxGeometry args={[0.1, 0.1, 0.1]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 2.4, 0]} userData={{ officeDynamic: true }}>
          <cylinderGeometry args={[0.13, 0.13, 0.04, 16]} />
          <meshStandardMaterial color="#f6ecd8" emissive="#ffcf8a" emissiveIntensity={night * 2.4} toneMapped={false} />
        </mesh>
      </ExteriorPart>
      </group>
      <OutdoorSolids kind="parasol" />
      {night > 0 && <FixtureSpotLight name="parasol-table-light" position={[0, 2.36, 0]} aim={[0, 0, 0]}
        intensity={8 * night} distance={3.8} angle={1.1} penumbra={0.5} color="#ffd59a" />}
    </group>
  );
}

/** Pickup stays at the physical counter; only settled guests can start preparation. */
function KioskPickupDisplay() {
  const cup = useRef<Mesh>(null), indicator = useRef<MeshStandardMaterial>(null);
  useFrame(() => {
    const state = outdoorKioskState.snapshot();
    if (cup.current) cup.current.visible = state?.status === "pickup";
    if (indicator.current) {
      indicator.current.color.set(state?.status === "pickup" ? "#90e6b5" : state?.status === "preparing" ? "#e6ba72" : "#43685e");
      indicator.current.emissive.copy(indicator.current.color);
    }
  });
  return <group name="outdoor-kiosk-pickup" userData={{ officeDynamic: true, officeCollision: false }}>
    <mesh ref={cup} visible={false} position={[0, 1.61, 1.13]}>
      <cylinderGeometry args={[.055,.045,.13,10]} /><meshStandardMaterial color="#eee3cb" roughness={.75} />
    </mesh>
    <mesh position={[.9, 1.57, 1.1]}><boxGeometry args={[.18,.018,.07]}/>
      <meshStandardMaterial ref={indicator} color="#43685e" emissive="#43685e" emissiveIntensity={.65}/>
    </mesh>
  </group>;
}

/** Outdoor cafe counter / kiosk pod with accent lighting and illuminated brand face. */
function CafeKiosk({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  const canvas = useMemo(() => Object.assign(document.createElement("canvas"), { width: 768, height: 192 }), []);
  const texture = useMemo(() => {
    const value = new CanvasTexture(canvas);
    value.colorSpace = SRGBColorSpace;
    return value;
  }, [canvas]);
  useEffect(() => {
    canvas.width = 768;
    canvas.height = 192;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "800 96px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText("CAMPUS CAFE", canvas.width / 2, canvas.height / 2 - 6);
    ctx.fillStyle = "#f2c879";
    ctx.fillRect(96, canvas.height - 30, canvas.width - 192, 6);
    texture.needsUpdate = true;
  }, [canvas, texture]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ExteriorPart model="exterior-cafe-kiosk">
        {/* Pod body */}
        <mesh castShadow receiveShadow position={[0, 0.6, 0]}>
          <boxGeometry args={[4.6, 1.7, 2.1]} />
          <meshStandardMaterial color="#334155" metalness={0.35} roughness={0.5} />
        </mesh>
        {/* Timber slat service front */}
        {[-0.3, 0, 0.3].map((y, i) => (
          <mesh key={`slat-${i}`} position={[0, 0.55 + y * 0.5, 1.06]}>
            <boxGeometry args={[4.4, 0.12, 0.03]} />
            <meshStandardMaterial color="#a97f52" roughness={0.8} />
          </mesh>
        ))}
        {/* Counter top */}
        <mesh castShadow position={[0, 1.5, 0.45]}>
          <boxGeometry args={[4.8, 0.09, 1.5]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.3} roughness={0.35} />
        </mesh>
        {/* Canopy roof */}
        <mesh castShadow position={[0, 2.62, 0]}>
          <boxGeometry args={[5.0, 0.14, 2.5]} />
          <meshStandardMaterial color="#1e293b" metalness={0.5} roughness={0.4} />
        </mesh>
        {[-2.2, 2.2].map((x) => (
          <mesh key={`post-${x}`} castShadow position={[x, 1.6, 1.1]}>
            <cylinderGeometry args={[0.05, 0.05, 2.0, 8]} />
            <meshStandardMaterial color="#94a3b8" metalness={0.8} roughness={0.25} />
          </mesh>
        ))}
        {/* Warm accent under-counter lighting */}
        <mesh position={[0, 0.06, 1.02]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[4.2, 0.04, 0.05]} />
          <meshStandardMaterial color="#fde8c0" emissive="#f2c879" emissiveIntensity={0.4 + night * 1.8} roughness={0.4} />
        </mesh>
        {/* Linear LED along the canopy's service edge lights the counter and the queue. */}
        <mesh position={[0, 2.54, 1.12]} userData={{ officeDynamic: true }}>
          <boxGeometry args={[4.4, 0.025, 0.06]} />
          <meshStandardMaterial color="#f6ecd8" emissive="#ffd08a" emissiveIntensity={night * 2.2} toneMapped={false} />
        </mesh>
        {/* Espresso machine + cups on the counter */}
        <mesh castShadow position={[-1.4, 1.72, 0.2]}>
          <boxGeometry args={[0.7, 0.44, 0.42]} />
          <meshStandardMaterial color="#cbd5e1" metalness={0.75} roughness={0.25} />
        </mesh>
        {[0.3, 0.7, 1.1].map((x) => (
          <mesh key={`cup-${x}`} castShadow position={[x, 1.6, 0.3]}>
            <cylinderGeometry args={[0.06, 0.05, 0.1, 8]} />
            <meshStandardMaterial color="#f8fafc" roughness={0.5} />
          </mesh>
        ))}
      </ExteriorPart>
      <KioskPickupDisplay />
      {/* Illuminated brand fascia */}
      <mesh position={[0, 2.16, 1.26]}>
        <planeGeometry args={[4.3, 0.85]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {night > 0 && [-1.3, 1.3].map(x => <FixtureSpotLight key={`kiosk-service-${x}`} name="cafe-kiosk-service"
        position={[x, 2.5, 1.0]} aim={[x * 0.6, 0, 2.3]} intensity={14 * night} distance={5}
        angle={0.95} penumbra={0.5} color="#ffd9a0" />)}
    </group>
  );
}

/** Festoon strings from the kiosk canopy to two masts beyond the deck corners; bulbs share one draw. */
function CafeFestoonLights() {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  const bulbsRef = useRef<InstancedMesh>(null);
  const layout = useMemo(() => {
    const deck = outdoor.cafeDeck, kiosk = outdoor.cafeKiosk.position;
    // Masts stand on the lawn just outside the deck and its walkable footprint.
    const mastX = deck.position[0] + deck.size[0] / 2 + 0.3;
    const masts = [deck.position[2] - deck.size[1] / 2 - 0.35, deck.position[2] + deck.size[1] / 2 + 0.35]
      .map(z => new Vector3(mastX, 3.05, z));
    // The kiosk faces the deck, so its 2.5 m canopy edge sits 1.2 m east of the pod centre.
    const eaves = [-2.3, 2.3].map(dz => new Vector3(kiosk[0] + 1.2, 2.6, kiosk[2] + dz));
    const curves = ([[eaves[0]!, masts[0]!], [eaves[1]!, masts[1]!], [masts[0]!, masts[1]!]] as const).map(([a, b]) => {
      const sag = a.clone().lerp(b, 0.5);
      sag.y -= 0.42;
      return new QuadraticBezierCurve3(a, sag, b);
    });
    const bulbs = curves.flatMap(curve => {
      const count = Math.max(4, Math.round(curve.getLength() / 0.55));
      return Array.from({ length: count - 1 }, (_, i) => curve.getPoint((i + 1) / count));
    });
    const pools = curves.flatMap(curve => [0.3, 0.7].map(t => curve.getPoint(t)));
    return { masts, curves, bulbs, pools };
  }, []);
  useLayoutEffect(() => {
    const mesh = bulbsRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    layout.bulbs.forEach((point, i) => { dummy.position.copy(point); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [layout]);
  return (
    <group name="cafe-festoon-lights">
      {layout.masts.map(mast => <group key={mast.z} position={[mast.x, 0, mast.z]}>
        <ExteriorPart model="exterior-festoon-mast">
          <mesh castShadow position={[0, 1.55, 0]}>
            <cylinderGeometry args={[0.04, 0.055, 3.1, 8]} />
            <meshStandardMaterial color="#2b3238" metalness={0.5} roughness={0.45} />
          </mesh>
          <mesh receiveShadow position={[0, 0.02, 0]}>
            <boxGeometry args={[0.32, 0.04, 0.32]} />
            <meshStandardMaterial color="#8d918e" roughness={0.7} />
          </mesh>
        </ExteriorPart>
      </group>)}
      <group userData={{ officeCollision: false }}>
        {layout.curves.map((curve, i) => <mesh key={`festoon-wire-${i}`}>
          <tubeGeometry args={[curve, 28, 0.009, 4, false]} />
          <meshStandardMaterial color="#1f2427" roughness={0.6} />
        </mesh>)}
        <instancedMesh ref={bulbsRef} args={[undefined, undefined, layout.bulbs.length]} userData={{ officeDynamic: true }}>
          <sphereGeometry args={[0.045, 8, 6]} />
          <meshStandardMaterial color="#fff3d6" emissive="#ffc56b" emissiveIntensity={0.15 + night * 2.6} roughness={0.3} toneMapped={false} />
        </instancedMesh>
      </group>
      {night > 0 && layout.pools.map((point, i) => <FixtureSpotLight key={`festoon-pool-${i}`} name="cafe-festoon-pool"
        position={[point.x, point.y - 0.05, point.z]} aim={[point.x, 0, point.z]} intensity={7 * night}
        distance={4.6} angle={1.25} penumbra={0.6} color="#ffcf87" />)}
    </group>
  );
}

/** Timber slat deck terrace zone. */
function TimberDeck({ position, size }: { position: [number, number, number]; size: [number, number] }) {
  const slats = Math.round(size[0] / 0.42);
  return (
    <group position={position}>
      <ExteriorPart model="exterior-cafe-deck">
        <mesh receiveShadow position={[0, -0.06, 0]}>
          <boxGeometry args={[size[0] + 0.3, 0.1, size[1] + 0.3]} />
          <meshStandardMaterial color="#475569" roughness={0.9} />
        </mesh>
        {Array.from({ length: slats }, (_, i) => (
          <mesh key={`deck-${i}`} receiveShadow castShadow position={[-size[0]! / 2 + 0.21 + i * 0.42, 0.015, 0]}>
            <boxGeometry args={[0.34, 0.05, size[1]!]} />
            <meshStandardMaterial color={i % 3 === 0 ? "#a9825a" : "#b78f63"} roughness={0.85} />
          </mesh>
        ))}
      </ExteriorPart>
    </group>
  );
}

/** Cafe patio set: round table, two chairs and a cantilever umbrella. */
function PatioSet({ position, canopy = "#d9d3c4" }: { position: [number, number, number]; canopy?: string }) {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  return (
    <group position={position}>
      <group userData={{ officePassable: true }}>
      <ExteriorPart model="exterior-patio-table" canopyColor={canopy}>
        <mesh receiveShadow position={[0, -0.22, 0]}>
          <cylinderGeometry args={[0.92, 0.98, 0.06, 20]} />
          <meshStandardMaterial color="#c6c2b6" roughness={0.92} />
        </mesh>
        <mesh castShadow position={[0, 0.28, 0]}>
          <cylinderGeometry args={[0.055, 0.075, 1.0, 10]} />
          <meshStandardMaterial color="#8d9496" metalness={0.6} roughness={0.36} />
        </mesh>
        <mesh castShadow position={[0, 0.8, 0]}>
          <cylinderGeometry args={[0.62, 0.62, 0.055, 22]} />
          <meshStandardMaterial color="#e4e1d8" roughness={0.6} />
        </mesh>
        <mesh castShadow position={[0.02, 1.55, 0]}>
          <cylinderGeometry args={[0.035, 0.035, 2.6, 8]} />
          <meshStandardMaterial color="#6f7678" metalness={0.55} roughness={0.4} />
        </mesh>
        <mesh castShadow position={[0.02, 2.62, 0]}>
          <coneGeometry args={[1.55, 0.62, 10]} />
          <meshStandardMaterial color={canopy} roughness={0.86} side={DoubleSide} flatShading />
        </mesh>
        <mesh position={[0.02, 2.95, 0]}>
          <sphereGeometry args={[0.05, 8, 8]} />
          <meshStandardMaterial color="#8d9496" metalness={0.6} roughness={0.35} />
        </mesh>
        <mesh position={[0.02, 2.29, 0]} userData={{ officeDynamic: true }}>
          <cylinderGeometry args={[0.12, 0.12, 0.04, 16]} />
          <meshStandardMaterial color="#f6ecd8" emissive="#ffcf8a" emissiveIntensity={night * 2.4} toneMapped={false} />
        </mesh>
      </ExteriorPart>
      </group>
      <OutdoorSolids kind="patio-table" />
      {outdoor.patioChairAngles.map((a) => (
        <group key={`chair-${a}`} userData={{ officeSeat: true }} position={[Math.sin(a) * outdoor.patioChairRadius, 0, Math.cos(a) * outdoor.patioChairRadius]} rotation={[0, a + Math.PI, 0]}>
          <ExteriorPart model="exterior-patio-chair">
            <mesh castShadow position={[0, outdoor.patioSeatHeight - 0.03, 0]}>
              <boxGeometry args={[0.52, 0.06, 0.5]} />
              <meshStandardMaterial color="#7d8688" metalness={0.5} roughness={0.4} />
            </mesh>
            <mesh castShadow position={[0, 0.7, -0.23]}>
              <boxGeometry args={[0.52, 0.5, 0.06]} />
              <meshStandardMaterial color="#7d8688" metalness={0.5} roughness={0.4} />
            </mesh>
            {[-0.21, 0.21].map((lx) => (
              <mesh key={`chair-leg-${lx}`} castShadow position={[lx, 0.21, 0]}>
                <boxGeometry args={[0.05, 0.44, 0.46]} />
                <meshStandardMaterial color="#666e70" metalness={0.55} roughness={0.4} />
              </mesh>
            ))}
          </ExteriorPart>
        </group>
      ))}
      {night > 0 && <FixtureSpotLight name="patio-umbrella-light" position={[0.02, 2.25, 0]} aim={[0.02, 0, 0]}
        intensity={8 * night} distance={3.8} angle={1.15} penumbra={0.5} color="#ffd59a" />}
    </group>
  );
}

function Bicycle({ x, tone }: { x: number; tone: string }) {
  return (
    <group position={[x, 0, 0.06]}>
      <ExteriorPart model="exterior-bicycle" canopyColor={tone}>
        {[-0.34, 0.34].map((z) => (
          <mesh key={`wheel-${z}`} castShadow position={[0, 0.34, z]} rotation={[0, 0, Math.PI / 2]}>
            <torusGeometry args={[0.3, 0.028, 8, 18]} />
            <meshStandardMaterial color="#2f3638" roughness={0.7} />
          </mesh>
        ))}
        <mesh castShadow position={[0, 0.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.026, 0.026, 0.72, 8]} />
          <meshStandardMaterial color={tone} metalness={0.35} roughness={0.5} />
        </mesh>
        <mesh castShadow position={[0, 0.62, 0.3]}>
          <boxGeometry args={[0.3, 0.05, 0.1]} />
          <meshStandardMaterial color="#2f3638" roughness={0.7} />
        </mesh>
        <mesh castShadow position={[0, 0.68, -0.3]}>
          <boxGeometry args={[0.26, 0.05, 0.09]} />
          <meshStandardMaterial color="#2f3638" roughness={0.7} />
        </mesh>
      </ExteriorPart>
    </group>
  );
}

/** Bicycle parking row: steel stand loops on a concrete pad, two bikes in use. */
function BikeRack({ position, rotationY = 0, spaces = 4 }: {
  position: [number, number, number];
  rotationY?: number;
  spaces?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ExteriorPart model="exterior-bike-rack">
        <mesh receiveShadow position={[0, -0.22, 0]}>
          <boxGeometry args={[spaces * 0.72 + 0.5, 0.06, 1.5]} />
          <meshStandardMaterial color="#c3bfb4" roughness={0.94} />
        </mesh>
        {[-0.42, 0.42].map((z) => (
          <mesh key={`rail-${z}`} castShadow position={[0, 0.18, z]}>
            <boxGeometry args={[spaces * 0.72 + 0.3, 0.07, 0.07]} />
            <meshStandardMaterial color="#9aa3a5" metalness={0.7} roughness={0.32} />
          </mesh>
        ))}
        {Array.from({ length: spaces }, (_, i) => i - (spaces - 1) / 2).map((offset) => (
          <group key={`loop-${offset}`} position={[offset * 0.72, 0, 0]}>
            <mesh castShadow position={[0, 0.34, 0]}>
              <torusGeometry args={[0.26, 0.032, 8, 18, Math.PI]} />
              <meshStandardMaterial color="#b3babc" metalness={0.75} roughness={0.28} />
            </mesh>
            {[-0.26, 0.26].map((x) => (
              <mesh key={`post-${x}`} castShadow position={[x, 0.17, 0]}>
                <cylinderGeometry args={[0.032, 0.032, 0.34, 8]} />
                <meshStandardMaterial color="#b3babc" metalness={0.75} roughness={0.28} />
              </mesh>
            ))}
          </group>
        ))}
      </ExteriorPart>
      {[0, 2].map((slot) => (
        <Bicycle
          key={`bike-${slot}`}
          x={(slot - (spaces - 1) / 2) * 0.72 + 0.06}
          tone={slot === 0 ? "#3f6f7a" : "#8a5b46"}
        />
      ))}
    </group>
  );
}

/** Sculpted stone garden lantern, terracotta vessel & landscape boulders at garden bed corners. */
function GardenDecor({ position, rotationY = 0 }: { position: [number, number, number]; rotationY?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <ExteriorPart model="exterior-garden-decor">
        <mesh castShadow position={[0, 0.22, 0]}>
          <cylinderGeometry args={[0.14, 0.16, 0.44, 8]} />
          <meshStandardMaterial color="#94a2b3" roughness={0.84} />
        </mesh>
        <mesh castShadow position={[-0.38, 0.14, 0.12]}>
          <cylinderGeometry args={[0.2, 0.16, 0.28, 12]} />
          <meshStandardMaterial color="#ba785c" roughness={0.68} />
        </mesh>
      </ExteriorPart>
    </group>
  );
}

/**
 * High-end modular multi-tone stone/concrete paver field. Deterministic tone pattern;
 * tiles are flat, thin and receive-only so they never block the pedestrian corridor.
 */
function PaverField({
  center,
  size,
  tile = 2.2
}: {
  center: [number, number];
  size: [number, number];
  tile?: number;
}) {
  const tiles = useMemo(() => {
    const values: { x: number; z: number; tone: string }[] = [];
    const cols = Math.max(1, Math.round(size[0] / tile));
    const rows = Math.max(1, Math.round(size[1] / tile));
    const w = size[0] / cols;
    const d = size[1] / rows;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        /* Running bond with small natural colour shifts, not a checkerboard. */
        const accent = (c + (r % 2) * 2) % 11 === 0;
        const tone = accent
          ? PAVER_TONES[(r + 1) % 3]!
          : PAVER_TONES[2 + ((c + r) % 3)]!;
        values.push({
          x: center[0] - size[0] / 2 + (c + 0.5) * w,
          z: center[1] - size[1] / 2 + (r + 0.5) * d,
          tone
        });
      }
    }
    return values;
  }, [center, size, tile]);
  return (
    <group>
      {tiles.map((t, i) => (
        <mesh key={`paver-${i}`} receiveShadow position={[t.x, -0.0175, t.z]}>
          <boxGeometry args={[size[0] / Math.max(1, Math.round(size[0] / tile)) - 0.035, 0.035, size[1] / Math.max(1, Math.round(size[1] / tile)) - 0.035]} />
          <meshStandardMaterial color={t.tone} roughness={0.88} />
        </mesh>
      ))}
    </group>
  );
}

/** Connect the flush plaza to the lower city road without a step at the kerb. */
function FrontEntranceWalkway() {
  const a = FRONT_APPROACH;
  const flatLength = a.plazaFrontZ - a.rampStartZ;
  const rampRun = a.rampStartZ - a.roadEdgeZ;
  const drop = -a.roadTop;
  const rampLength = Math.hypot(rampRun, drop);
  return (
    <group name="front-entrance-walkway" userData={{ officePassable: true }}>
      <PaverField center={[a.x, (a.plazaFrontZ + a.rampStartZ) / 2]}
        size={[a.width, flatLength]} tile={1.2} />
      <mesh position={[a.x, -0.12, (a.plazaFrontZ + a.rampStartZ) / 2]}>
        <boxGeometry args={[a.width, 0.15, flatLength]} />
        <meshStandardMaterial color="#a5aaa5" roughness={0.92} />
      </mesh>
      <group name="front-walkway-road-ramp"
        position={[a.x, a.roadTop / 2, (a.rampStartZ + a.roadEdgeZ) / 2]}
        rotation={[-Math.atan2(drop, rampRun), 0, 0]}>
        <PaverField center={[0, 0]} size={[a.width, rampLength]} tile={1.2} />
        <mesh position={[0, -0.12, 0]}>
          <boxGeometry args={[a.width, 0.15, rampLength]} />
          <meshStandardMaterial color="#a5aaa5" roughness={0.92} />
        </mesh>
        {[-1, 1].map(side => <LinearLedWalk key={side} x={side * (a.width / 2 + 0.12)}
          z={0} length={rampLength} surfaceY={0} />)}
      </group>
      {[-1, 1].map(side => <group key={side}>
        <LinearLedWalk x={a.x + side * (a.width / 2 + 0.12)}
          z={(a.plazaFrontZ + a.rampStartZ) / 2} length={flatLength} surfaceY={0} />
        {[-33.5, -40, -46].map(z => <BollardLight key={z} x={a.x + side * 3.75} z={z} />)}
        {[-30.5, -37, -43.5].map(z => <WalkLamp key={`pole-${z}`} x={a.x + side * 3.9} z={z} pool={[-side * 1.5, 0]} />)}
        {/* The ramp's verge poles stand on the lower turf, bridging the plaza and footway pools. */}
        <WalkLamp x={a.x + side * 3.9} z={(a.rampStartZ + a.roadEdgeZ) / 2 - 0.5} y={-0.705} pool={[-side * 1.5, 0]} />
        {/* Footway poles light the road-edge arrival and departure point shared by every avatar. */}
        <WalkLamp x={a.x + side * 4.2} z={a.roadEdgeZ + 1.3} y={a.roadTop + 0.03} pool={[-side * 2.2, -0.6]} />
      </group>)}
    </group>
  );
}


/** The campus plinth (104 × 94 m, top -0.26): one merged draw, open where the parking access ramps descend. */
const PLINTH = { x0: -52, x1: 52, z0: -47, z1: 47, bottom: -0.68, top: -0.26 } as const;
function CampusPlinth() {
  const geometry = useMemo(() => {
    const boxes = rectsWithout(PLINTH, PARKING_ACCESS_NOTCHES).map(rect => {
      const box = new BoxGeometry(rect.x1 - rect.x0, PLINTH.top - PLINTH.bottom, rect.z1 - rect.z0);
      box.translate((rect.x0 + rect.x1) / 2, (PLINTH.top + PLINTH.bottom) / 2, (rect.z0 + rect.z1) / 2);
      return box;
    });
    const merged = mergeGeometries(boxes, false)!;
    boxes.forEach(box => box.dispose());
    return merged;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh name="campus-plinth" receiveShadow geometry={geometry}>
    <meshStandardMaterial color="#58715a" roughness={0.99} />
  </mesh>;
}

export function CampusExterior() {
  const b = OFFICE_BUILDING;
  // Paving ends at the shaft/landing structure, never under its coplanar floors.
  // Reserve both lift bases together, including their projecting frame collars.
  const liftBaseEast = Math.max(...GLASS_ELEVATORS.map(lift => lift.x + lift.shaftWidth / 2 + 0.15));
  const liftBaseNorth = Math.min(...GLASS_ELEVATORS.map(lift => lift.z - lift.shaftDepth / 2 - 0.15));
  const liftBaseSouth = Math.max(...GLASS_ELEVATORS.map(lift => lift.z + lift.shaftDepth / 2 + 0.15));
  const promenadeWest = b.east - 0.6;
  const promenadeEast = b.east + 5;
  const promenadeNorth = liftBaseNorth - 1.35;
  const promenadeSouth = liftBaseSouth + 1.35;
  const promenadeCenterZ = (promenadeNorth + promenadeSouth) / 2;
  const promenadeDepth = promenadeSouth - promenadeNorth;
  return (
    <group name="extalia-expanded-pedestrian-campus">
      <CampusPlinth />
      <CampusGrass />
      <CampusLandscape />
      <ElevatorGarden />
      {/* Local carriageways are removed; only the outer city avenues remain. */}
      <group name="campus-tiled-walkway-ring" userData={{ officePassable: true }}>
        <PaverField center={[3.5, b.north - 2]} size={[55, 2.8]} tile={1.4} />
        <PaverField center={[3.5, b.south + 2]} size={[55, 2.8]} tile={1.4} />
        <PaverField center={[b.west - 2, 0]} size={[2.8, 39.2]} tile={1.4} />
        {/* Wrap outside both lift shafts, leaving a generous east-side service promenade. */}
        <PaverField center={[b.east + 5, 0]} size={[2.8, 39.2]} tile={1.4} />
        <PaverField center={[0, b.north - 7]} size={[46, 7.2]} tile={1.8} />
        <group name="lift-promenade-paving">
          <PaverField center={[(promenadeWest + b.east) / 2, promenadeCenterZ]}
            size={[b.east - promenadeWest, promenadeDepth]} tile={1.4} />
          <PaverField center={[(liftBaseEast + promenadeEast) / 2, promenadeCenterZ]}
            size={[promenadeEast - liftBaseEast, promenadeDepth]} tile={1.4} />
          <PaverField center={[(b.east + liftBaseEast) / 2, (promenadeNorth + liftBaseNorth) / 2]}
            size={[liftBaseEast - b.east, liftBaseNorth - promenadeNorth]} tile={1.4} />
          <PaverField center={[(b.east + liftBaseEast) / 2, (liftBaseSouth + promenadeSouth) / 2]}
            size={[liftBaseEast - b.east, promenadeSouth - liftBaseSouth]} tile={1.4} />
        </group>
      </group>
      {/* The facade already supplies the entrance canopy; keep the plaza uncluttered. */}
      <group name="entrance-threshold-apron" userData={{ officePassable: true }}>
        <PaverField center={[FRONT_APPROACH.x, b.north - 0.325]} size={[10.4, 0.55]} tile={1.2} />
      </group>
      <FrontEntranceWalkway />
      {outdoor.forecourtLamps.map(lamp => <WalkLamp key={`${lamp.x}:${lamp.z}`} x={lamp.x} z={lamp.z} />)}
      {outdoor.arrivalGardens.map(garden => <ArrivalGarden key={garden.id} position={garden.position} />)}
      {outdoor.plinthBenches.filter(bench => bench.roomId === "outdoor-forecourt").map(bench =>
        <PlinthBench key={bench.id} position={[...bench.position]} rotationY={bench.rotationY} />)}
      {/* The front board (ExtaliaSignage.tsx) stands beside the walkway and is mounted by OfficeCanvas. */}
      <WayfindingPylon position={[6, -0.24, -30.5]} rotationY={-0.18} />
      <BikeRack position={[20, -0.24, -25]} spaces={4} />
      <TimberDeck position={[...outdoor.cafeDeck.position]} size={[...outdoor.cafeDeck.size]} />
      <CafeKiosk position={[...outdoor.cafeKiosk.position]} rotationY={outdoor.cafeKiosk.rotationY} />
      <CafeFestoonLights />
      <GardenDecor position={[...outdoor.gardenArt.position]} rotationY={outdoor.gardenArt.rotationY} />
      {outdoor.picnicTables.map(table => <group key={table.id}>
        <PicnicBenchTable position={[...table.position]} rotationY={table.rotationY} />
        <SquareParasol position={[...table.position]} />
      </group>)}
      <group name="outdoor-facility-paving" userData={{ officePassable: true }}>
        <PaverField center={[-27.2, -21.6]} size={[8.4, 2.6]} tile={1.2} />
        <PaverField center={[-29.25, -27.5]} size={[12.5, 2.4]} tile={1.2} />
        <PaverField center={[-23.2, -0.15]} size={[2.4, 42.9]} tile={1.2} />
        <PaverField center={[30, -0.15]} size={[2.4, 42.9]} tile={1.2} />
        <PaverField center={[3.4, 21.3]} size={[55.6, 2.6]} tile={1.2} />
        <PaverField center={[-25.6, 8.5]} size={[3.6, 3.6]} tile={1.2} />
        <PaverField center={[31.9, 8.5]} size={[4.6, 3.6]} tile={1.2} />
        <PaverField center={[0, 25.7]} size={[14.4, 8.2]} tile={1.2} />
      </group>
      {/* Planting sits beyond the paved ring, well clear of elevator access. */}
      {[-1, 1].map(side => {
        const x = side < 0 ? -28 : 35;
        return <group key={`garden-${side}`}>
          <GardenBed position={[x, -0.24, 0]} size={[4, 30]} />
          <GardenDecor position={[x, -0.24, -14.2]} rotationY={side * 0.4} />
          <GardenDecor position={[x, -0.24, 14.2]} rotationY={Math.PI - side * 0.4} />
          {[-12, -6, 0, 6, 12].map((z, i) => <group key={z}>
            <Shrub position={[x - 0.6, 0.26, z]} scale={0.8} />
            <LavenderShrub position={[x + 0.6, -0.24, z]} />
            {i % 2 === 0 && <Tree position={[x, -0.24, z]} scale={0.92} />}
            {i % 2 === 0 && <TreeUplight x={x - side * 1.7} z={z + 0.4} tree={[x, z]} canopyY={3.5} />}
          </group>)}

          <BollardLight x={side < 0 ? -25 : 32} z={-8.5} />

        </group>;
      })}
      {outdoor.parkBenchLamps.map(lamp => <BollardLight key={`bench-lamp-${lamp.x}`} x={lamp.x} z={lamp.z} />)}
      {outdoor.parkBenches.map(bench => <Bench key={bench.id} position={[...bench.position]} rotationY={bench.rotationY} />)}
      {outdoor.patios.map(patio => <PatioSet key={patio.id} position={[...patio.position]} canopy={patio.canopy} />)}
      {outdoor.plinthBenches.filter(bench => bench.roomId === "outdoor-rear-patio").map(bench =>
        <PlinthBench key={bench.id} position={[...bench.position]} rotationY={bench.rotationY} />)}
      {[-8.6, 8.6].map(x => <GardenDecor key={`rear-decor-${x}`} position={[x, -0.24, 29.8]} rotationY={x < 0 ? 0.3 : -0.3} />)}
      <GardenBed position={[2, -0.24, 32]} size={[46, 3]} />
      {[-18, -12, -6, 0, 6, 12, 18, 24].map((x, i) => <group key={x}>
        <OrnamentalTree position={[x, -0.24, 32]} />
        <Shrub position={[x - 1.4, 0.08, 31.4]} scale={0.62} />
        <LavenderShrub position={[x + 1.4, -0.22, 32.4]} scale={0.85} />
        {i % 2 === 0 && <LavenderShrub position={[x - 2.7, -0.22, 32.1]} scale={0.78} />}
      </group>)}
      {[-12, 0, 12, 24].map(x => <TreeUplight key={`rear-uplight-${x}`} x={x + 0.8} z={31} tree={[x, 32]} canopyY={1.9} />)}
      {[-12, 12].map(x => <BollardLight key={x} x={x} z={23.5} />)}
    </group>
  );
}
