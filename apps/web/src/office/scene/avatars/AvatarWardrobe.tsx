import { useMemo } from "react";
import { Color, DataTexture, DoubleSide, RepeatWrapping, RGBAFormat, Shape, SRGBColorSpace, Vector2 } from "three";
import { humanoidInstanceSeed, type HumanoidProportions } from "./rig";
import type { AvatarOutfitStyle, AvatarVisualConfig } from "./appearance";

export interface ResolvedWardrobe {
  outfit: AvatarOutfitStyle;
  top: string;
  bottom: string;
  accent: string;
  jacket: string;
  /** Hardware and fine trims: buttons, watch-matching metal, piping. */
  trim: string;
  layer: "blazer" | "coat" | "vest" | "cardigan" | "none";
  sleeve: "long" | "rolled";
  shoes: string;
  shoeStyle: "formal" | "sneakers" | "boots";
  neckline: "collar" | "turtleneck" | "crew";
  lapel: "notch" | "peak" | "none";
  doubleBreasted: boolean;
  pocketSquare: boolean;
  tie: boolean;
  /** Fabric finish; luxe garments use a finer, slightly lower-roughness weave. */
  finish: "standard" | "luxe";
}

type OutfitPreset = Pick<ResolvedWardrobe, "layer" | "sleeve" | "shoeStyle" | "neckline" | "lapel" | "doubleBreasted" | "pocketSquare" | "tie" | "finish"> & {
  style: AvatarOutfitStyle;
  label: string;
  /** Signature colours; seeded palettes are used when a preset omits them. */
  palette?: { top: string; bottom: string; jacket: string; accent: string; trim: string };
};

export const AVATAR_OUTFIT_CATALOG: ReadonlyArray<OutfitPreset> = [
  { style: "ceo", label: "CEO double-breasted", layer: "blazer", sleeve: "long", shoeStyle: "formal", neckline: "collar", lapel: "peak", doubleBreasted: true, pocketSquare: true, tie: true, finish: "luxe",
    palette: { top: "#f3f0e8", bottom: "#1d2230", jacket: "#1d2230", accent: "#7c1f2c", trim: "#c8a45e" } },
  { style: "architect", label: "Architect minimalist coat", layer: "coat", sleeve: "long", shoeStyle: "boots", neckline: "turtleneck", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: false, finish: "luxe",
    palette: { top: "#1b1b1e", bottom: "#2c2d31", jacket: "#3a3936", accent: "#b9b1a4", trim: "#9a9ea3" } },
  { style: "executive", label: "Executive tailoring", layer: "blazer", sleeve: "long", shoeStyle: "formal", neckline: "collar", lapel: "notch", doubleBreasted: false, pocketSquare: false, tie: true, finish: "standard" },
  { style: "business-casual", label: "Business casual", layer: "none", sleeve: "rolled", shoeStyle: "formal", neckline: "collar", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: false, finish: "standard" },
  { style: "creative", label: "Creative studio", layer: "cardigan", sleeve: "long", shoeStyle: "boots", neckline: "collar", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: false, finish: "standard" },
  { style: "technical", label: "Technical team", layer: "vest", sleeve: "rolled", shoeStyle: "sneakers", neckline: "collar", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: false, finish: "standard" },
  { style: "service", label: "Hospitality service", layer: "vest", sleeve: "long", shoeStyle: "formal", neckline: "collar", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: true, finish: "standard" },
  { style: "source-outfit", label: "Original model outfit", layer: "blazer", sleeve: "long", shoeStyle: "formal", neckline: "collar", lapel: "notch", doubleBreasted: false, pocketSquare: false, tie: true, finish: "standard" },
  { style: "casual", label: "Everyday casual", layer: "none", sleeve: "rolled", shoeStyle: "sneakers", neckline: "crew", lapel: "none", doubleBreasted: false, pocketSquare: false, tie: false, finish: "standard" }
];

