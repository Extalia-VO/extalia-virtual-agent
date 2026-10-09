import React from "react";
import * as THREE from "three";
import { useSolarEnvironment } from "../../../Environment";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { ceilingPendantDrop } from "./ceilingMounting";
import { useStructuralCeiling } from "./StructuralCeilingContext";

/**
 * Grand Monumental Halo Chandelier (Lampu Gantung Cincin Arsitektural Megah).
 * Features dual-tier brushed brass concentric rings suspended by delicate aircraft cables,
 * with continuous 360-degree frosted warm LED diffusers casting a golden pool of light.
 */
export function GrandHaloChandelier({
  position,
  outerRadius = 1.6,
  innerRadius = 1.05,
  drop = 0.85,
  lightColor = "#ffe5b4"
}: {
  position: [number, number, number];
  outerRadius?: number;
  innerRadius?: number;
  drop?: number;
  lightColor?: string;
}) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const emissiveIntensity = factor === 0 ? 0 : 0.4 + factor * 5.0;

  const { ceilingY } = useStructuralCeiling();
  const mountedDrop = ceilingPendantDrop(position[1], drop, ceilingY);
  const ringY = ceilingY - mountedDrop;

  return (
    <group position={[position[0], 0, position[2]]}>
      {/* Ceiling canopy plate in brushed brass */}
      <mesh name="structural-halo-canopy" position={[0, ceilingY - 0.02, 0]}>
        <cylinderGeometry args={[0.35, 0.35, 0.04, 24]} />
        <meshStandardMaterial color="#c5a059" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Slender stainless aircraft suspension cables */}
      {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((angle, idx) => {
        const cx = Math.cos(angle) * (outerRadius * 0.9);
        const cz = Math.sin(angle) * (outerRadius * 0.9);
        const from = new THREE.Vector3(0, ceilingY - 0.04, 0);
        const to = new THREE.Vector3(cx, ringY, cz);
        const direction = to.clone().sub(from);
        const cableLength = direction.length();
        const cableCenter = from.clone().add(to).multiplyScalar(0.5);
        const cableRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        return (
          <mesh
            key={`outer-cable-${idx}`}
            position={cableCenter}
            quaternion={cableRotation}
          >
            <cylinderGeometry args={[0.005, 0.005, cableLength, 8]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.2} />
          </mesh>
        );
      })}

      {/* OUTER TIER RING */}
      {/* Brass metallic ring body */}
      <mesh castShadow position={[0, ringY, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[outerRadius, 0.04, 16, 48]} />
        <meshStandardMaterial color="#b89345" metalness={0.9} roughness={0.22} />
      </mesh>
      {/* Outer illuminated frosted silicone continuous diffuser */}
      <mesh position={[0, ringY - 0.015, 0]} rotation={[Math.PI / 2, 0, 0]} userData={{ officeMaterialDynamic: `grand-halo-outer:interior:${lightColor}:0.4+factor*5` }}>
        <torusGeometry args={[outerRadius, 0.025, 12, 48]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>

      {/* INNER TIER RING (Lower slightly for dramatic tiered presence) */}
      <mesh castShadow position={[0, ringY - 0.18, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[innerRadius, 0.035, 16, 40]} />
        <meshStandardMaterial color="#b89345" metalness={0.9} roughness={0.22} />
      </mesh>
      {/* Inner illuminated frosted silicone continuous diffuser */}
      <mesh position={[0, ringY - 0.195, 0]} rotation={[Math.PI / 2, 0, 0]} userData={{ officeMaterialDynamic: `grand-halo-inner:interior:${lightColor}:(0.4+factor*5)*1.1` }}>
        <torusGeometry args={[innerRadius, 0.022, 12, 40]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive={lightColor}
          emissiveIntensity={emissiveIntensity * 1.1}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>

      {[0, 1, 2, 3].map(i => {
        const angle = i * Math.PI / 2;
        const x = Math.cos(angle) * innerRadius, z = Math.sin(angle) * innerRadius;
        return <FixtureSpotLight key={i} name="halo-chandelier-downlight" position={[x, ringY - 0.21, z]}
          aim={[x * 0.7, 0.05, z * 0.7]} intensity={factor * 9} distance={4.5} angle={1} color={lightColor} />;
      })}
    </group>
  );
}

/**
 * Grand Inlaid Floor Medallion (Medali Lantai Marmer Mewah).
 * Positioned in the central grand arrival hall to elevate entrance prestige.
 */
export function GrandFloorMedallion({
  position,
  radius = 2.4
}: {
  position: [number, number, number];
  radius?: number;
}) {
  return (
    <group position={position}>
      {/* Outer polished Calacatta gold circular base */}
      <mesh receiveShadow position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius, 36]} />
        <meshStandardMaterial color="#f7f5f0" roughness={0.25} metalness={0.12} />
      </mesh>

      {/* Outer Brass Inlay Ring */}
      <mesh receiveShadow position={[0, 0.025, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius - 0.06, radius, 36]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Secondary Contrasting Dark Nero Marquina Inlay Ring */}
      <mesh receiveShadow position={[0, 0.023, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 0.62, radius * 0.88, 36]} />
        <meshStandardMaterial color="#1e2229" roughness={0.3} metalness={0.2} />
      </mesh>

      {/* Mid Brass Inlay Ring */}
      <mesh receiveShadow position={[0, 0.026, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 0.62 - 0.035, radius * 0.62, 36]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Inner Central Star/Geometric Rosette in Polished Gold & Cream */}
      <mesh receiveShadow position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius * 0.42, 8]} />
        <meshStandardMaterial color="#ede6d6" roughness={0.2} metalness={0.18} />
      </mesh>
      <mesh receiveShadow position={[0, 0.027, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 8]}>
        <circleGeometry args={[radius * 0.28, 8]} />
        <meshStandardMaterial color="#c29b4e" metalness={0.85} roughness={0.22} />
      </mesh>
      <mesh receiveShadow position={[0, 0.028, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius * 0.12, 16]} />
        <meshStandardMaterial color="#1c1f24" roughness={0.3} />
      </mesh>
    </group>
  );
}

