import { useMemo, type MutableRefObject, type ReactNode } from "react";
import { Color, type Group } from "three";
import type { AvatarAccessoryConfig, AvatarBagStyle } from "./appearance";
import { hairStrandTexture, watchDialTexture } from "./avatarTextures";
import { ClothMaterial } from "./AvatarWardrobe";
type WatchStyle = NonNullable<AvatarAccessoryConfig["watchStyle"]>;

export function Watch({ style }: { style: WatchStyle }) {
  const dial = useMemo(() => watchDialTexture(style), [style]);
  const crystal = <meshPhysicalMaterial color="#ffffff" transparent opacity={0.16} roughness={0} clearcoat={1} clearcoatRoughness={0} depthWrite={false} />;
  if (style === "smart") return <group position={[0, 0.045, 0]}>
    {/* Sport band with a perforated pin-and-tuck strap. */}
    <mesh><cylinderGeometry args={[0.05, 0.05, 0.022, 16, 1, true]} /><meshStandardMaterial color="#1d2226" roughness={0.6} side={2} /></mesh>
    {[-0.04, -0.02].map(z => <mesh key={z} position={[0, 0, z]}><boxGeometry args={[0.006, 0.006, 0.004]} /><meshStandardMaterial color="#0b0d0f" /></mesh>)}
    {/* Rounded aluminium case, side button and digital crown. */}
    <mesh position={[0, 0, 0.05]}><boxGeometry args={[0.042, 0.048, 0.012]} /><meshStandardMaterial color="#2b3035" roughness={0.25} metalness={0.8} /></mesh>
    <mesh position={[0.023, 0.008, 0.05]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.005, 0.005, 0.006, 12]} /><meshStandardMaterial color="#c0392b" metalness={0.6} roughness={0.3} /></mesh>
    <mesh position={[0.022, -0.01, 0.05]}><boxGeometry args={[0.003, 0.012, 0.006]} /><meshStandardMaterial color="#3a4046" metalness={0.8} /></mesh>
    <mesh position={[0, 0, 0.0565]}><planeGeometry args={[0.035, 0.041]} /><meshStandardMaterial map={dial} color="#ffffff" emissive="#3c88b0" emissiveMap={dial} emissiveIntensity={0.9} roughness={0.15} /></mesh>
    <mesh position={[0, 0, 0.0572]}><planeGeometry args={[0.038, 0.044]} />{crystal}</mesh>
  </group>;
  const luxury = style === "luxury";
  const metal = luxury ? "#d0b06a" : "#a6aeb2";
  return <group position={[0, 0.045, 0]}>
    {/* Strap: stitched leather for classic; three-row link bracelet for luxury. */}
    <mesh><cylinderGeometry args={[0.05, 0.05, 0.024, luxury ? 24 : 16, 1, true]} /><meshStandardMaterial color={luxury ? metal : "#433b34"} roughness={luxury ? 0.3 : 0.7} metalness={luxury ? 0.85 : 0} side={2} /></mesh>
    {luxury
      ? Array.from({ length: 14 }, (_, i) => {
          const angle = (i / 14) * Math.PI * 2;
          return <mesh key={i} position={[Math.sin(angle) * 0.0508, 0, Math.cos(angle) * 0.0508]} rotation={[0, angle, 0]}><boxGeometry args={[0.019, 0.025, 0.002]} /><meshStandardMaterial color={i % 2 ? "#e2c88a" : "#a88b4f"} metalness={0.9} roughness={0.24} /></mesh>;
        })
      : [0.009, -0.009].map(y => <mesh key={y} position={[0, y, 0]}><torusGeometry args={[0.0505, 0.0009, 3, 24]} /><meshStandardMaterial color="#c6b59a" roughness={0.9} /></mesh>)}
    {!luxury && <mesh position={[0, 0, -0.051]}><boxGeometry args={[0.024, 0.028, 0.004]} /><meshStandardMaterial color="#b9bec2" metalness={0.9} roughness={0.25} /></mesh>}
    {/* Case, lugs and polished bezel. */}
    <mesh position={[0, 0, 0.047]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[luxury ? 0.026 : 0.023, luxury ? 0.027 : 0.024, 0.013, 28]} /><meshStandardMaterial color={metal} roughness={0.18} metalness={0.95} /></mesh>
    {[-1, 1].map(y => <mesh key={`lug:${y}`} position={[0, y * 0.026, 0.044]}><boxGeometry args={[0.03, 0.01, 0.008]} /><meshStandardMaterial color={metal} metalness={0.95} roughness={0.2} /></mesh>)}
    <mesh position={[0, 0, 0.0545]}><torusGeometry args={[luxury ? 0.0225 : 0.0205, luxury ? 0.0035 : 0.002, 8, 28]} /><meshStandardMaterial color={luxury ? "#1b2a3a" : metal} roughness={0.18} metalness={luxury ? 0.5 : 0.95} /></mesh>
    {/* Printed dial with indices and hands, under a domed sapphire crystal. */}
    <mesh position={[0, 0, 0.0548]}><circleGeometry args={[0.0195, 28]} /><meshStandardMaterial map={dial} color={dial ? "#ffffff" : luxury ? "#13233a" : "#ece6d6"} roughness={0.3} /></mesh>
    <mesh position={[0, 0, 0.0552]} scale={[0.02, 0.02, 0.004]}><sphereGeometry args={[1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />{crystal}</mesh>
    {/* Knurled crown at 3 o'clock. */}
    <mesh position={[0.03, 0, 0.047]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.0042, 0.0042, 0.008, 10]} /><meshStandardMaterial color={metal} metalness={0.95} roughness={0.3} /></mesh>
  </group>;
}