/** Unconfigured avatars rotate through everyday presets; signature looks are opt-in. */
const SEEDED_OUTFITS: readonly AvatarOutfitStyle[] = ["executive", "business-casual", "creative", "technical", "service", "casual"];

const PALETTES = [
  { top: "#e5e2d9", bottom: "#303a45", jacket: "#394d5b", accent: "#be9967" },
  { top: "#c5d2cf", bottom: "#3b443b", jacket: "#526250", accent: "#d4b779" },
  { top: "#e8d0bf", bottom: "#463c3b", jacket: "#80635d", accent: "#d3a281" },
  { top: "#c3cedc", bottom: "#303947", jacket: "#3f5676", accent: "#a9bfd2" },
  { top: "#ddd1df", bottom: "#413e4a", jacket: "#6e657f", accent: "#d6af89" }
];

/** A garment swap never participates in the rig seed, identity, or collision size. */
export function resolveWardrobe(visual: AvatarVisualConfig, seed: number): ResolvedWardrobe {
  // A person keeps the same palette in portraits, the studio and new assignments.
  seed = humanoidInstanceSeed(visual.identityId);
  const clothing = visual.clothing;
  const legacyLayer = clothing?.outerwear?.toLowerCase();
  const outfit = clothing?.style ?? (legacyLayer?.includes("executive") ? "executive" : SEEDED_OUTFITS[seed % SEEDED_OUTFITS.length] ?? "business-casual");
  // Procedural/portrait fallbacks use the existing executive cut for source garments.
  const preset = AVATAR_OUTFIT_CATALOG.find(item => item.style === (outfit === "source-outfit" ? "executive" : outfit)) ?? AVATAR_OUTFIT_CATALOG[0]!;
  const seeded = PALETTES[seed % PALETTES.length]!;
  const palette = preset.palette ?? { ...seeded, trim: "#b9b3a6" };
  const layer = legacyLayer === "none" ? "none" : legacyLayer?.includes("vest") ? "vest"
    : legacyLayer?.includes("cardigan") ? "cardigan" : legacyLayer?.includes("coat") ? "coat"
    : legacyLayer && !legacyLayer.startsWith("#") ? "blazer" : preset.layer;
  const shoeStyle = clothing?.shoes === "formal" || clothing?.shoes === "boots" || clothing?.shoes === "sneakers"
    ? clothing.shoes : preset.shoeStyle;
  const tailored = layer === "blazer";
  return {
    outfit,
    top: clothing?.top ?? palette.top,
    bottom: clothing?.bottom ?? palette.bottom,
    accent: clothing?.accent ?? palette.accent,
    jacket: clothing?.outerwear?.startsWith("#") ? clothing.outerwear : palette.jacket,
    trim: palette.trim,
    layer,
    sleeve: preset.sleeve,
    shoes: clothing?.shoes?.startsWith("#") ? clothing.shoes
      : shoeStyle === "formal" ? (preset.finish === "luxe" ? "#1c1714" : "#322c29") : shoeStyle === "boots" ? (preset.finish === "luxe" ? "#2a2421" : "#574236") : "#e0dfd9",
    shoeStyle,
    neckline: preset.neckline,
    // Lapels and double-breasting only exist on tailored outerwear.
    lapel: tailored ? (preset.lapel === "none" ? "notch" : preset.lapel) : "none",
    doubleBreasted: tailored && preset.doubleBreasted,
    pocketSquare: tailored && preset.pocketSquare,
    tie: preset.tie && preset.neckline === "collar",
    finish: preset.finish
  };
}

/** Full office garment set, including trousers, to prevent doubled source outfits. */
export const OFFICE_WARDROBE_MESHES = new Set(["ShirtLong", "ShirtRolled", "Blazer", "Coat", "Vest", "Cardigan", "Collar", "Turtleneck", "LapelNotch", "LapelPeak", "Tie", "PocketSquare", "Trousers", "ShoesFormal", "ShoesBoots", "ShoesSneakers", "ButtonsSingle", "ButtonsDouble"]);
export const SOURCE_WARDROBE_MESHES = new Set(["SourceTop", "SourceOuter", "SourceBottom", "SourceShoes"]);

