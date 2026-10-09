import React from "react";
import { DoubleSide } from "three";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { useSolarEnvironment } from "../../../Environment";

export interface WallSconceProps {
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  lightColor?: string;
  isExterior?: boolean;
}

/**
 * Architectural Up/Down Wall Sconce Fixture (Lampu Dinding).
 * Mounts on interior walls, columns, and exterior piers.
 * Up/down frosted diffusers with focused wall-wash point light.
 */
export function WallSconceFixture({
  position,
  rotation = [0, 0, 0],
  scale = 1,
  lightColor = "#ffb86c", // Warm incandescent 2700K
  isExterior = false
}: WallSconceProps) {
  const { state } = useSolarEnvironment();
  const factor = isExterior ? state.factors.exteriorLightFactor : state.factors.interiorLightFactor;
  const isLightOn = factor > 0.05;
  const emissiveIntensity = isLightOn ? 0.3 + factor * 3.5 : 0;

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* Wall mounting plate */}
      <mesh castShadow position={[0, 0, 0.02]}>
        <boxGeometry args={[0.16, 0.44, 0.03]} />
        <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Main architectural fixture body */}
      <mesh castShadow position={[0, 0, 0.1]}>
        <boxGeometry args={[0.12, 0.38, 0.13]} />
        <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.35} />
      </mesh>

      {/* Top light diffuser (Up-light) */}
      <mesh position={[0, 0.17, 0.1]} userData={{ officeMaterialDynamic: `wall-sconce:${isExterior ? "exterior" : "interior"}:${lightColor}:0.3+factor*3.5` }}>
        <boxGeometry args={[0.1, 0.06, 0.11]} />
        <meshStandardMaterial
          color={isLightOn ? "#ffffff" : "#4a5568"}
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.1}
          toneMapped={false}
        />
      </mesh>

      {/* Bottom light diffuser (Down-light) */}
      <mesh position={[0, -0.17, 0.1]} userData={{ officeMaterialDynamic: `wall-sconce:${isExterior ? "exterior" : "interior"}:${lightColor}:0.3+factor*3.5` }}>
        <boxGeometry args={[0.1, 0.06, 0.11]} />
        <meshStandardMaterial
          color={isLightOn ? "#ffffff" : "#4a5568"}
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.1}
          toneMapped={false}
        />
      </mesh>

      {/* The existing lower lens provides a restrained downward wall/task wash. */}
      <FixtureSpotLight name="wall-sconce-downlight" position={[0, -0.2, 0.16]} aim={[0, -1.75, 0.65]}
        intensity={factor * 8} distance={3.2} angle={0.9} color={lightColor} />
    </group>
  );
}

export interface StandLampProps {
  position: [number, number, number];
  rotation?: [number, number, number];
  height?: number;
  lightColor?: string;
}

/**
 * Mid-Century Contemporary Stand Lamp / Lampu Lantai Pijar Dekorasi.
 * Weighted brass/black base, slender stem, warm glowing shade, and an internal
 * incandescent filament bulb casting a rich, warm pool of light onto adjacent
 * seating and floor.
 */
export function StandLampFixture({
  position,
  rotation = [0, 0, 0],
  height = 1.85,
  lightColor = "#ffaa44" // Rich warm golden incandescent
}: StandLampProps) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const isLightOn = factor > 0.05;
  const emissiveIntensity = isLightOn ? 0.5 + factor * 3.8 : 0;

  const stemHeight = height - 0.52;
  const shadeY = height - 0.26;

  return (
    <group position={position} rotation={rotation}>
      {/* Heavy circular weighted base */}
      <mesh castShadow position={[0, 0.025, 0]}>
        <cylinderGeometry args={[0.26, 0.28, 0.05, 24]} />
        <meshStandardMaterial color="#0f172a" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* Brass ring accent on base */}
      <mesh position={[0, 0.055, 0]}>
        <cylinderGeometry args={[0.14, 0.14, 0.015, 20]} />
        <meshStandardMaterial color="#d4af37" metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Slender pole stem */}
      <mesh castShadow position={[0, 0.06 + stemHeight / 2, 0]}>
        <cylinderGeometry args={[0.02, 0.02, stemHeight, 16]} />
        <meshStandardMaterial color="#2d3748" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* Upper shade mounting arm / collar in brushed brass */}
      <mesh position={[0, height - 0.5, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.06, 16]} />
        <meshStandardMaterial color="#d4af37" metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Glowing conical / drum lampshade */}
      <mesh position={[0, shadeY, 0]} userData={{ officeMaterialDynamic: `stand-lamp-shade:interior:${lightColor}:0.5+factor*3.8` }}>
        <cylinderGeometry args={[0.26, 0.36, 0.44, 28, 1, true]} />
        <meshStandardMaterial
          color={isLightOn ? "#ffedd5" : "#e2e8f0"}
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.3}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* Visible glowing incandescent bulb center inside shade */}
      <mesh position={[0, shadeY, 0]} userData={{ officeMaterialDynamic: "stand-lamp-bulb:interior:conditional-orange:1.5*(0.5+factor*3.8)" }}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial
          color={isLightOn ? "#ffffff" : "#718096"}
          emissive={isLightOn ? "#ff922b" : "#000000"}
          emissiveIntensity={emissiveIntensity * 1.5}
          toneMapped={false}
        />
      </mesh>

      <FixtureSpotLight name="stand-lamp-downlight" position={[0, shadeY - 0.24, 0]}
        aim={[0, 0.05, 0.35]} intensity={factor * 10} distance={3.5} angle={1.05} color={lightColor} />
    </group>
  );
}

