import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import type { AvatarAccessoryConfig } from "./appearance";
import { irisTexture } from "./avatarTextures";

/** Facial features use head-relative units so every generated stature stays coherent. */
export function HumanoidFace({ radius, skin, hair, seed, accessories, reducedMotion = false }: {
  radius: number;
  skin: string;
  hair: string;
  seed: number;
  accessories?: AvatarAccessoryConfig;
  reducedMotion?: boolean;
}) {
  const stackOverview = true;
  const eyes = useRef<Group>(null);
  const gaze = useRef<Group>(null);
  const clock = useRef((seed % 1793) / 137);
  const blinkPeriod = 3.2 + (seed % 173) / 100;
  useFrame((_, dt) => {
    if (reducedMotion) { if (eyes.current) eyes.current.scale.y = 1; if (gaze.current) gaze.current.position.set(0, 0, 0); return; }
    clock.current += Math.max(0, dt);
    // Hidden close-up details retain their phase without updating cosmetic bones.
    for (let parent = eyes.current; parent; parent = parent.parent as Group | null) {
      if (!parent.visible) return;
    }
    const blinkTime = clock.current % blinkPeriod;
    // One short blink per independently phased interval, without React updates.
    const openness = blinkTime < 0.16
      ? 1 - Math.sin((blinkTime / 0.16) * Math.PI) * 0.95
      : 1;
    if (eyes.current) eyes.current.scale.y = openness;
    // Slow saccade-like drift keeps the irises alive between blinks.
    if (gaze.current) {
      const t = clock.current;
      gaze.current.position.x = Math.sin(t * 0.37 + seed) * 0.012 + Math.sin(t * 1.9) * 0.003;
      gaze.current.position.y = Math.sin(t * 0.23 + seed * 0.5) * 0.006;
    }
  });

  const irisColor = ["#695e44", "#586d63", "#697f88", "#574132"][seed % 4] ?? "#695e44";
  const iris = useMemo(() => irisTexture(irisColor), [irisColor]);
  // Seeded brow shapes: soft arch, straight, high arch; never animated per frame.
  const brow = [
    { lift: 0.2, thickness: 0.028, innerTilt: 0.04, tailTilt: 0.2, arch: 0.04 },
    { lift: 0.19, thickness: 0.034, innerTilt: 0.02, tailTilt: 0.06, arch: 0.01 },
    { lift: 0.215, thickness: 0.024, innerTilt: 0.1, tailTilt: 0.3, arch: 0.06 }
  ][(seed >>> 3) % 3]!;
  const lip = [
    { upper: "#a87265", lower: "#b57f71", fullness: 0.03, smile: 0.06 },
    { upper: "#93605a", lower: "#a36c63", fullness: 0.034, smile: 0.03 },
    { upper: "#b77e74", lower: "#c08a7d", fullness: 0.028, smile: 0.09 }
  ][(seed >>> 5) % 3]!;
  const earbuds = accessories?.custom?.includes("earbuds") && !accessories?.headphones;

  return <group scale={radius}>
    {/* Jaw, chin and cheek planes break the head sphere into a sculpted face. */}
    <mesh position={[0, -0.5, 0.56]} scale={[0.27, 0.2, 0.3]}>
      <sphereGeometry args={[1, 18, 12]} /><meshStandardMaterial color={skin} roughness={0.8} />
    </mesh>
    {[-1, 1].map(side => <mesh key={`jaw:${side}`} position={[side * 0.5, -0.42, 0.35]} rotation={[0.25, side * 0.55, side * -0.35]} scale={[0.32, 0.18, 0.42]}>
      <sphereGeometry args={[1, 16, 10]} /><meshStandardMaterial color={skin} roughness={0.82} />
    </mesh>)}
    {[-1, 1].map(side => <mesh key={`cheek:${side}`} position={[side * 0.47, -0.12, 0.76]} scale={[0.22, 0.17, 0.12]}>
      <sphereGeometry args={[1, 14, 10]} /><meshStandardMaterial color={skin} roughness={0.78} emissive="#c0524a" emissiveIntensity={0.04} />
    </mesh>)}
    {/* Brow ridge shades the eye sockets. */}
    <mesh position={[0, 0.17, 0.86]} scale={[0.62, 0.09, 0.14]}>
      <sphereGeometry args={[1, 18, 8]} /><meshStandardMaterial color={skin} roughness={0.84} />
    </mesh>

    {/* Ears: outer helix rim, antihelix fold, concha bowl, tragus and lobe. */}
    {[-1, 1].map(side => <group key={`ear:${side}`} position={[side * 0.96, -0.03, -0.02]} rotation={[0, side * 0.35, 0]}>
      <mesh rotation={[0, side * Math.PI / 2, 0]} scale={[0.17, 0.27, 1]}>
        <torusGeometry args={[1, 0.24, 8, 18]} /><meshStandardMaterial color={skin} roughness={0.82} />
      </mesh>
      <mesh position={[side * 0.02, 0.01, 0]} scale={[0.07, 0.22, 0.15]}>
        <sphereGeometry args={[1, 10, 8]} /><meshStandardMaterial color={skin} roughness={0.84} />
      </mesh>
      <mesh position={[side * 0.035, -0.04, 0.02]} scale={[0.04, 0.09, 0.08]}>
        <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color="#7d4f45" roughness={0.95} />
      </mesh>
      <mesh position={[side * 0.03, -0.05, 0.12]} scale={[0.04, 0.05, 0.035]}>
        <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={skin} roughness={0.84} />
      </mesh>
      <mesh position={[0, -0.25, 0.01]} scale={[0.07, 0.08, 0.08]}>
        <sphereGeometry args={[1, 10, 8]} /><meshStandardMaterial color={skin} roughness={0.84} emissive="#c0524a" emissiveIntensity={0.05} />
      </mesh>
      {earbuds && <group position={[side * 0.07, -0.05, 0.04]}>
        <mesh scale={[0.07, 0.08, 0.08]}><sphereGeometry args={[1, 12, 10]} /><meshPhysicalMaterial color="#f4f5f6" roughness={0.18} clearcoat={1} /></mesh>
        <mesh position={[0, -0.13, 0.01]}><capsuleGeometry args={[0.022, 0.16, 4, 8]} /><meshPhysicalMaterial color="#f4f5f6" roughness={0.18} clearcoat={1} /></mesh>
      </group>}
    </group>)}

    <group position={[0, 0.1, 0]}>
      {/* Eye sockets: soft shadow behind each eye reads as depth from the isometric camera. */}
      {[-1, 1].map(side => <mesh key={`socket:${side}`} position={[side * 0.36, -0.005, 0.895]} rotation={[0, side * 0.18, 0]} scale={[0.19, 0.12, 0.03]}>
        <sphereGeometry args={[1, 14, 10]} /><meshStandardMaterial color="#5b3f37" roughness={0.95} transparent opacity={0.35} depthWrite={false} />
      </mesh>)}
      <group ref={eyes}>
        {[-1, 1].map(side => <group key={`eye:${side}`} position={[side * 0.36, 0, 0.918]} rotation={[0, side * 0.18, 0]}>
          {/* Sclera with a faint warm tint toward the corners. */}
          <mesh scale={[0.155, 0.091, 0.042]}>
            <sphereGeometry args={[1, 18, 12]} />
            <meshStandardMaterial color="#f1ece2" roughness={0.45} />
          </mesh>
          {/* Inner canthus / tear duct. */}
          <mesh position={[side * -0.145, -0.008, 0.012]} scale={[0.022, 0.02, 0.012]}>
            <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color="#d58e88" roughness={0.4} />
          </mesh>
          <group ref={side === 1 ? gaze : undefined}>
            {/* Textured iris disc with radial fibers, limbal ring and pupil. */}
            <mesh position={[0, 0, 0.042]}>
              <circleGeometry args={[0.07, 28]} />
              <meshStandardMaterial map={iris} color={iris ? "#ffffff" : irisColor} roughness={0.42} />
            </mesh>
            {!iris && <mesh position={[0, 0, 0.044]}><circleGeometry args={[0.03, 18]} /><meshStandardMaterial color="#0b0d0f" roughness={0.3} /></mesh>}
            {/* Cornea: clear glossy dome catches environment light. */}
            <mesh position={[0, 0, 0.034]} scale={[0.078, 0.078, 0.022]}>
              <sphereGeometry args={[1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshPhysicalMaterial color="#ffffff" transparent opacity={0.18} roughness={0.02} clearcoat={1} clearcoatRoughness={0} depthWrite={false} />
            </mesh>
            {/* Primary and secondary specular catchlights. */}
            <mesh position={[-0.024, 0.026, 0.06]}><circleGeometry args={[0.014, 12]} /><meshBasicMaterial color="#fffaf0" /></mesh>
            <mesh position={[0.022, -0.02, 0.058]}><circleGeometry args={[0.006, 8]} /><meshBasicMaterial color="#fffaf0" transparent opacity={0.7} /></mesh>
          </group>
          {/* Lids follow the blink scale with the eyeball, wrapping it top and bottom. */}
          <mesh position={[0, 0.05, 0.012]} rotation={[-0.25, 0, 0]} scale={[0.168, 0.05, 0.05]}>
            <sphereGeometry args={[1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={skin} roughness={0.8} />
          </mesh>
          <mesh position={[0, -0.058, 0.012]} rotation={[0.2, 0, 0]} scale={[0.16, 0.03, 0.045]}>
            <sphereGeometry args={[1, 14, 6]} /><meshStandardMaterial color={skin} roughness={0.82} />
          </mesh>
        </group>)}
      </group>
      {/* Upper lid crease, lash line with a flicked outer tail, lower lash shadow. */}
      {[-1, 1].map(side => <group key={`lid:${side}`} position={[side * 0.36, 0.068, 0.93]} rotation={[0, side * 0.18, 0]}>
        <mesh position={[0, 0.03, -0.006]} scale={[0.16, 0.012, 0.02]}><sphereGeometry args={[1, 12, 4]} /><meshStandardMaterial color="#8d6559" roughness={0.9} transparent opacity={0.55} /></mesh>
        <mesh position={[0, -0.02, 0.026]} scale={[0.158, 0.013, 0.016]}><sphereGeometry args={[1, 14, 4]} /><meshStandardMaterial color="#1c1615" roughness={0.6} /></mesh>
        <mesh position={[side * 0.15, -0.012, 0.018]} rotation={[0, 0, side * 0.45]} scale={[0.04, 0.008, 0.01]}><sphereGeometry args={[1, 8, 4]} /><meshStandardMaterial color="#1c1615" roughness={0.6} /></mesh>
        <mesh position={[0, -0.13, 0.014]} scale={[0.13, 0.006, 0.01]}><sphereGeometry args={[1, 10, 4]} /><meshStandardMaterial color="#4a3631" roughness={0.9} transparent opacity={0.6} /></mesh>
      </group>)}
      {[-1, 1].map(side => <group key={`brow:${side}`} position={[side * 0.36, brow.lift, 0.905]} rotation={[0, side * 0.18, 0]}>
        {/* Three tapered strokes: dense head, arched body and fine tail. */}
        <mesh position={[side * -0.1, -0.005, 0]} rotation={[0, 0, side * -brow.innerTilt + side * 0.3]} scale={[0.045, brow.thickness * 1.15, 0.03]}>
          <sphereGeometry args={[1, 10, 6]} /><meshStandardMaterial color={hair} roughness={0.95} />
        </mesh>
        <mesh position={[side * -0.03, brow.arch * 0.3, 0]} rotation={[0, 0, side * -brow.innerTilt]} scale={[0.09, brow.thickness, 0.03]}>
          <sphereGeometry args={[1, 12, 6]} /><meshStandardMaterial color={hair} roughness={0.95} />
        </mesh>
        <mesh position={[side * 0.08, -brow.arch * 0.4, 0]} rotation={[0, 0, side * -brow.tailTilt]} scale={[0.09, brow.thickness * 0.7, 0.026]}>
          <sphereGeometry args={[1, 12, 6]} /><meshStandardMaterial color={hair} roughness={0.95} />
        </mesh>
      </group>)}
    </group>

    {/* Nose: bridge, dorsum highlight, rounded tip, alar wings and nostrils. */}
    <mesh position={[0, 0.07, 0.955]} scale={[0.055, 0.17, 0.065]}>
      <sphereGeometry args={[1, 12, 10]} /><meshStandardMaterial color={skin} roughness={0.8} />
    </mesh>
    <mesh position={[0, 0.02, 1.0]} scale={[0.02, 0.1, 0.02]}>
      <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={skin} roughness={0.5} emissive="#ffffff" emissiveIntensity={0.03} />
    </mesh>
    <mesh position={[0, -0.085, 0.995]} scale={[0.09, 0.1, 0.1]}>
      <sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={skin} roughness={0.72} />
    </mesh>
    {[-1, 1].map(side => <group key={`ala:${side}`}>
      <mesh position={[side * 0.085, -0.13, 0.955]} rotation={[0, side * 0.4, 0]} scale={[0.055, 0.048, 0.058]}>
        <sphereGeometry args={[1, 12, 8]} /><meshStandardMaterial color={skin} roughness={0.82} />
      </mesh>
      <mesh position={[side * 0.042, -0.165, 0.985]} rotation={[-1.1, 0, 0]} scale={[0.024, 0.014, 0.012]}>
        <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color="#3b2723" roughness={0.95} />
      </mesh>
    </group>)}
    {/* Nasolabial folds frame the mouth. */}
    {[-1, 1].map(side => <mesh key={`fold:${side}`} position={[side * 0.2, -0.27, 0.9]} rotation={[0, 0, side * 0.35]} scale={[0.012, 0.11, 0.02]}>
      <sphereGeometry args={[1, 6, 8]} /><meshStandardMaterial color="#6b4a40" roughness={0.95} transparent opacity={0.28} depthWrite={false} />
    </mesh>)}
    {/* Philtrum: two ridges with a soft groove down to the cupid's bow. */}
    {[-1, 1].map(side => <mesh key={`philtrum:${side}`} position={[side * 0.026, -0.255, 0.95]} scale={[0.014, 0.065, 0.02]}>
      <sphereGeometry args={[1, 6, 8]} /><meshStandardMaterial color={skin} roughness={0.78} />
    </mesh>)}
    <mesh position={[0, -0.25, 0.94]} scale={[0.016, 0.06, 0.012]}>
      <sphereGeometry args={[1, 6, 8]} /><meshStandardMaterial color="#7a5348" roughness={0.95} transparent opacity={0.3} depthWrite={false} />
    </mesh>
    {/* Lips: cupid's bow upper lip, tubercle, fuller lower lip, corners lifted into a slight smile. */}
    {[-1, 1].map(side => <mesh key={`upper-lip:${side}`} position={[side * 0.052, -0.342, 0.935]} rotation={[0.1, 0, side * -(0.16 + lip.smile)]} scale={[0.085, 0.028, 0.03]}>
      <sphereGeometry args={[1, 14, 8]} /><meshPhysicalMaterial color={lip.upper} roughness={0.5} clearcoat={0.3} clearcoatRoughness={0.6} />
    </mesh>)}
    <mesh position={[0, -0.35, 0.958]} scale={[0.026, 0.02, 0.018]}>
      <sphereGeometry args={[1, 8, 6]} /><meshPhysicalMaterial color={lip.upper} roughness={0.5} clearcoat={0.3} />
    </mesh>
    <mesh position={[0, -0.368, 0.94]} scale={[0.15, 0.006, 0.014]}>
      <sphereGeometry args={[1, 14, 4]} /><meshStandardMaterial color="#4e302c" roughness={0.9} />
    </mesh>
    {[-1, 1].map(side => <mesh key={`corner:${side}`} position={[side * 0.15, -0.36 + lip.smile * 0.15, 0.915]} scale={[0.016, 0.012, 0.012]}>
      <sphereGeometry args={[1, 6, 6]} /><meshStandardMaterial color="#5a3a35" roughness={0.9} />
    </mesh>)}
    <mesh position={[0, -0.397, 0.927]} rotation={[0.18, 0, 0]} scale={[0.13, lip.fullness, 0.032]}>
      <sphereGeometry args={[1, 16, 8]} /><meshPhysicalMaterial color={lip.lower} roughness={0.42} clearcoat={0.45} clearcoatRoughness={0.5} />
    </mesh>
    {/* Mentolabial sulcus and chin pad. */}
    <mesh position={[0, -0.47, 0.88]} scale={[0.09, 0.012, 0.02]}>
      <sphereGeometry args={[1, 10, 4]} /><meshStandardMaterial color="#6b4a40" roughness={0.95} transparent opacity={0.3} depthWrite={false} />
    </mesh>
    <mesh position={[0, -0.6, 0.76]} scale={[0.13, 0.09, 0.08]}>
      <sphereGeometry args={[1, 12, 8]} /><meshStandardMaterial color={skin} roughness={0.78} />
    </mesh>
    {accessories?.glasses && <Glasses stackOverview={stackOverview} style={accessories.glassesStyle ?? (["rectangular", "round", "rimless"] as const)[seed % 3]!} />}
    {accessories?.headphones && <Headphones />}
  </group>;
}

const FRAME = "#22292f";

/** Rounded-rectangle frame outline (wayfarer) built as a closed shape for torus-like rims. */
function LensFrame({ style, frame }: { style: NonNullable<AvatarAccessoryConfig["glassesStyle"]>; frame: { color: string; metalness: number; roughness: number } }) {
  if (style === "round") {
    return <mesh><torusGeometry args={[0.25, 0.016, 8, 32]} /><meshStandardMaterial {...frame} /></mesh>;
  }
  if (style === "rimless") {
    // Rimless: only a fine top bar and visible drill mounts at the lens edges.
    return <group>
      <mesh position={[0, 0.215, 0]}><boxGeometry args={[0.46, 0.014, 0.014]} /><meshStandardMaterial {...frame} /></mesh>
      {[-1, 1].map(edge => <mesh key={edge} position={[edge * 0.25, 0.12, 0.004]}><cylinderGeometry args={[0.012, 0.012, 0.02, 8]} /><meshStandardMaterial {...frame} /></mesh>)}
    </group>;
  }
  // Rectangular acetate: thick brow line and thinner lower rim.
  return <group>
    <mesh position={[0, 0.19, 0]}><boxGeometry args={[0.6, 0.06, 0.04]} /><meshStandardMaterial {...frame} /></mesh>
    <mesh position={[0, -0.17, 0]}><boxGeometry args={[0.52, 0.03, 0.035]} /><meshStandardMaterial {...frame} /></mesh>
    {[-1, 1].map(edge => <mesh key={edge} position={[edge * 0.285, 0.01, 0]} rotation={[0, 0, edge * 0.08]}><boxGeometry args={[0.035, 0.38, 0.035]} /><meshStandardMaterial {...frame} /></mesh>)}
  </group>;
}

export function Glasses({ style, stackOverview = false }: {
  style: NonNullable<AvatarAccessoryConfig["glassesStyle"]>; stackOverview?: boolean;
}) {
  // Tiny overview lenses use alpha glazing; transmission would render all three floors twice.
  const frame = style === "rimless"
    ? { color: "#c9c3b6", metalness: 0.9, roughness: 0.18 }
    : style === "round"
      ? { color: "#b08a4a", metalness: 0.85, roughness: 0.22 }
      : { color: FRAME, metalness: 0.15, roughness: 0.32 };
  return <group position={[0, 0.1, 1.005]}>
    {[-1, 1].map(side => <group key={`frame:${side}`}>
      <group position={[side * 0.37, 0, 0]}>
        <LensFrame style={style} frame={frame} />
        {/* Transmissive lens with a faint blue anti-reflective tint and clearcoat glint. */}
        <mesh position={[0, 0, -0.004]} scale={style === "round" ? [1, 1, 1] : [1.1, 0.78, 1]}>
          <circleGeometry args={[0.25, style === "round" ? 32 : 24]} />
          <meshPhysicalMaterial color="#dcebf4" transparent opacity={0.22} roughness={0.02} metalness={0} transmission={stackOverview ? 0 : 0.9} thickness={0.02} clearcoat={1} clearcoatRoughness={0} depthWrite={false} />
        </mesh>
        <mesh position={[-0.09, 0.09, 0.002]} rotation={[0, 0, 0.7]}><planeGeometry args={[0.03, 0.14]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} /></mesh>
      </group>
      {/* Hinge, temple arm running back along the head and the curved ear tip. */}
      <mesh position={[side * 0.66, 0.06, -0.02]}><boxGeometry args={[0.05, 0.05, 0.05]} /><meshStandardMaterial {...frame} metalness={0.8} /></mesh>
      <mesh position={[side * 0.7, 0.05, -0.4]} rotation={[0.04, side * -0.1, 0]}><boxGeometry args={[0.022, 0.03, 0.78]} /><meshStandardMaterial {...frame} /></mesh>
      <mesh position={[side * 0.73, -0.06, -0.82]} rotation={[0.8, 0, 0]}><boxGeometry args={[0.022, 0.026, 0.2]} /><meshStandardMaterial {...frame} /></mesh>
      {/* Nose pads on wire arms. */}
      <mesh position={[side * 0.12, -0.1, -0.03]} rotation={[0, side * 0.5, 0]} scale={[0.028, 0.04, 0.012]}><sphereGeometry args={[1, 8, 6]} /><meshPhysicalMaterial color="#eef0ee" transparent opacity={0.65} roughness={0.15} /></mesh>
    </group>)}
    {/* Bridge: keyhole arc for round metal, straight bar for acetate. */}
    {style === "round"
      ? <mesh position={[0, 0.02, 0]}><torusGeometry args={[0.09, 0.012, 6, 14, Math.PI]} /><meshStandardMaterial {...frame} /></mesh>
      : <mesh position={[0, style === "rimless" ? 0.115 : 0.07, 0]}><boxGeometry args={[0.2, style === "rimless" ? 0.014 : 0.04, 0.03]} /><meshStandardMaterial {...frame} /></mesh>}
  </group>;
}

export function Headphones() {
  return <group>
    {/* Brushed metal arc with a padded leather band underneath. */}
    <mesh position={[0, 0.045, -0.04]}>
      <torusGeometry args={[1.1, 0.055, 10, 32, Math.PI]} /><meshStandardMaterial color="#c9ccd0" metalness={0.85} roughness={0.22} />
    </mesh>
    <mesh position={[0, 0.045, -0.04]} rotation={[0, 0, Math.PI * 0.19]}>
      <torusGeometry args={[1.03, 0.075, 10, 24, Math.PI * 0.62]} /><meshStandardMaterial color="#20262c" roughness={0.7} />
    </mesh>
    {[-1, 1].map(side => <group key={`earcup:${side}`} position={[side * 1.08, -0.04, -0.02]}>
      {/* Slider and yoke hold the cup. */}
      <mesh position={[side * 0.02, 0.42, 0]}><boxGeometry args={[0.06, 0.2, 0.08]} /><meshStandardMaterial color="#9aa1a7" metalness={0.85} roughness={0.25} /></mesh>
      <mesh position={[side * 0.02, 0.26, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.3, 0.025, 6, 16, Math.PI]} /><meshStandardMaterial color="#c9ccd0" metalness={0.85} roughness={0.22} /></mesh>
      <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.36, 0.38, 0.2, 28]} /><meshStandardMaterial color="#2a333b" roughness={0.42} metalness={0.3} /></mesh>
      {/* Memory foam cushion and fabric driver cover. */}
      <mesh position={[side * -0.11, 0, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[0.28, 0.085, 10, 24]} /><meshStandardMaterial color="#15191c" roughness={0.92} /></mesh>
      <mesh position={[side * -0.1, 0, 0]} rotation={[0, side * -Math.PI / 2, 0]}><circleGeometry args={[0.22, 20]} /><meshStandardMaterial color="#383f46" roughness={1} /></mesh>
      {/* Outer cap with machined ring and status LED. */}
      <mesh position={[side * 0.105, 0, 0]} rotation={[0, side * Math.PI / 2, 0]}><circleGeometry args={[0.26, 28]} /><meshStandardMaterial color="#9aa3aa" metalness={0.9} roughness={0.18} /></mesh>
      <mesh position={[side * 0.108, 0, 0]} rotation={[0, side * Math.PI / 2, 0]}><ringGeometry args={[0.2, 0.22, 28]} /><meshStandardMaterial color="#5d666e" metalness={0.9} roughness={0.3} /></mesh>
      <mesh position={[side * 0.11, -0.18, 0.12]}><sphereGeometry args={[0.018, 8, 6]} /><meshBasicMaterial color="#5fd0ff" /></mesh>
    </group>)}
  </group>;
}