/** Source garments replace every standard garment; missing source cuts fall back safely. */
export function officeGarmentVisibility(wardrobe: ResolvedWardrobe, sourceOutfitAvailable: boolean): Set<string> {
  if (wardrobe.outfit === "source-outfit" && sourceOutfitAvailable) return new Set(SOURCE_WARDROBE_MESHES);
  return new Set([
    "Trousers",
    wardrobe.sleeve === "rolled" ? "ShirtRolled" : "ShirtLong",
    wardrobe.layer === "blazer" ? "Blazer" : wardrobe.layer === "coat" ? "Coat" : wardrobe.layer === "vest" ? "Vest" : wardrobe.layer === "cardigan" ? "Cardigan" : "",
    wardrobe.neckline === "collar" ? "Collar" : wardrobe.neckline === "turtleneck" ? "Turtleneck" : "",
    wardrobe.lapel === "peak" ? "LapelPeak" : wardrobe.lapel === "notch" ? "LapelNotch" : "",
    wardrobe.tie ? "Tie" : "",
    wardrobe.layer === "blazer" || wardrobe.layer === "coat" ? wardrobe.doubleBreasted ? "ButtonsDouble" : "ButtonsSingle" : "",
    wardrobe.pocketSquare ? "PocketSquare" : "",
    wardrobe.shoeStyle === "formal" ? "ShoesFormal" : wardrobe.shoeStyle === "boots" ? "ShoesBoots" : "ShoesSneakers"
  ].filter(Boolean));
}

// Shared, deterministic fabric texture: no downloads, browser canvas, or per-avatar allocation.
const fabricSize = 32;
const fabricPixels = new Uint8Array(fabricSize * fabricSize * 4);
for (let y = 0; y < fabricSize; y++) for (let x = 0; x < fabricSize; x++) {
  const index = (y * fabricSize + x) * 4;
  const shade = 240 + ((x % 2 === 0 ? 5 : 0) + (y % 2 === 0 ? 6 : 0));
  fabricPixels.set([shade, shade, shade, 255], index);
}
const fabricTexture = new DataTexture(fabricPixels, fabricSize, fabricSize, RGBAFormat);
fabricTexture.wrapS = fabricTexture.wrapT = RepeatWrapping;
fabricTexture.repeat.set(5, 5);
fabricTexture.colorSpace = SRGBColorSpace;
fabricTexture.needsUpdate = true;

export function ClothMaterial({ color, finish = "standard" }: { color: string; finish?: ResolvedWardrobe["finish"] }) {
  return <meshStandardMaterial color={color} map={fabricTexture} roughness={finish === "luxe" ? 0.74 : 0.92} envMapIntensity={finish === "luxe" ? 1.15 : 1} />;
}

function Panel({ points, color, finish = "standard" }: { points: number[][]; color: string; finish?: ResolvedWardrobe["finish"] }) {
  const shape = useMemo(() => new Shape(points.map(([x, y]) => new Vector2(x, y))), [points]);
  return <mesh castShadow><shapeGeometry args={[shape]} /><meshStandardMaterial color={color} map={fabricTexture} roughness={finish === "luxe" ? 0.68 : 0.87} side={DoubleSide} /></mesh>;
}

// Lapel outlines in torso space (x outward, y up); mirrored per side.
const NOTCH_LAPEL = [[0.055, 0.605], [0.122, 0.56], [0.097, 0.49], [0.133, 0.455], [0.025, 0.25], [0.052, 0.5]];
const PEAK_LAPEL = [[0.055, 0.605], [0.118, 0.565], [0.104, 0.51], [0.158, 0.49], [0.026, 0.25], [0.052, 0.5]];