export function Hand({ handRef, fingerRefs, skin, watch, thumbSide = 1, children }: {
  handRef: React.RefObject<Group | null>;
  fingerRefs: MutableRefObject<(Group | null)[]>;
  skin: string;
  watch?: WatchStyle;
  thumbSide?: number;
  children?: ReactNode;
}) {
  return <group ref={handRef}>
    <mesh castShadow position={[0, -0.018, 0]} scale={[0.75, 1, 0.45]}>
      <sphereGeometry args={[0.062, 10, 8]} />
      <meshStandardMaterial color={skin} roughness={0.85} />
    </mesh>
    {[-1.5, -0.5, 0.5, 1.5].map((finger, index) => <group key={finger}
      ref={(part) => { fingerRefs.current[index] = part; }}
      position={[finger * 0.019, -0.049 + Math.abs(finger) * 0.005, 0.008]}
      rotation={[0.08, 0, finger * -0.025]}>
      <mesh castShadow position={[0, -0.014, 0]}>
        <capsuleGeometry args={[0.0105, index === 1 || index === 2 ? 0.03 : 0.023, 3, 6]} />
        <meshStandardMaterial color={skin} roughness={0.83} />
      </mesh>
    </group>)}
    <group position={[thumbSide * 0.043, -0.019, 0.015]} rotation={[0.3, 0, thumbSide * -0.55]}>
      <mesh castShadow>
        <capsuleGeometry args={[0.014, 0.025, 3, 6]} /><meshStandardMaterial color={skin} roughness={0.83} />
      </mesh>
    </group>
    {watch && <Watch style={watch} />}
    {children}
  </group>;
}