// Retain alias for existing imports
export const CornerLampFixture = StandLampFixture;

export interface DeskLampProps {
  position: [number, number, number];
  rotationY?: number;
  scale?: number;
  lightColor?: string;
}

/**
 * Task Desk Lamp / Lampu Meja Kerja Pijar.
 * Placed on executive desks, study nooks, or coffee tables.
 * Casts a focused, intimate working pool directly over the desk plane.
 */
export function DeskLampFixture({
  position,
  rotationY = 0,
  scale = 1,
  lightColor = "#ffb05c"
}: DeskLampProps) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const isLightOn = factor > 0.05;
  const emissiveIntensity = isLightOn ? 0.6 + factor * 3.5 : 0;

  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={scale}>
      {/* Heavy base */}
      <mesh castShadow position={[0, 0.015, 0]}>
        <cylinderGeometry args={[0.09, 0.1, 0.03, 16]} />
        <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Angled arm */}
      <mesh castShadow position={[0, 0.22, -0.05]} rotation={[-0.25, 0, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.42, 10]} />
        <meshStandardMaterial color="#d4af37" metalness={0.85} roughness={0.2} />
      </mesh>
      {/* Lamp hood / shade */}
      <mesh castShadow position={[0, 0.4, 0.06]} rotation={[0.55, 0, 0]}>
        <cylinderGeometry args={[0.05, 0.11, 0.14, 16, 1, true]} />
        <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.3} side={DoubleSide} />
      </mesh>
      {/* Glowing bulb inside hood */}
      <mesh position={[0, 0.38, 0.06]} userData={{ officeMaterialDynamic: `desk-lamp-bulb:interior:${lightColor}:0.6+factor*3.5` }}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshStandardMaterial
          color={isLightOn ? "#ffffff" : "#4a5568"}
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity}
          toneMapped={false}
        />
      </mesh>
      <FixtureSpotLight name="desk-lamp-task-beam" position={[0, 0.365, 0.065]}
        aim={[0, 0.01, 0.27]} intensity={factor * 3.5} distance={1.5} angle={0.95} color={lightColor} />
    </group>
  );
}

export interface CanopyDownlightProps {
  position: [number, number, number];
  diameter?: number;
  realLight?: boolean;
}

/**
 * Flush Recessed Architectural Canopy Downlight.
 * Mounted beneath the entrance canopy or floor slab soffits.
 */
export function CanopyDownlightFixture({
  position,
  diameter = 0.22,
  realLight = false
}: CanopyDownlightProps) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.exteriorLightFactor;
  const emissiveIntensity = factor * 1.15;

  return (
    <group position={position}>
      {realLight && <FixtureSpotLight name="entrance-canopy-downlight" position={[0, -0.055, 0]} aim={[0, -3.4, 0]} intensity={factor * 30} distance={6} angle={0.85} shadow />}
      {/* Outer trim ring in charcoal metal */}
      <mesh position={[0, -0.01, 0]}>
        <cylinderGeometry args={[diameter / 2, diameter / 2, 0.03, 20]} />
        <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Frosted lens */}
      <mesh position={[0, -0.022, 0]} userData={{ officeMaterialDynamic: "canopy-downlight:exterior:#fff7ed:0.25+factor*3.0" }}>
        <cylinderGeometry args={[diameter / 2 - 0.03, diameter / 2 - 0.03, 0.02, 20]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#fff7ed"
          emissiveIntensity={emissiveIntensity}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