export function GarmentTorso({ proportions: p, wardrobe: w, skin }: {
  proportions: HumanoidProportions; wardrobe: ResolvedWardrobe; skin: string;
}) {
  const profile = useMemo(() => ([
    [0, -0.035], [0.15, -0.035], [0.172, 0.035], [0.155, 0.14],
    [0.178, 0.31], [0.199, 0.45], [0.205, 0.52], [0.165, 0.59], [0.073, 0.65], [0, 0.65]
  ] as const).map(([r, y]) => new Vector2(r * p.shoulderWidth / 0.45, y * p.shoulderHeight / 0.59)), [p]);
  // A structured coat continues past the hips to mid-thigh with a slight A-line flare.
  const coatProfile = useMemo(() => ([
    [0.178, -0.24], [0.17, -0.1], [0.165, 0.035], [0.16, 0.14],
    [0.182, 0.31], [0.203, 0.45], [0.209, 0.52], [0.168, 0.59], [0.078, 0.655], [0.06, 0.66]
  ] as const).map(([r, y]) => new Vector2(r * p.shoulderWidth / 0.45, y * p.shoulderHeight / 0.59)), [p]);
  const neckY = p.headHeight - p.headRadius - 0.045;
  return <group>
    <mesh castShadow scale={[1, 1, 0.7]}>
      <latheGeometry args={[profile, 20]} />
      <ClothMaterial color={w.top} finish={w.finish} />
    </mesh>
    {w.neckline === "turtleneck" ? <group position={[0, neckY, 0]}>
      <mesh castShadow><cylinderGeometry args={[0.074, 0.084, 0.12, 14]} /><ClothMaterial color={w.top} finish={w.finish} /></mesh>
      {[-0.035, 0, 0.035].map(y => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.078, 0.005, 5, 18]} /><ClothMaterial color={w.top} finish={w.finish} />
      </mesh>)}
    </group> : <mesh castShadow position={[0, neckY, 0]}>
      <cylinderGeometry args={[0.065, 0.078, 0.12, 12]} /><meshStandardMaterial color={skin} roughness={0.82} />
    </mesh>}
    {w.layer === "coat" ? <mesh castShadow scale={[1.04, 1, 0.75]} rotation={[0, 0.3, 0]}>
      <latheGeometry args={[coatProfile, 22, 0, Math.PI * 2 - 0.6]} />
      <ClothMaterial color={w.jacket} finish={w.finish} />
    </mesh> : w.layer !== "none" && <mesh castShadow scale={[1.035, w.layer === "vest" ? 0.89 : 1, 0.73]} rotation={[0, w.doubleBreasted ? 0.22 : 0.36, 0]}>
      <latheGeometry args={[profile, 20, 0, Math.PI * 2 - (w.doubleBreasted ? 0.44 : 0.72)]} />
      <ClothMaterial color={w.jacket} finish={w.finish} />
    </mesh>}
  </group>;
}