/** Bag body in its own upright frame: origin at the base, handle on top. */
export function Bag({ style }: { style: AvatarBagStyle }) {
  const metal = <meshStandardMaterial color="#c9b27a" metalness={0.8} roughness={0.3} />;
  if (style === "briefcase") return <group>
    <mesh castShadow position={[0, 0.13, 0]}><boxGeometry args={[0.36, 0.26, 0.085]} /><meshStandardMaterial color="#4a3426" roughness={0.55} /></mesh>
    <mesh position={[0, 0.2, 0]}><boxGeometry args={[0.365, 0.006, 0.088]} /><meshStandardMaterial color="#2e2018" roughness={0.6} /></mesh>
    {[-0.08, 0.08].map(x => <mesh key={x} position={[x, 0.21, 0.045]}><boxGeometry args={[0.03, 0.022, 0.006]} />{metal}</mesh>)}
    <mesh position={[0, 0.275, 0]} rotation={[0, 0, 0]}><torusGeometry args={[0.045, 0.009, 6, 14, Math.PI]} /><meshStandardMaterial color="#2e2018" roughness={0.5} /></mesh>
  </group>;
  if (style === "messenger") return <group>
    <mesh castShadow position={[0, 0.12, 0]}><boxGeometry args={[0.32, 0.24, 0.08]} /><meshStandardMaterial color="#56604f" roughness={0.9} /></mesh>
    {/* Flap over the front with a buckle strap. */}
    <mesh position={[0, 0.17, 0.043]}><boxGeometry args={[0.325, 0.15, 0.008]} /><meshStandardMaterial color="#4a5344" roughness={0.9} /></mesh>
    <mesh position={[0, 0.11, 0.049]}><boxGeometry args={[0.03, 0.06, 0.004]} />{metal}</mesh>
    <mesh position={[0, 0.24, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[0.12, 0.012, 5, 18, Math.PI]} /><meshStandardMaterial color="#353a31" roughness={0.9} /></mesh>
  </group>;
  return <group>
    {/* Tote: tapered body with two shoulder straps. */}
    <mesh castShadow position={[0, 0.15, 0]} scale={[1, 1, 0.38]}><cylinderGeometry args={[0.21, 0.17, 0.3, 4, 1, false, Math.PI / 4]} /><meshStandardMaterial color="#b98c6a" roughness={0.7} /></mesh>
    {[-0.045, 0.045].map(z => <mesh key={z} position={[0, 0.3, z]}><torusGeometry args={[0.085, 0.008, 5, 16, Math.PI]} /><meshStandardMaterial color="#8a6448" roughness={0.65} /></mesh>)}
  </group>;
}

/** Ear jewellery placed at the lobes in head space (`radius` is the head radius). */
export function Earrings({ style, radius: r }: { style: "studs" | "hoops"; radius: number }) {
  const gold = <meshStandardMaterial color="#d8b86c" metalness={0.9} roughness={0.22} />;
  return <group>
    {[-1, 1].map(side => <group key={side} position={[side * r * 0.985, -r * 0.29, r * 0.01]}>
      {style === "studs"
        ? <mesh><sphereGeometry args={[r * 0.07, 10, 8]} />{gold}</mesh>
        : <mesh position={[0, -r * 0.13, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[r * 0.13, r * 0.022, 6, 18]} />{gold}</mesh>}
    </group>)}
  </group>;
}

export type HairFamily = "short-fade" | "textured-crop" | "slicked-back" | "side-part" | "undercut"
  | "bob" | "medium" | "long" | "wavy" | "curly" | "afro" | "ponytail" | "bun";

/** Maps authored and legacy free-form variant names onto geometry families. */
export function hairFamily(variant: string): HairFamily {
  const style = variant.toLowerCase();
  if (style.includes("afro")) return "afro";
  if (style.includes("slick")) return "slicked-back";
  if (style.includes("side-part") || style.includes("side part")) return "side-part";
  if (style.includes("undercut")) return "undercut";
  if (style.includes("crop") || style.includes("textured")) return "textured-crop";
  if (style.includes("fade")) return "short-fade";
  if (style.includes("ponytail") || style.includes("tied")) return "ponytail";
  if (style.includes("bun")) return "bun";
  if (style.includes("wav")) return "wavy";
  if (style.includes("curl") || style.includes("coily")) return "curly";
  if (style.includes("bob")) return "bob";
  if (style.includes("medium")) return "medium";
  if (style.includes("long")) return "long";
  return "short-fade";
}

export function HairStyle({ variant = "short", color, radius, skin }: { variant?: string; color: string; radius: number; skin: string }) {
  const family = hairFamily(variant);
  const r = radius;
  // Strand maps multiply the base color and drive bump so highlights break along locks.
  const coiled = family === "curly" || family === "afro";
  const strands = useMemo(() => hairStrandTexture(coiled ? "curly" : "vertical"), [coiled]);
  const mat = <meshPhysicalMaterial color={color} map={strands} bumpMap={strands} bumpScale={0.6} roughness={coiled ? 0.95 : 0.72} sheen={coiled ? 0.2 : 0.55} sheenRoughness={0.4} sheenColor="#ffffff" />;
  const sheen = <meshPhysicalMaterial color={color} map={strands} bumpMap={strands} bumpScale={0.4} roughness={0.38} clearcoat={0.35} clearcoatRoughness={0.45} sheen={0.7} sheenRoughness={0.3} sheenColor="#ffffff" />;
  const longer = family === "bob" || family === "medium" || family === "long" || family === "wavy";
  const cropped = family === "short-fade" || family === "textured-crop" || family === "undercut";
  const tied = family === "ponytail" || family === "bun";
  // Faded and undercut sides sit tighter to the scalp than the crown.
  const capScale: [number, number, number] = cropped ? [0.99, 0.97, 1.0] : family === "afro" ? [1.3, 1.25, 1.24] : family === "curly" ? [1.06, 1.12, 1.04] : [1.025, 1.01, 1.01];
  return <group>
    <mesh castShadow position={[0, r * 0.035, -r * 0.055]} scale={capScale}>
      <sphereGeometry args={[r, 22, 14, 0, Math.PI * 2, 0, Math.PI * (family === "afro" ? 0.6 : cropped ? 0.5 : 0.54)]} />
      {family === "slicked-back" ? sheen : mat}
    </mesh>
    {family === "afro" && <mesh castShadow position={[0, r * 0.32, -r * 0.12]} scale={[1.32, 1.08, 1.25]}>
      <sphereGeometry args={[r, 18, 12]} /><meshStandardMaterial color={color} roughness={1} />
    </mesh>}
    {/* Fade: a darker, tighter band above the ears reads as clipper work. */}
    {(family === "short-fade" || family === "undercut") && <mesh position={[0, r * 0.05, -r * 0.06]} scale={[1.005, 0.42, 1.0]}>
      <sphereGeometry args={[r, 20, 6, 0, Math.PI * 2, Math.PI * 0.44, Math.PI * 0.14]} />
      <meshStandardMaterial color={color} roughness={0.98} transparent opacity={0.55} />
    </mesh>}
    {family === "short-fade" && <mesh castShadow position={[0, r * 0.74, r * 0.36]} rotation={[0.55, 0, 0]} scale={[1, 0.3, 0.6]}>
      <capsuleGeometry args={[r * 0.2, r * 0.5, 4, 10]} />{mat}
    </mesh>}
    {family === "textured-crop" && <>
      {[-0.42, -0.14, 0.14, 0.42].flatMap((x, i) => [0.2, -0.15].map(z => <mesh key={`tex:${x}:${z}`} castShadow position={[x * r, r * (0.9 - Math.abs(x) * 0.25 + (i % 2) * 0.03), (z + 0.1) * r]}>
        <sphereGeometry args={[r * 0.2, 7, 5]} />{mat}
      </mesh>))}
      <mesh castShadow position={[0, r * 0.62, r * 0.7]} rotation={[0.9, 0, 0]} scale={[1.5, 0.3, 0.5]}><capsuleGeometry args={[r * 0.18, r * 0.3, 4, 8]} />{mat}</mesh>
    </>}
    {family === "slicked-back" && <>
      {/* Lifted front, combed lines running back over the crown. */}
      <mesh castShadow position={[0, r * 0.84, r * 0.36]} rotation={[-0.25, 0, 0]} scale={[1.6, 0.42, 0.9]}><capsuleGeometry args={[r * 0.2, r * 0.3, 4, 10]} />{sheen}</mesh>
      {[-0.36, -0.12, 0.12, 0.36].map(x => <mesh key={`comb:${x}`} position={[x * r, r * 0.86, -r * 0.12]} rotation={[Math.PI / 2 + 0.2, 0, 0]} scale={[1, 1, 0.5]}>
        <capsuleGeometry args={[r * 0.06, r * 0.8, 3, 6]} />{sheen}
      </mesh>)}
      <mesh castShadow position={[0, -r * 0.05, -r * 0.82]} scale={[0.9, 0.55, 0.35]}><sphereGeometry args={[r, 14, 10]} />{sheen}</mesh>
    </>}
    {family === "side-part" && <>
      <mesh castShadow position={[r * 0.14, r * 0.82, r * 0.34]} rotation={[0.25, 0, -0.42]} scale={[1.55, 0.4, 0.85]}><capsuleGeometry args={[r * 0.21, r * 0.42, 4, 10]} />{mat}</mesh>
      <mesh castShadow position={[-r * 0.52, r * 0.68, r * 0.18]} rotation={[0.2, 0, 0.35]} scale={[0.75, 0.38, 0.85]}><capsuleGeometry args={[r * 0.2, r * 0.34, 4, 10]} />{mat}</mesh>
      {/* Visible part line on the left crown. */}
      <mesh position={[-r * 0.3, r * 0.955, r * 0.02]} rotation={[Math.PI / 2 + 0.25, 0, 0.32]}><boxGeometry args={[r * 0.03, r * 0.9, r * 0.02]} /><meshStandardMaterial color={skin} roughness={0.9} /></mesh>
    </>}
    {family === "undercut" && <mesh castShadow position={[0, r * 0.86, r * 0.05]} rotation={[0.35, 0, 0]} scale={[0.82, 0.5, 1.2]}>
      <sphereGeometry args={[r * 0.72, 14, 10]} />{mat}
    </mesh>}
    {(longer || tied) && [-1, -0.33, 0.33, 1].filter(offset => Math.abs(offset) > 0.5 || !tied).slice(0, tied ? 2 : 3)
      .map(offset => <mesh key={`sweep:${offset}`} castShadow position={[offset * r * 0.28, r * (0.68 - offset * 0.055), r * 0.57]} rotation={[0.3, -0.14, -0.22]} scale={[1, 0.36, 0.65]}>
        <capsuleGeometry args={[r * 0.19, r * 0.37, 4, 10]} />{mat}
      </mesh>)}
    {(longer || family === "ponytail") && [-1, 1].map(side => <mesh key={`side:${side}`} castShadow position={[side * r * 0.85, -r * (family === "bob" ? 0.24 : 0.17), -r * 0.15]} rotation={[0.07, 0, side * -0.07]} scale={[0.8, 1, 1]}>
      <capsuleGeometry args={[r * 0.29, r * (family === "bob" ? 0.67 : family === "ponytail" ? 0.5 : family === "medium" ? 0.8 : 1.1), 5, 12]} />{mat}
    </mesh>)}
    {longer && <mesh castShadow position={[0, -r * (family === "long" || family === "wavy" ? 0.4 : 0.25), -r * 0.59]} scale={[1.03, family === "bob" ? 0.95 : family === "medium" ? 1.12 : 1.45, 0.42]}>
      <sphereGeometry args={[r, 18, 12]} />{mat}
    </mesh>}
    {family === "wavy" && [-1, 1].flatMap(side => [0, 1, 2].map(i => <mesh key={`wave:${side}:${i}`} castShadow position={[side * r * (0.9 + (i % 2) * 0.08), -r * (0.2 + i * 0.32), -r * 0.2]}>
      <sphereGeometry args={[r * 0.26, 8, 6]} />{mat}
    </mesh>))}
    {family === "ponytail" && <group position={[0, -r * 0.08, -r * 0.93]} rotation={[0.3, 0, 0]}>
      <mesh castShadow position={[0, -r * 0.43, 0]}><capsuleGeometry args={[r * 0.25, r * 0.83, 5, 12]} />{mat}</mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[r * 0.25, r * 0.047, 5, 12]} /><meshStandardMaterial color="#4a5965" roughness={0.82} /></mesh>
    </group>}
    {/* Bun: hair gathered high at the back of the crown, wrapped by a band. */}
    {family === "bun" && <group position={[0, r * 0.62, -r * 0.92]} rotation={[-0.7, 0, 0]}>
      <mesh castShadow position={[0, 0, -r * 0.08]} scale={[1, 0.9, 0.85]}><sphereGeometry args={[r * 0.42, 16, 12]} />{mat}</mesh>
      <mesh castShadow position={[0, 0, -r * 0.08]} rotation={[0, 0, 0.6]} scale={[1, 1, 0.8]}><torusGeometry args={[r * 0.3, r * 0.11, 8, 18]} />{mat}</mesh>
      <mesh position={[0, 0, r * 0.2]}><torusGeometry args={[r * 0.24, r * 0.04, 5, 14]} /><meshStandardMaterial color="#4a5965" roughness={0.82} /></mesh>
    </group>}
    {family === "curly" && [-1, -0.5, 0, 0.5, 1].map((offset, index) => <mesh key={`curl:${offset}`} castShadow position={[offset * r * 0.8, r * (0.85 - Math.abs(offset) * 0.2), r * (index % 2 ? 0.1 : 0.32)]}>
      <sphereGeometry args={[r * 0.36, 10, 8]} />{mat}
    </mesh>)}
    <HairLayers family={family} r={r} mat={mat} sheen={sheen} skin={skin} color={color} />
  </group>;
}

/**
 * Secondary hair layers: crown volume, temple tapers, fringe locks and flowing
 * strands. Kept separate so the base silhouette stays readable while these add
 * the sculpted, multi-layer look at normal isometric zoom.
 */
function HairLayers({ family, r, mat, sheen, skin, color }: { family: HairFamily; r: number; mat: ReactNode; sheen: ReactNode; skin: string; color: string }) {
  // Clipper shading is a darker shade of the chosen hair color, so light and gray hair fade naturally.
  const shade = useMemo(() => `#${new Color(color).multiplyScalar(0.45).getHexString()}`, [color]);
  const lock = (key: string, position: [number, number, number], rotation: [number, number, number], size: [number, number], material: ReactNode = mat, scale: [number, number, number] = [1, 0.45, 0.7]) =>
    <mesh key={key} castShadow position={position} rotation={rotation} scale={scale}>
      <capsuleGeometry args={[size[0] * r, size[1] * r, 4, 8]} />{material}
    </mesh>;
  // Temple taper: tight, slightly darker wedges above each ear for clipper-faded sides.
  const temples = (opacity: number) => [-1, 1].map(side => <mesh key={`temple:${side}`} position={[side * r * 0.9, r * 0.22, r * 0.05]} rotation={[0, 0, side * 0.12]} scale={[0.2, 0.42, 0.6]}>
    <sphereGeometry args={[r, 12, 8]} /><meshStandardMaterial color={shade} roughness={1} transparent opacity={opacity} depthWrite={false} />
  </mesh>);
  // Sideburns tie the hairline to the ears.
  const sideburns = [-1, 1].map(side => <mesh key={`burn:${side}`} position={[side * r * 0.9, -r * 0.02, r * 0.3]} scale={[0.07, 0.22, 0.1]}>
    <sphereGeometry args={[r, 8, 6]} />{mat}
  </mesh>);
  switch (family) {
    case "slicked-back":
      return <group>
        {/* Pompadour crown volume and seven combed ridges flowing to the nape. */}
        {lock("crown", [0, r * 0.98, r * 0.12], [-0.6, 0, 0], [0.32, 0.5], sheen, [1.4, 0.55, 1])}
        {[-0.54, -0.36, -0.18, 0, 0.18, 0.36, 0.54].map((x, i) => lock(`groove:${x}`, [x * r, r * (0.9 - Math.abs(x) * 0.3), -r * (0.2 + (i % 2) * 0.05)], [Math.PI / 2 + 0.35 + Math.abs(x) * 0.4, 0, x * 0.5], [0.075, 0.95], sheen, [1, 1, 0.55]))}
        {temples(0.45)}
        {sideburns}
      </group>;
    case "textured-crop":
      return <group>
        {/* Piece-y layered locks across the crown, each pointing a slightly different way. */}
        {Array.from({ length: 12 }, (_, i) => {
          const angle = (i / 12) * Math.PI * 2;
          const ring = i % 2 ? 0.32 : 0.52;
          return lock(`piece:${i}`, [Math.sin(angle) * ring * r, r * (0.94 - ring * 0.18), Math.cos(angle) * ring * r - r * 0.05], [0.4 + Math.cos(angle) * 0.4, angle * 0.2, Math.sin(angle) * 0.5], [0.13, 0.22]);
        })}
        {/* Forward fringe with depth: three staggered locks over the brow. */}
        {[-0.3, 0, 0.3].map((x, i) => lock(`fringe:${x}`, [x * r, r * (0.66 - i * 0.02), r * (0.78 - Math.abs(x) * 0.1)], [1.25, 0, x * -0.6], [0.11, 0.18]))}
        {temples(0.6)}
        {sideburns}
      </group>;
    case "side-part":
      return <group>
        {/* Sweep: four graduated locks arc away from the part over the brow. */}
        {[0, 1, 2, 3].map(i => lock(`sweep:${i}`, [r * (-0.15 + i * 0.22), r * (0.9 - i * 0.07), r * (0.42 - i * 0.04)], [0.35, 0, -0.55 - i * 0.12], [0.14, 0.45], mat, [1, 0.45, 0.8]))}
        {/* Short side under the part, tapered. */}
        {lock("short-side", [-r * 0.66, r * 0.62, r * 0.05], [0.15, 0, 0.55], [0.15, 0.55], mat, [0.6, 0.45, 1])}
        {/* Crisp part line highlight. */}
        <mesh position={[-r * 0.29, r * 0.96, r * 0.25]} rotation={[0.4, 0, 0.32]}><boxGeometry args={[r * 0.015, r * 0.008, r * 0.5]} /><meshStandardMaterial color={skin} roughness={0.9} /></mesh>
        {temples(0.4)}
        {sideburns}
      </group>;
    case "short-fade":
    case "undercut":
      return <group>
        {[-0.3, 0, 0.3].map(x => lock(`top:${x}`, [x * r, r * 0.93, r * 0.1], [0.6, 0, x * -0.5], [0.14, 0.35]))}
        {temples(family === "undercut" ? 0.75 : 0.6)}
        {sideburns}
      </group>;
    case "bob":
    case "medium":
    case "long":
    case "wavy": {
      const length = family === "bob" ? 0.75 : family === "medium" ? 1.0 : 1.4;
      return <group>
        {/* Curtain fringe and layered panels framing the face, each lock separately shaped. */}
        {[-1, 1].map(side => lock(`curtain:${side}`, [side * r * 0.38, r * 0.62, r * 0.78], [0.55, side * 0.2, side * 0.6], [0.13, 0.42]))}
        {[-1, 1].flatMap(side => [0, 1, 2].map(i => lock(`panel:${side}:${i}`, [side * r * (0.78 + i * 0.08), -r * (0.1 + i * 0.12), r * (0.35 - i * 0.28)], [0.08 + (family === "wavy" ? Math.sin(i * 2) * 0.2 : 0), 0, side * (-0.08 - i * 0.05)], [0.16, length * (0.9 - i * 0.1)], mat, [0.8, 1, 0.75]))) }
        {/* Back strands flowing down past the nape. */}
        {[-0.5, -0.17, 0.17, 0.5].map((x, i) => lock(`back:${x}`, [x * r, -r * (0.15 + length * 0.25), -r * (0.82 + (i % 2) * 0.04)], [-0.12, 0, x * 0.2], [0.17, length], mat, [1, 1, 0.6]))}
        {/* Crown sheen band where light catches the curve. */}
        <mesh position={[0, r * 0.82, r * 0.18]} rotation={[-0.3, 0, 0]} scale={[0.8, 0.12, 0.7]}><sphereGeometry args={[r, 16, 6]} />{sheen}</mesh>
      </group>;
    }
    case "ponytail":
    case "bun":
      return <group>
        {/* Swept-back hairline converging on the band. */}
        {[-0.5, -0.25, 0, 0.25, 0.5].map(x => lock(`pull:${x}`, [x * r, r * (0.8 - Math.abs(x) * 0.25), -r * 0.2], [Math.PI / 2 + 0.55, 0, x * 0.8], [0.08, 0.9], sheen, [1, 1, 0.5]))}
        {/* Tail strands splayed slightly below the tie. */}
        {family === "ponytail" && [-1, 0, 1].map(i => lock(`tail:${i}`, [i * r * 0.1, -r * 0.85, -r * (1.05 + Math.abs(i) * 0.02)], [0.25, 0, i * 0.12], [0.11, 0.75], mat, [1, 1, 1]))}
        {[-1, 1].map(side => lock(`wisp:${side}`, [side * r * 0.82, r * 0.05, r * 0.55], [0.1, 0, side * -0.15], [0.04, 0.35]))}
      </group>;
    case "curly":
    case "afro": {
      const count = family === "afro" ? 26 : 18;
      const spread = family === "afro" ? 1.22 : 1.02;
      return <group>
        {/* Fibonacci-distributed coils give a dense, contoured volume rather than one ball. */}
        {Array.from({ length: count }, (_, i) => {
          const y = 1 - (i / (count - 1)) * 1.1;
          const ring = Math.sqrt(Math.max(0, 1 - y * y));
          const angle = i * 2.39996;
          const z = Math.cos(angle) * ring;
          if (y < 0 && z > 0.35) return null;
          return <mesh key={`coil:${i}`} castShadow position={[Math.sin(angle) * ring * r * spread, (y * 0.9 + 0.25) * r * spread, (z * spread - 0.1) * r]}>
            <sphereGeometry args={[r * (family === "afro" ? 0.3 : 0.24), 9, 7]} />{mat}
          </mesh>;
        })}
        {/* Coiled fringe ringlets over the forehead. */}
        {[-0.4, 0, 0.4].map(x => <mesh key={`ringlet:${x}`} position={[x * r, r * 0.66, r * 0.82]} rotation={[0.3, 0, 0]}>
          <torusGeometry args={[r * 0.08, r * 0.035, 6, 10]} />{mat}
        </mesh>)}
      </group>;
    }
  }
}

export function Limb({
  pivot,
  upperLength,
  lowerLength,
  radius,
  upperColor,
  lowerColor,
  upperRef,
  lowerRef,
  upperTrim,
  lowerTrim,
  fabric = true,
  children
}: {
  pivot: [number, number, number];
  upperLength: number;
  lowerLength: number;
  radius: number;
  upperColor: string;
  lowerColor: string;
  upperRef: React.RefObject<Group | null>;
  lowerRef: React.RefObject<Group | null>;
  upperTrim?: ReactNode;
  lowerTrim?: ReactNode;
  fabric?: boolean;
  children?: ReactNode;
}) {
  return (
    <group ref={upperRef} position={pivot}>
      <mesh castShadow position={[0, -upperLength / 2, 0]}>
        <capsuleGeometry args={[radius, upperLength - radius * 2, 6, 10]} />
        <ClothMaterial color={upperColor} />
      </mesh>
      {upperTrim}
      <group ref={lowerRef} position={[0, -upperLength, 0]}>
        <mesh castShadow position={[0, -lowerLength / 2, 0]}>
          <capsuleGeometry args={[radius * 0.82, lowerLength - radius * 1.64, 6, 10]} />
          {fabric ? <ClothMaterial color={lowerColor} /> : <meshStandardMaterial color={lowerColor} roughness={0.84} />}
        </mesh>
        {lowerTrim}
        <group position={[0, -lowerLength, 0]}>{children}</group>
      </group>
    </group>
  );
}

