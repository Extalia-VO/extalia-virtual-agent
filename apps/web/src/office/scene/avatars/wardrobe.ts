/** Renderer-independent wardrobe resolution, shared by the 3D character and 2D portraits (no three.js). */
import type { CharacterBottom, CharacterTop } from "@extalia/core";
import { humanoidInstanceSeed } from "./rig";
import { SEEDED_OUTFITS, type AvatarOutfitStyle, type AvatarVisualConfig } from "./appearance";

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
  topCut: CharacterTop;
  /** Skirts and dresses drape over the thighs when seated; the shins show below the hem. */
  bottomCut: CharacterBottom;
  /** Blouses and dresses take a narrower waist. */
  fitted: boolean;
  neckline: "collar" | "turtleneck" | "crew" | "scoop";
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

const TOP_NECKLINES: Readonly<Record<CharacterTop, ResolvedWardrobe["neckline"]>> = { shirt: "collar", blouse: "scoop", knit: "crew", turtleneck: "turtleneck" };
const NECKLINE_TOPS: Readonly<Record<OutfitPreset["neckline"], CharacterTop>> = { collar: "shirt", scoop: "blouse", crew: "knit", turtleneck: "turtleneck" };

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
  const topCut = clothing?.topCut ?? NECKLINE_TOPS[preset.neckline];
  const bottomCut = clothing?.bottomCut ?? "trousers";
  const dress = bottomCut === "dress";
  // A dress is one garment: the bodice and the skirt share its color.
  const dressColor = clothing?.bottom ?? palette.jacket;
  const neckline = TOP_NECKLINES[topCut];
  return {
    outfit,
    top: dress ? dressColor : clothing?.top ?? palette.top,
    bottom: dress ? dressColor : clothing?.bottom ?? palette.bottom,
    accent: clothing?.accent ?? palette.accent,
    jacket: clothing?.outerwear?.startsWith("#") ? clothing.outerwear : dress && dressColor === palette.jacket ? palette.bottom : palette.jacket,
    trim: palette.trim,
    layer,
    sleeve: dress && layer === "none" ? "rolled" : preset.sleeve,
    shoes: clothing?.shoes?.startsWith("#") ? clothing.shoes
      : shoeStyle === "formal" ? (preset.finish === "luxe" ? "#1c1714" : "#322c29") : shoeStyle === "boots" ? (preset.finish === "luxe" ? "#2a2421" : "#574236") : "#e0dfd9",
    shoeStyle,
    topCut,
    bottomCut,
    fitted: topCut === "blouse" || dress,
    neckline,
    // Lapels and double-breasting only exist on tailored outerwear.
    lapel: tailored ? (preset.lapel === "none" ? "notch" : preset.lapel) : "none",
    doubleBreasted: tailored && preset.doubleBreasted,
    pocketSquare: tailored && preset.pocketSquare,
    tie: (visual.accessories?.tie ?? preset.tie) && neckline === "collar",
    finish: preset.finish
  };
}

/** Outfit styles that wear the casual scanned outfit when a body ships one. */
const CASUAL_STYLES: ReadonlySet<AvatarOutfitStyle> = new Set(["casual", "technical", "creative"]);

/**
 * Local Blender bodies carry whole scanned outfits (`ScanOutfit`, `ScanOutfitCasual`, ...) and
 * accessory meshes (`Acc*`). The look's outfit style picks one outfit; casual styles wear the
 * casual one when the body has it, everything else the office one.
 */
export function scanOutfitSlot(outfit: AvatarOutfitStyle, slots: ReadonlySet<string>): string | undefined {
  if (CASUAL_STYLES.has(outfit) && slots.has("ScanOutfitCasual")) return "ScanOutfitCasual";
  if (slots.has("ScanOutfit")) return "ScanOutfit";
  return [...slots].find(slot => slot.startsWith("ScanOutfit"));
}

/**
 * The accessory meshes a look wears on a local Blender body. The watch sits on the bare wrist, so it
 * shows only with an outfit that leaves the forearm bare (the casual one, sleeves rolled).
 */
export function scanAccessorySlots(accessories: AvatarVisualConfig["accessories"], outfitSlot?: string): Set<string> {
  const worn = new Set<string>();
  if (accessories?.glasses) worn.add("AccGlasses");
  if (accessories?.watch && outfitSlot === "ScanOutfitCasual") worn.add("AccWatch");
  if (accessories?.earrings) worn.add("AccEarrings");
  if (accessories?.badge) worn.add("AccBadge");
  if (accessories?.headphones) worn.add("AccHeadphones");
  return worn;
}