/** High-frequency trims can be culled together at office overview distances. */
export function GarmentDetails({ proportions: p, wardrobe: w, badge }: {
  proportions: HumanoidProportions; wardrobe: ResolvedWardrobe; badge?: boolean;
}) {
  const shade = useMemo(() => new Color(w.jacket).multiplyScalar(w.finish === "luxe" ? 1.28 : 1.16), [w.jacket, w.finish]);
  const h = p.shoulderHeight / 0.59;
  const lapelColor = `#${shade.getHexString()}`;
  const metal = { color: w.trim, metalness: 0.78, roughness: 0.28 } as const;
  return <group scale={[p.shoulderWidth / 0.45, h, 1]}>
    {w.neckline === "collar" && <group>
    <mesh position={[0, 0.315, 0.128]}><boxGeometry args={[0.015, 0.43, 0.012]} /><ClothMaterial color={w.top} /></mesh>
    {[0.18, 0.28, 0.38, 0.48].map(y => <mesh key={y} position={[0, y, 0.139]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.007, 0.007, 0.008, 8]} /><meshStandardMaterial color="#eae6df" roughness={0.52} />
    </mesh>)}
    {[-1, 1].map(side => <group key={`collar:${side}`} position={[side * 0.005, 0.57, 0.127]} rotation={[-0.3, 0, 0]} scale={[side, 1, 1]}>
      <Panel points={[[0.01, 0.055], [0.065, 0.065], [0.12, -0.01], [0.052, -0.06]]} color={w.top} />
    </group>)}
    </group>}
    {w.neckline === "crew" && <mesh position={[0, 0.63, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 0.7, 1]}><torusGeometry args={[0.08, 0.012, 6, 16]} /><ClothMaterial color={w.accent} /></mesh>}
    {w.layer === "cardigan" && <mesh position={[0, 0.005, 0]} scale={[1.03, 1, 0.74]} rotation={[0, 0.36, 0]}><cylinderGeometry args={[0.162, 0.169, 0.045, 20, 1, true, 0, Math.PI * 2 - 0.72]} /><ClothMaterial color={w.jacket} /></mesh>}
    {w.lapel !== "none" && [-1, 1].map(side => <group key={`lapel:${side}`} position={[0, 0, 0.145]} scale={[side, 1, 1]}>
      <Panel points={w.lapel === "peak" ? PEAK_LAPEL : NOTCH_LAPEL} color={lapelColor} finish={w.finish} />
    </group>)}
    {/* Architect coat: clean stand collar, concealed placket and a single trim line. */}
    {w.layer === "coat" && <group>
      {[-1, 1].map(side => <group key={`stand:${side}`} position={[0, 0.585, 0.122]} rotation={[-0.18, 0, 0]} scale={[side, 1, 1]}>
        <Panel points={[[0.04, 0.05], [0.115, 0.03], [0.12, -0.03], [0.05, -0.012]]} color={lapelColor} finish={w.finish} />
      </group>)}
      <mesh position={[0.03, 0.2, 0.152]}><boxGeometry args={[0.012, 0.74, 0.006]} /><ClothMaterial color={lapelColor} finish={w.finish} /></mesh>
      {[0.42, 0.24, 0.06].map(y => <mesh key={y} position={[0.03, y, 0.157]}><boxGeometry args={[0.014, 0.004, 0.004]} /><meshStandardMaterial {...metal} /></mesh>)}
    </group>}
    {w.tie && <group position={[0, 0, 0.142]}>
      <Panel points={[[0, 0.553], [0.024, 0.512], [0.016, 0.322], [0, 0.3], [-0.016, 0.322], [-0.024, 0.512]]} color={w.accent} finish={w.finish} />
      {w.finish === "luxe" && <mesh position={[0, 0.43, 0.004]}><boxGeometry args={[0.036, 0.005, 0.004]} /><meshStandardMaterial {...metal} /></mesh>}
    </group>}
    {/* Double-breasted 6x2 button stance. */}
    {w.doubleBreasted && [0.22, 0.31].flatMap(y => [-0.045, 0.045].map(x => <mesh key={`db:${x}:${y}`} position={[x, y, 0.152]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.009, 0.009, 0.006, 10]} /><meshStandardMaterial {...metal} />
    </mesh>))}
    {w.layer === "blazer" && !w.doubleBreasted && <mesh position={[0.02, 0.25, 0.15]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.008, 0.008, 0.006, 10]} /><meshStandardMaterial color="#2c2622" roughness={0.4} />
    </mesh>}
    {(w.layer === "blazer" || w.layer === "vest" || w.layer === "coat") && <group position={[0.118, 0.37, 0.124]} rotation={[0, 0.25, -0.03]}>
      {w.pocketSquare
        ? <group position={[0, 0.03, 0.002]}>
          <Panel points={[[-0.02, 0], [-0.012, 0.03], [-0.002, 0.016], [0.008, 0.034], [0.02, 0]]} color="#f4f1ea" finish="luxe" />
        </group>
        : <mesh position={[0, 0.03, 0]}><boxGeometry args={[0.041, 0.035, 0.008]} /><ClothMaterial color={w.accent} /></mesh>}
      <mesh><boxGeometry args={[0.064, 0.015, 0.012]} /><ClothMaterial color={w.jacket} finish={w.finish} /></mesh>
    </group>}
    {badge && <group position={[-0.11, 0.377, 0.137]} rotation={[0, -0.2, 0.025]}>
      <mesh position={[0, 0.042, 0]}><boxGeometry args={[0.013, 0.025, 0.008]} /><meshStandardMaterial color="#aeb4b5" metalness={0.65} roughness={0.3} /></mesh>
      <mesh><boxGeometry args={[0.062, 0.075, 0.009]} /><meshStandardMaterial color="#e6e8e2" roughness={0.62} /></mesh>
      <mesh position={[-0.011, 0.008, 0.006]}><boxGeometry args={[0.018, 0.028, 0.003]} /><meshStandardMaterial color={w.accent} /></mesh>
      <mesh position={[0.009, -0.016, 0.006]}><boxGeometry args={[0.029, 0.005, 0.003]} /><meshStandardMaterial color="#61727b" /></mesh>
    </group>}
    {w.layer !== "coat" && <>
      <mesh position={[0, 0.018, 0]} scale={[1, 1, 0.73]}>
        <cylinderGeometry args={[0.168, 0.168, 0.024, 20, 1, true]} /><meshStandardMaterial color={w.finish === "luxe" ? "#1f1a17" : "#3d342f"} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.018, 0.126]}><boxGeometry args={[0.038, 0.03, 0.009]} /><meshStandardMaterial color={w.finish === "luxe" ? w.trim : w.accent} metalness={0.65} roughness={0.35} /></mesh>
    </>}
  </group>;
}