/**
 * Directional Wayfinding Oak & Terrazzo Runner with Inlaid Brass Edges (Selasar Koridor ke Tangga).
 * Guides visitors seamlessly from the Grand Lobby across to the foot of the floating staircase.
 */
export function CorridorWayfindingRunner({
  start,
  end,
  width = 2.4
}: {
  start: [number, number];
  end: [number, number];
  width?: number;
}) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.sqrt(dx * dx + dz * dz);
  const angle = Math.atan2(dx, dz);
  const midX = (start[0] + end[0]) / 2;
  const midZ = (start[1] + end[1]) / 2;

  return (
    <group position={[midX, 0.025, midZ]} rotation={[0, angle, 0]}>
      {/* Central warm herringbone oak runner */}
      <mesh receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[width, 0.015, length]} />
        <meshStandardMaterial color="#bf9d76" roughness={0.65} metalness={0.08} />
      </mesh>

      {/* Left Brass Inlay Border Strip */}
      <mesh receiveShadow position={[-width / 2 + 0.04, 0.005, 0]}>
        <boxGeometry args={[0.04, 0.018, length]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Right Brass Inlay Border Strip */}
      <mesh receiveShadow position={[width / 2 - 0.04, 0.005, 0]}>
        <boxGeometry args={[0.04, 0.018, length]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>
    </group>
  );
}

/**
 * Sculptural Display Plinth with Modern Bronze Art (Pedestal Patung Seni Arsitektural).
 * Placed in corridor niches and arrival plazas with focused pinpoint spotlights.
 */
