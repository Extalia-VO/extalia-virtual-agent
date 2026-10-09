import {
  CHARACTER_HAIR_STYLES,
  type CharacterAccessories, type CharacterAppearance, type CharacterBottom, type CharacterGait, type CharacterHairStyle,
  type CharacterOutfit, type CharacterPresentation, type CharacterTop,
} from "@extalia/core";
import { createHumanoidRigProfile, humanoidInstanceSeed, type HumanoidRigProfile, type HumanoidStature } from "./rig";

export type { CharacterAppearance } from "@extalia/core";

export type AvatarModelVariant = "office-classic" | "female-casual" | "business-man" | "business-woman";

/** Presets plus legacy aliases kept for older saved visuals (`female`/`male`/`unconfigured`). */
export type AvatarPresentation = CharacterPresentation | "female" | "male" | "unconfigured";

export type AvatarOutfitStyle = "ceo" | "architect" | "executive" | "business-casual" | "creative" | "technical" | "service" | "casual" | "source-outfit";

/** Authored head silhouettes shared by the 3D rig and the 2D board portrait. */
export type AvatarHairVariant =
  | "short-fade" | "slicked-back" | "side-part" | "undercut" | "textured-crop"
  | "shoulder-bob" | "executive-medium" | "curly" | "ponytail" | "high-ponytail" | "source-native" | "wavy" | "afro"
  | CharacterHairStyle;

export type AvatarBagStyle = "briefcase" | "messenger" | "tote";
export type AvatarGlassesStyle = "rectangular" | "round" | "rimless";

export interface AvatarClothingConfig {
  style?: AvatarOutfitStyle;
  /** Garment cuts; omitted keeps the outfit's own neckline and trousers. */
  topCut?: CharacterTop;
  bottomCut?: CharacterBottom;
  accent?: string;
  top?: string;
  bottom?: string;
  shoes?: string;
  outerwear?: string;
  palette?: string;
}

export interface AvatarAccessoryConfig {
  glasses?: boolean;
  headphones?: boolean;
  badge?: boolean;
  watch?: boolean;
  /** Frame cut when `glasses` is enabled. */
  glassesStyle?: AvatarGlassesStyle;
  /** Luxury watches gain a metal bracelet and bezel. */
  watchStyle?: "classic" | "luxury" | "smart";
  earrings?: "studs" | "hoops";
  /** Overrides the outfit's tie; drawn with collared tops only. */
  tie?: boolean;
  /** Phone is held in idle/free states and pocketed while working or seated. */
  phone?: boolean;
  /** Bag is carried while standing/walking and set beside the seat when seated. */
  bag?: boolean | AvatarBagStyle;
  custom?: string[];
}

export interface AvatarVisualConfig {
  identityId: string;
  presentation: AvatarPresentation;
  modelUrl?: string;
  /** Selected source-derived lite pack; omitted preferences retain the classic model. */
  modelVariant?: AvatarModelVariant;
  /** Body archetype; keeps seeded rig variation and joint metadata deterministic. */
  stature?: HumanoidStature;
  /** Explicit standing height in metres (1.45–1.95), shared by studio and office. */
  heightMeters?: number;
  hairVariant?: AvatarHairVariant | (string & {});
  hairColor?: string;
  skinTone?: string;
  /** Walking style; idle weight shift uses it until navigation exists. */
  gait?: CharacterGait;
  clothing?: AvatarClothingConfig;
  accessories?: AvatarAccessoryConfig;
}

export function presentationPreset(value: AvatarPresentation | undefined): CharacterPresentation {
  return value === "feminine" || value === "female" ? "feminine" : value === "masculine" || value === "male" ? "masculine" : "neutral";
}

/** Unconfigured avatars rotate through everyday outfits; signature looks are opt-in. */
export const SEEDED_OUTFITS: readonly CharacterOutfit[] = ["executive", "business-casual", "creative", "technical", "service", "casual"];

/** The top each outfit was authored with, so generated looks keep their original necklines. */
export const OUTFIT_TOPS: Readonly<Record<CharacterOutfit, CharacterTop>> = {
  ceo: "shirt", architect: "turtleneck", executive: "shirt", "business-casual": "shirt",
  creative: "shirt", technical: "shirt", service: "shirt", casual: "knit",
};
export const OUTFIT_TIES: Readonly<Record<CharacterOutfit, boolean>> = {
  ceo: true, architect: false, executive: true, "business-casual": false,
  creative: false, technical: false, service: true, casual: false,
};

export const SKIN_TONES = ["#f1c9a9", "#e0b394", "#c79a82", "#a9765e", "#8e634d", "#5f4032"] as const;
export const HAIR_COLORS = ["#16110f", "#292426", "#4d382d", "#6a5140", "#9b6b43", "#c9a26a", "#a8a39b", "#7a2f2a"] as const;
const SEEDED_SKINS = ["#c79a82", "#d0a084", "#a9765e", "#e0b394", "#8e634d"];
const SEEDED_HAIR = ["#263038", "#4d382d", "#292426", "#6a5140", "#282b32"];
const GLASSES = ["rectangular", "round", "rimless"] as const;

export interface PresentationPresetDefinition {
  /** Hair choices of the preset; a character's id picks one, never its name. */
  hair: readonly CharacterHairStyle[];
  outfit: CharacterOutfit;
  top: CharacterTop;
  bottom: CharacterBottom;
  accessories: Pick<CharacterAccessories, "watch" | "earrings" | "bag" | "tie">;
  gait: CharacterGait;
}