export function SleeveCuff({ length, radius, color, rolled }: { length: number; radius: number; color: string; rolled: boolean }) {
  return <mesh castShadow position={[0, -length + (rolled ? 0.025 : 0.014), 0]}>
    <cylinderGeometry args={[radius * 0.87, radius * 0.88, rolled ? 0.045 : 0.025, 12]} /><ClothMaterial color={color} />
  </mesh>;
}

export function DetailedShoe({ wardrobe: w }: { wardrobe: ResolvedWardrobe }) {
  return <group>
    <mesh castShadow position={[0, 0.028, 0.033]} scale={[0.82, 0.18, 1.46]}>
      <sphereGeometry args={[0.09, 14, 10]} /><meshStandardMaterial color={w.shoeStyle === "sneakers" ? "#f1eee6" : "#272a2b"} roughness={0.78} />
    </mesh>
    <mesh castShadow position={[0, 0.05, 0.03]} scale={[0.79, 0.4, 1.43]}>
      <sphereGeometry args={[0.09, 14, 10]} /><meshStandardMaterial color={w.shoes} roughness={w.shoeStyle === "formal" ? 0.44 : 0.8} />
    </mesh>
    {w.shoeStyle === "formal" && w.finish === "luxe" && <mesh position={[0, 0.056, 0.098]} scale={[0.7, 0.32, 0.5]}>
      <sphereGeometry args={[0.09, 14, 10]} /><meshStandardMaterial color={w.shoes} roughness={0.18} metalness={0.15} />
    </mesh>}
    {w.shoeStyle === "boots" && <mesh castShadow position={[0, 0.085, -0.026]}>
      <cylinderGeometry args={[0.051, 0.059, 0.09, 12]} /><meshStandardMaterial color={w.shoes} roughness={0.64} />
    </mesh>}
    {[0.012, 0.036, 0.06].map(z => <mesh key={z} position={[0, 0.086 - Math.abs(z - 0.025) * 0.16, z]} rotation={[0, 0.12, 0]}>
      <boxGeometry args={[0.05, 0.004, 0.004]} /><meshStandardMaterial color={w.shoeStyle === "sneakers" ? "#faf5ec" : "#5d5148"} roughness={0.85} />
    </mesh>)}
  </group>;
}