export function SculpturalDisplayPlinth({
  position,
  rotationY = 0,
  sculptureColor = "#c59b53"
}: {
  position: [number, number, number];
  rotationY?: number;
  sculptureColor?: string;
}) {
  const { state } = useSolarEnvironment();
  const _factor = state.factors.interiorLightFactor;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Plinth Base Pedestal in Nero Marquina Fluted Stone */}
      <mesh castShadow receiveShadow position={[0, 0.5, 0]}>
        <boxGeometry args={[0.55, 1.0, 0.55]} />
        <meshStandardMaterial color="#1a1e24" roughness={0.35} metalness={0.2} />
      </mesh>
      {/* Brass Accent Collar */}
      <mesh position={[0, 1.015, 0]}>
        <boxGeometry args={[0.57, 0.03, 0.57]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Abstract Modern Geometric Bronze Sculpture (Twisted Ribbon / Dual Rings) */}
      <group position={[0, 1.45, 0]}>
        <mesh castShadow rotation={[0.4, 0.5, 0.2]}>
          <torusGeometry args={[0.26, 0.035, 12, 32]} />
          <meshStandardMaterial color={sculptureColor} metalness={0.92} roughness={0.18} />
        </mesh>
        <mesh castShadow rotation={[-0.5, -0.3, 0.6]}>
          <torusGeometry args={[0.18, 0.025, 12, 28]} />
          <meshStandardMaterial color="#dfb76c" metalness={0.92} roughness={0.18} />
        </mesh>
        <mesh castShadow position={[0, 0, 0]}>
          <sphereGeometry args={[0.07, 16, 16]} />
          <meshStandardMaterial color="#ffffff" roughness={0.1} metalness={0.3} />
        </mesh>
      </group>

      {/* Focused Pinpoint Spot / Uplight grazing the artwork */}
    </group>
  );
}

/**
 * Architectural Gallery Wall Canvas with Overhead Picture Light (Lukisan Galeri Seni).
 * Mounted along corridors and lobby walls to eliminate bare expanses.
 */
export function ArchitecturalGalleryCanvas({
  position,
  rotationY = 0,
  width = 2.4,
  height = 1.4,
  artTone = "warm-amber"
}: {
  position: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  artTone?: "warm-amber" | "emerald" | "ocean";
}) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const emissiveIntensity = factor > 0 ? 0.5 + factor * 2.2 : 0;

  const bgColors = {
    "warm-amber": "#38281c",
    "emerald": "#182d24",
    "ocean": "#16283b"
  };
  const accentColors = {
    "warm-amber": "#c89348",
    "emerald": "#529871",
    "ocean": "#568db3"
  };

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Floating Slim Anodized Black Metal Frame */}
      <mesh castShadow position={[0, 0, 0.02]}>
        <boxGeometry args={[width + 0.08, height + 0.08, 0.04]} />
        <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Art Canvas Body */}
      <mesh receiveShadow position={[0, 0, 0.035]}>
        <boxGeometry args={[width, height, 0.02]} />
        <meshStandardMaterial color={bgColors[artTone]} roughness={0.7} />
      </mesh>

      {/* Abstract Modern Composition Shapes */}
      <mesh position={[-width * 0.15, 0.08, 0.046]} rotation={[0, 0, 0.2]}>
        <boxGeometry args={[width * 0.55, height * 0.5, 0.005]} />
        <meshStandardMaterial color={accentColors[artTone]} roughness={0.5} metalness={0.2} />
      </mesh>
      <mesh position={[width * 0.18, -0.1, 0.048]} rotation={[0, 0, -0.3]}>
        <circleGeometry args={[height * 0.28, 24]} />
        <meshStandardMaterial color="#ede6d8" roughness={0.4} />
      </mesh>
      <mesh position={[width * 0.05, -height * 0.22, 0.05]}>
        <boxGeometry args={[width * 0.75, 0.04, 0.005]} />
        <meshStandardMaterial color="#d4af37" metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Overhead Brass Gallery Picture Light Fixture */}
      <group position={[0, height / 2 + 0.14, 0.18]}>
        {/* Wall bracket arm */}
        <mesh castShadow position={[0, -0.06, -0.08]} rotation={[0.4, 0, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.18, 8]} />
          <meshStandardMaterial color="#c5a059" metalness={0.9} roughness={0.2} />
        </mesh>
        {/* Horizontal light tubular fixture */}
        <mesh castShadow position={[0, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.022, 0.022, width * 0.55, 16]} />
          <meshStandardMaterial color="#c5a059" metalness={0.9} roughness={0.2} />
        </mesh>
        {/* Downward grazing light slit */}
        <mesh position={[0, -0.015, -0.01]} userData={{ officeMaterialDynamic: "gallery-picture-light:interior:#ffedd5:0.5+factor*2.2" }}>
          <boxGeometry args={[width * 0.52, 0.01, 0.02]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive="#ffedd5"
            emissiveIntensity={emissiveIntensity}
            toneMapped={false}
          />
        </mesh>
        <FixtureSpotLight name="gallery-picture-wash" position={[0, -0.025, 0]}
          aim={[0, -height * 0.6, -0.08]} intensity={factor * 2} distance={2} angle={0.85} color="#ffedd5" />
      </group>
    </group>
  );
}