/** Presentation presets are style choices: each sets hair, cuts, accessories, frame and gait. */
export const PRESENTATION_PRESETS: Readonly<Record<CharacterPresentation, PresentationPresetDefinition>> = {
  feminine: {
    hair: ["long", "wavy", "ponytail", "bun", "bob"],
    outfit: "business-casual", top: "blouse", bottom: "skirt",
    accessories: { watch: "classic", earrings: "studs", bag: "tote", tie: false },
    gait: "feminine",
  },
  masculine: {
    hair: ["side-part", "short-fade", "textured-crop", "undercut", "slicked-back"],
    outfit: "executive", top: "shirt", bottom: "trousers",
    accessories: { watch: "classic", earrings: "none", bag: "briefcase", tie: true },
    gait: "masculine",
  },
  neutral: {
    // Neutral mixes shorter and longer cuts.
    hair: ["medium", "curly", "afro", "bob", "textured-crop"],
    outfit: "creative", top: "knit", bottom: "trousers",
    accessories: { watch: "smart", earrings: "none", bag: "messenger", tie: false },
    gait: "neutral",
  },
};

/**
 * Deterministic look for a character without saved settings. It is seeded only
 * from the presence id and always uses the neutral frame and gait: no gender is
 * inferred from names, titles, models or providers.
 */
export function defaultCharacterAppearance(id: string): CharacterAppearance {
  const seed = humanoidInstanceSeed(id);
  const outfit = SEEDED_OUTFITS[seed % SEEDED_OUTFITS.length] ?? "business-casual";
  return {
    presentation: "neutral",
    hairStyle: CHARACTER_HAIR_STYLES[(seed >>> 10) % CHARACTER_HAIR_STYLES.length] ?? "medium",
    hairColor: SEEDED_HAIR[(seed >>> 15) % SEEDED_HAIR.length] ?? "#292426",
    skinTone: SEEDED_SKINS[(seed >>> 12) % SEEDED_SKINS.length] ?? "#c79a82",
    outfit, top: OUTFIT_TOPS[outfit], bottom: "trousers",
    stature: "default", gait: "neutral",
    accessories: {
      glasses: seed % 4 === 0 ? GLASSES[seed % GLASSES.length]! : "none",
      watch: seed % 3 === 0 ? "classic" : "none",
      earrings: "none", bag: "none", tie: OUTFIT_TIES[outfit], badge: true, headphones: false,
    },
  };
}

/**
 * Apply a presentation preset: hair, garment cuts, preset accessories, frame and
 * gait change; skin, hair colour, garment colours, stature, height, glasses,
 * badge and headphones stay as the user set them.
 */
export function applyPresentationPreset(base: CharacterAppearance, presentation: CharacterPresentation, id: string): CharacterAppearance {
  const preset = PRESENTATION_PRESETS[presentation];
  const seed = humanoidInstanceSeed(id, "appearance-preset");
  return {
    ...base,
    presentation,
    hairStyle: preset.hair[seed % preset.hair.length] ?? preset.hair[0]!,
    outfit: preset.outfit, top: preset.top, bottom: preset.bottom, gait: preset.gait,
    accessories: { ...base.accessories, ...preset.accessories },
  };
}

/** Renderer configuration for a saved (or default) appearance. */
export function avatarVisual(id: string, appearance: CharacterAppearance): AvatarVisualConfig {
  const { accessories: a } = appearance;
  return {
    identityId: id,
    presentation: appearance.presentation,
    stature: appearance.stature,
    ...(appearance.heightCm !== undefined ? { heightMeters: appearance.heightCm / 100 } : {}),
    hairVariant: appearance.hairStyle,
    hairColor: appearance.hairColor,
    skinTone: appearance.skinTone,
    gait: appearance.gait,
    clothing: {
      style: appearance.outfit, topCut: appearance.top, bottomCut: appearance.bottom,
      ...(appearance.topColor ? { top: appearance.topColor } : {}),
      ...(appearance.bottomColor ? { bottom: appearance.bottomColor } : {}),
    },
    accessories: {
      glasses: a.glasses !== "none", ...(a.glasses !== "none" ? { glassesStyle: a.glasses } : {}),
      watch: a.watch !== "none", ...(a.watch !== "none" ? { watchStyle: a.watch } : {}),
      ...(a.earrings !== "none" ? { earrings: a.earrings } : {}),
      bag: a.bag === "none" ? false : a.bag,
      tie: a.tie, badge: a.badge, headphones: a.headphones,
    },
  };
}

/** Generated look for a presence id (neutral and varied; see `defaultCharacterAppearance`). */
export function characterAppearance(id: string): AvatarVisualConfig {
  return avatarVisual(id, defaultCharacterAppearance(id));
}

/** One rig per character: frame from the presentation, archetype from stature, optional explicit height. */
export function characterRig(visual: AvatarVisualConfig): HumanoidRigProfile {
  const base = createHumanoidRigProfile(visual.identityId, { stature: visual.stature, frame: presentationPreset(visual.presentation) });
  if (visual.heightMeters === undefined) return base;
  const height = Math.max(1.45, Math.min(1.95, visual.heightMeters));
  const ratio = height / standingHeight(base);
  return { ...base, scale: base.scale.map(axis => axis * ratio) as [number, number, number] };
}

function standingHeight(rig: HumanoidRigProfile): number {
  const p = rig.proportions;
  return (p.standingHipHeight + p.headHeight + p.headRadius) * rig.scale[1];
}

/** Standing height in whole centimetres, as the editor shows it. */
export function characterHeightCm(visual: AvatarVisualConfig): number {
  return Math.round(standingHeight(characterRig(visual)) * 100);
}
