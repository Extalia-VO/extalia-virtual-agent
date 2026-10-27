import { useMemo, type RefObject } from "react";
import { Color, DataTexture, DoubleSide, RepeatWrapping, RGBAFormat, Shape, SRGBColorSpace, Vector2, type Group } from "three";
import { HUMANOID_LEG_RADIUS, type HumanoidProportions } from "./rig";
import type { ResolvedWardrobe } from "./wardrobe";

export { AVATAR_OUTFIT_CATALOG, resolveWardrobe, type ResolvedWardrobe } from "./wardrobe";

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

/**
 * Torso radius multiplier at an authored height: shoulders above the ribs, hips
 * below the waist, blended between, with a narrower waist for fitted cuts.
 */
export function torsoWidthScale(p: HumanoidProportions, y: number, fitted: boolean): number {
  const shoulders = p.shoulderWidth / 0.45, hips = p.hipWidth / 0.21;
  const hipWeight = y <= 0.035 ? 1 : y >= 0.31 ? 0 : (0.31 - y) / 0.275;
  const waist = fitted && y > 0.08 && y < 0.36 ? 0.94 : 1;
  return (shoulders + (hips - shoulders) * hipWeight) * waist;
}

export function GarmentTorso({ proportions: p, wardrobe: w, skin, seated = false }: {
  proportions: HumanoidProportions; wardrobe: ResolvedWardrobe; skin: string; seated?: boolean;
}) {
  const profile = useMemo(() => ([
    [0, -0.035], [0.15, -0.035], [0.172, 0.035], [0.155, 0.14],
    [0.178, 0.31], [0.199, 0.45], [0.205, 0.52], [0.165, 0.59], [0.073, 0.65], [0, 0.65]
  ] as const).map(([r, y]) => new Vector2(r * torsoWidthScale(p, y, w.fitted), y * p.shoulderHeight / 0.59)), [p, w.fitted]);
  // A structured coat continues past the hips to mid-thigh with a slight A-line flare;
  // seated, its skirt folds onto the lap at the seat instead of passing through the cushion.
  const coatProfile = useMemo(() => ([
    ...(seated ? [[0.186, -0.04], [0.178, 0]] as const : [[0.178, -0.24], [0.17, -0.1]] as const),
    [0.165, 0.035], [0.16, 0.14],
    [0.182, 0.31], [0.203, 0.45], [0.209, 0.52], [0.168, 0.59], [0.078, 0.655], [0.06, 0.66]
  ] as const).map(([r, y]) => new Vector2(r * torsoWidthScale(p, y, w.fitted), y * p.shoulderHeight / 0.59)), [p, w.fitted, seated]);
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
    {/* Openings are cut with phiStart: rotating a non-uniformly scaled mesh would turn its
        ellipse against the torso's and let the shirt show through at the back. */}
    {w.layer === "coat" ? <mesh castShadow scale={[1.04, 1, 0.75]}>
      <latheGeometry args={[coatProfile, 22, 0.3, Math.PI * 2 - 0.6]} />
      <ClothMaterial color={w.jacket} finish={w.finish} />
    </mesh> : w.layer !== "none" && <mesh castShadow scale={[1.035, w.layer === "vest" ? 0.89 : 1, 0.73]}>
      <latheGeometry args={[profile, 20, w.doubleBreasted ? 0.22 : 0.36, Math.PI * 2 - (w.doubleBreasted ? 0.44 : 0.72)]} />
      <ClothMaterial color={w.jacket} finish={w.finish} />
    </mesh>}
  </group>;
}