/**
 * Monumental Fluted Architectural Planter (Jambangan Tanaman Megah).
 * Elegant fluted bronze/charcoal cylinder with lush indoor Kentia palm foliage.
 */
export function MonumentalPlanter({
  position,
  scale = 1.0,
  potColor = "#262b33"
}: {
  position: [number, number, number];
  scale?: number;
  potColor?: string;
}) {
  return (
    <group position={position} scale={scale}>
      {/* Heavy fluted cylindrical pot */}
      <mesh castShadow position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.42, 0.35, 1.0, 24]} />
        <meshStandardMaterial color={potColor} roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Polished brass rim accent */}
      <mesh position={[0, 1.01, 0]}>
        <cylinderGeometry args={[0.435, 0.435, 0.03, 24]} />
        <meshStandardMaterial color="#d4af37" metalness={0.88} roughness={0.2} />
      </mesh>
      {/* Dark soil base */}
      <mesh position={[0, 0.96, 0]}>
        <cylinderGeometry args={[0.4, 0.4, 0.05, 16]} />
        <meshStandardMaterial color="#1a1510" roughness={0.9} />
      </mesh>

      {/* Lush Layered Foliage (Kentia palm / Ficus fronds) */}
      {[0, 0.8, 1.6, 2.4, 3.2, 4.0, 4.8, 5.6].map((rot, idx) => {
        const leafH = 1.4 + (idx % 3) * 0.15;
        const tilt = 0.28 + (idx % 2) * 0.14;
        return (
          <group key={`palm-frond-${idx}`} position={[0, 0.98, 0]} rotation={[0, rot, 0]}>
            {/* Slender green stem */}
            <mesh
              castShadow
              position={[Math.sin(tilt) * (leafH / 2), leafH / 2, 0]}
              rotation={[0, 0, -tilt]}
            >
              <cylinderGeometry args={[0.012, 0.02, leafH, 8]} />
              <meshStandardMaterial color="#2d5236" roughness={0.6} />
            </mesh>
            {/* Lush feather leaf fan */}
            <mesh
              castShadow
              position={[Math.sin(tilt) * leafH, leafH * 0.85, 0]}
              rotation={[0, 0, -tilt * 1.3]}
            >
              <sphereGeometry args={[0.34, 10, 8]} />
              <meshStandardMaterial
                color={idx % 2 === 0 ? "#2d633d" : "#38784b"}
                roughness={0.55}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/**
 * Modern Suspended Trio Pendant Light Cluster over Bar Counter.
 * Replaces dark dead space over the hospitality bar with warm amber illumination.
 */
export function BarPendantCluster({
  position,
  spacing = 1.1,
  drop = 1.1
}: {
  position: [number, number, number];
  spacing?: number;
  drop?: number;
}) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const emissiveIntensity = factor > 0 ? 1.0 + factor * 4.0 : 0;
  const { ceilingY } = useStructuralCeiling();

  return (
    <group position={position}>
      {[-spacing, 0, spacing].map((offset, idx) => {
        const pendantY = 2.85 - drop;
        const canopyY = ceilingY - position[1];
        const mountedDrop = canopyY - pendantY;
        return (
          <group key={`pendant-${idx}`} position={[offset, 0, 0]}>
            {/* Slender ceiling cable */}
            <mesh name="structural-bar-pendant-canopy" position={[0, canopyY - 0.02, 0]}>
              <cylinderGeometry args={[0.045, 0.045, 0.04, 8]} />
              <meshStandardMaterial color="#d4af37" metalness={0.9} roughness={0.2} />
            </mesh>
            <mesh position={[0, canopyY - mountedDrop / 2, 0]}>
              <cylinderGeometry args={[0.005, 0.005, mountedDrop, 8]} />
              <meshStandardMaterial color="#0f172a" metalness={0.8} />
            </mesh>

            {/* Brass socket cap */}
            <mesh position={[0, pendantY + 0.16, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 0.08, 12]} />
              <meshStandardMaterial color="#d4af37" metalness={0.9} roughness={0.2} />
            </mesh>

            {/* Warm Amber Fluted Glass Teardrop Shade */}
            <mesh castShadow position={[0, pendantY, 0]}>
              <cylinderGeometry args={[0.1, 0.18, 0.28, 16, 1, true]} />
              <meshStandardMaterial
                color="#ffe0b2"
                transparent
                opacity={0.75}
                roughness={0.15}
                metalness={0.1}
                side={THREE.DoubleSide}
              />
            </mesh>

            {/* Glowing Filament Core */}
            <mesh position={[0, pendantY, 0]} userData={{ officeMaterialDynamic: "bar-pendant-filament:interior:#ff9820:(1+factor*4)*1.4" }}>
              <sphereGeometry args={[0.045, 12, 12]} />
              <meshStandardMaterial
                color="#ffffff"
                emissive="#ff9820"
                emissiveIntensity={emissiveIntensity * 1.4}
                toneMapped={false}
              />
            </mesh>

            <FixtureSpotLight name="bar-pendant-task-beam" position={[0, pendantY - 0.15, 0]}
              aim={[0, 1.05, 0]} intensity={factor * 8} distance={2.8} angle={0.9} color="#ffe2b8" />
          </group>
        );
      })}
    </group>
  );
}

/**
 * Modern Linear Suspended Brass Pendant Fixture over High-top / Communal Dining Table.
 */
export function DiningLinearPendant({
  position,
  length = 3.6,
  drop = 1.05
}: {
  position: [number, number, number];
  length?: number;
  drop?: number;
}) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const emissiveIntensity = factor > 0 ? 1.0 + factor * 4.0 : 0;
  const fixtureY = position[1] - drop;
  const { ceilingY } = useStructuralCeiling();
  const mountedDrop = ceilingPendantDrop(position[1], drop, ceilingY);

  return (
    <group position={[position[0], 0, position[2]]}>
      {/* Twin suspension cables */}
      {[-length * 0.38, length * 0.38].map((cx, idx) => (
        <group key={`linear-cable-${idx}`}>
          <mesh name="structural-dining-canopy" position={[cx, ceilingY - 0.02, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.04, 8]} />
            <meshStandardMaterial color="#c5a059" metalness={0.88} roughness={0.2} />
          </mesh>
          <mesh position={[cx, ceilingY - mountedDrop / 2, 0]}>
            <cylinderGeometry args={[0.005, 0.005, mountedDrop, 8]} />
            <meshStandardMaterial color="#0f172a" metalness={0.8} />
          </mesh>
        </group>
      ))}

      {/* Minimalist Brushed Brass Horizontal Bar */}
      <mesh castShadow position={[0, fixtureY, 0]}>
        <boxGeometry args={[length, 0.04, 0.05]} />
        <meshStandardMaterial color="#c5a059" metalness={0.88} roughness={0.2} />
      </mesh>

      {/* Downward continuous warm LED light diffuser */}
      <mesh position={[0, fixtureY - 0.022, 0]} userData={{ officeMaterialDynamic: "dining-linear-pendant:interior:#ffe2b8:1+factor*4" }}>
        <boxGeometry args={[length - 0.08, 0.01, 0.035]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffe2b8"
          emissiveIntensity={emissiveIntensity}
          toneMapped={false}
        />
      </mesh>

      {[-1, 0, 1].map(i => <FixtureSpotLight key={i} name="dining-linear-task-beam"
        position={[i * length * 0.27, fixtureY - 0.027, 0]} aim={[i * length * 0.27, 1.04, 0]}
        intensity={factor * 6} distance={3.5} angle={0.9} color="#ffe2b8" />)}
    </group>
  );
}