/** High-frequency trims can be culled together at office overview distances. */
export function GarmentDetails({ proportions: p, wardrobe: w, badge, skin, seated = false }: {
  proportions: HumanoidProportions; wardrobe: ResolvedWardrobe; badge?: boolean; skin: string; seated?: boolean;
}) {
  const shade = useMemo(() => new Color(w.jacket).multiplyScalar(w.finish === "luxe" ? 1.28 : 1.16), [w.jacket, w.finish]);
  const h = p.shoulderHeight / 0.59;
  const lapelColor = `#${shade.getHexString()}`;
  const metal = { color: w.trim, metalness: 0.78, roughness: 0.28 } as const;
  const shoulders = p.shoulderWidth / 0.45;
  // Waist trims follow the hips, which may be wider or narrower than the shoulders.
  const hips = torsoWidthScale(p, 0.018, false) / shoulders;
  return <group scale={[shoulders, h, shoulders]}>
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
    {/* Scoop neckline: skin surfaces through the bodice, so its edge follows the chest curve. */}
    {w.neckline === "scoop" && <mesh position={[0, 0.6, 0.058]} scale={[0.088, 0.1, 0.073]}>
      <sphereGeometry args={[1, 18, 14]} /><meshStandardMaterial color={skin} roughness={0.8} />
    </mesh>}
    {w.layer === "cardigan" && <mesh position={[0, 0.005, 0]} scale={[hips * 1.03, 1, 0.74 * hips]}><cylinderGeometry args={[0.162, 0.169, 0.045, 20, 1, true, 0.36, Math.PI * 2 - 0.72]} /><ClothMaterial color={w.jacket} /></mesh>}
    {w.lapel !== "none" && [-1, 1].map(side => <group key={`lapel:${side}`} position={[0, 0, 0.145]} scale={[side, 1, 1]}>
      <Panel points={w.lapel === "peak" ? PEAK_LAPEL : NOTCH_LAPEL} color={lapelColor} finish={w.finish} />
    </group>)}
    {/* Architect coat: clean stand collar, concealed placket and a single trim line. */}
    {w.layer === "coat" && <group>
      {[-1, 1].map(side => <group key={`stand:${side}`} position={[0, 0.585, 0.122]} rotation={[-0.18, 0, 0]} scale={[side, 1, 1]}>
        <Panel points={[[0.04, 0.05], [0.115, 0.03], [0.12, -0.03], [0.05, -0.012]]} color={lapelColor} finish={w.finish} />
      </group>)}
      {/* The placket ends at the hem: mid-thigh standing, the lap when seated. */}
      <mesh position={[0.03, seated ? 0.285 : 0.2, 0.152]}><boxGeometry args={[0.012, seated ? 0.57 : 0.74, 0.006]} /><ClothMaterial color={lapelColor} finish={w.finish} /></mesh>
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
    {w.layer !== "coat" && w.bottomCut !== "dress" && <>
      <mesh position={[0, 0.018, 0]} scale={[hips, 1, 0.73 * hips]}>
        <cylinderGeometry args={[0.168, 0.168, 0.024, 20, 1, true]} /><meshStandardMaterial color={w.finish === "luxe" ? "#1f1a17" : "#3d342f"} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.018, 0.126 * hips]}><boxGeometry args={[0.038, 0.03, 0.009]} /><meshStandardMaterial color={w.finish === "luxe" ? w.trim : w.accent} metalness={0.65} roughness={0.35} /></mesh>
    </>}
  </group>;
}

/** Trouser-leg radius the skirt must clear around each thigh. */
const LEG_RADIUS = HUMANOID_LEG_RADIUS;
const skirtHalfWidth = (p: HumanoidProportions) => p.hipWidth / 2 + LEG_RADIUS + 0.018;

/** Skirt or dress waist yoke: stays with the torso and covers the hip joint in every pose. */
export function SkirtYoke({ proportions: p, wardrobe: w }: { proportions: HumanoidProportions; wardrobe: ResolvedWardrobe }) {
  const hips = torsoWidthScale(p, 0, false);
  return <mesh castShadow position={[0, -0.012, 0]} scale={[1, 1, 0.7]}>
    <cylinderGeometry args={[0.16 * hips, Math.max(skirtHalfWidth(p), 0.172 * hips), 0.075, 20, 1, true]} />
    <ClothMaterial color={w.bottom} finish={w.finish} />
  </mesh>;
}

/**
 * Skirt or dress drape. It hangs from the hip pivot and `drapeRef` turns it with
 * the thighs, so in the 45 cm seated pose it lies over the lap instead of
 * passing through the seat; standing, it falls to just above the knee.
 */
export function SkirtDrape({ proportions: p, wardrobe: w, drapeRef }: {
  proportions: HumanoidProportions; wardrobe: ResolvedWardrobe; drapeRef: RefObject<Group | null>;
}) {
  const half = skirtHalfWidth(p);
  const length = p.thighLength * (w.bottomCut === "dress" ? 0.96 : 0.9);
  // Elliptical section: full width across both legs, just deeper than one leg front to back.
  const depth = (LEG_RADIUS + 0.022) / half;
  const profile = useMemo(() => ([
    [0.92, 0.02], [1, -0.03], [1.035, -0.5 * length], [1.1, -length], [1.06, -length - 0.012]
  ] as const).map(([r, y]) => new Vector2(r * half, y)), [half, length]);
  return <group ref={drapeRef} position={[0, p.standingHipHeight, 0]}>
    <mesh castShadow scale={[1, 1, depth]}>
      <latheGeometry args={[profile, 22]} />
      <meshStandardMaterial color={w.bottom} map={fabricTexture} roughness={w.finish === "luxe" ? 0.74 : 0.92} side={DoubleSide} />
    </mesh>
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
