import {
  type CharacterAccessories, type CharacterAppearance, type CharacterBottom, type CharacterGait, type CharacterHairStyle,
  type CharacterOutfit, type CharacterOutfitParts, type CharacterPresentation, type CharacterTop,
} from "@extalia/core";
import { HUMANOID_HEAD_ELONGATION, createHumanoidRigProfile, humanoidInstanceSeed, type HumanoidRigProfile, type HumanoidStature } from "./rig";
import { seededOutfitChoice, seededOutfitParts } from "./outfitCatalog";

export type { CharacterAppearance, CharacterPresentation } from "@extalia/core";

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
  /** Fitted outfit model id (`avatars/outfits/<group>/<id>.glb`) worn instead of the scanned outfit. */
  model?: string;
  /** Independent fitted top, bottom and optional outer layer. */
  parts?: CharacterOutfitParts;
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
  return value === "feminine" || value === "female" ? "feminine" : "masculine";
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
    // Generated looks wear the detailed styles of their own presentation (see characterHair `detail`).
    hair: ["high-ponytail", "bun"],
    outfit: "business-casual", top: "blouse", bottom: "skirt",
    accessories: { watch: "classic", earrings: "studs", bag: "tote", tie: false },
    gait: "feminine",
  },
  masculine: {
    hair: ["textured-crop", "slicked-back"],
    outfit: "executive", top: "shirt", bottom: "trousers",
    accessories: { watch: "classic", earrings: "none", bag: "briefcase", tie: true },
    gait: "masculine",
  },
};

/**
 * Deterministic look for a character without saved settings, seeded from `id`
 * (a presence id, or a name seed from `lookIdentity`). The presentation comes
 * from explicit metadata when given (`presentation`); otherwise the seed picks
 * a neutral masculine or feminine preset. Nothing is inferred from the text of
 * names, titles, models or providers.
 */
export function defaultCharacterAppearance(id: string, presentation?: CharacterPresentation): CharacterAppearance {
  const seed = humanoidInstanceSeed(id);
  presentation ??= (seed & 1) === 0 ? "masculine" : "feminine";
  const preset = PRESENTATION_PRESETS[presentation];
  // First spawn: an everyday style or one of the gender group's fitted outfit models, picked from
  // the catalog found at build time (stable per id; see `seededOutfitChoice`).
  const choice = seededOutfitChoice(id, presentation);
  const parts = seededOutfitParts(id, presentation);
  const outfit = choice.kind === "style" ? choice.style : SEEDED_OUTFITS[seed % SEEDED_OUTFITS.length] ?? preset.outfit;
  const hairStyle = preset.hair[(seed >>> 10) % preset.hair.length] ?? preset.hair[0]!;
  const top = presentation === "feminine" && outfit === "business-casual" ? "blouse" : OUTFIT_TOPS[outfit];
  const bottom = presentation === "feminine" && (seed >>> 6) % 2 === 0 ? "skirt" : "trousers";
  return {
    presentation,
    ...(choice.kind === "model" ? { outfitModel: choice.id } : parts ? { outfitParts: parts } : {}),
    hairStyle,
    hairColor: SEEDED_HAIR[(seed >>> 15) % SEEDED_HAIR.length] ?? "#292426",
    skinTone: SEEDED_SKINS[(seed >>> 12) % SEEDED_SKINS.length] ?? "#c79a82",
    outfit, top, bottom,
    stature: "default", gait: presentation,
    accessories: {
      glasses: seed % 4 === 0 ? GLASSES[seed % GLASSES.length]! : "none",
      watch: seed % 3 === 0 ? "classic" : "none",
      earrings: presentation === "feminine" && (seed >>> 4) % 2 === 0 ? "studs" : "none",
      bag: "none",
      tie: presentation === "masculine" && top === "shirt" ? OUTFIT_TIES[outfit] : false,
      badge: true,
      headphones: false,
    },
  };
}

/**
 * Apply a presentation preset: hair, garment cuts, preset accessories, frame and
 * gait change; skin, hair color, garment colors, stature, height, glasses,
 * badge and headphones stay as the user set them.
 */
export function applyPresentationPreset(base: CharacterAppearance, presentation: CharacterPresentation, id: string): CharacterAppearance {
  const preset = PRESENTATION_PRESETS[presentation];
  const seed = humanoidInstanceSeed(id, "appearance-preset");
  const look: CharacterAppearance = {
    ...base,
    presentation,
    hairStyle: preset.hair[seed % preset.hair.length] ?? preset.hair[0]!,
    outfit: preset.outfit, top: preset.top, bottom: preset.bottom, gait: preset.gait,
    accessories: { ...base.accessories, ...preset.accessories },
  };
  // A preset applies its scanned style; a fitted model may belong to the previous body.
  delete look.outfitModel;
  delete look.outfitParts;
  return look;
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
      ...(appearance.outfitModel ? { model: appearance.outfitModel } : {}),
      ...(appearance.outfitParts ? { parts: { ...appearance.outfitParts } } : {}),
      ...(appearance.topColor ? { top: appearance.topColor } : {}),
      ...(appearance.bottomColor ? { bottom: appearance.bottomColor } : {}),
      ...(appearance.outerColor ? { outerwear: appearance.outerColor } : {}),
      ...(appearance.accentColor ? { accent: appearance.accentColor } : {}),
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

/** Generated look for a presence id or name seed (neutral and varied; see `defaultCharacterAppearance`). */
export function characterAppearance(id: string, presentation?: CharacterPresentation): AvatarVisualConfig {
  return avatarVisual(id, defaultCharacterAppearance(id, presentation));
}

/* ── v0.0.30 ui: looks generated from a character's full name ── */

/** Explicit gender metadata of an agent or team member (never inferred from its name). */
export type LookGender = "female" | "male";

/**
 * What a character's generated look is seeded from: its full name (so the same
 * name looks the same in 3D, on the board, in the popover and in the team
 * dialog) and its explicit gender, when known.
 */
export interface LookIdentity { seed: string; presentation?: CharacterPresentation }

/** The seed of a full name: case, outer and repeated spaces do not matter. */
export function nameSeed(name: string): string {
  return `name:${name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`;
}

export function genderPresentation(gender: unknown): CharacterPresentation | undefined {
  return gender === "female" ? "feminine" : gender === "male" ? "masculine" : undefined;
}

/** A name's look identity, or `undefined` for an empty name (the character keeps its id-seeded look). */
export function lookIdentity(name: string | undefined, gender?: unknown): LookIdentity | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const presentation = genderPresentation(gender);
  return { seed: nameSeed(trimmed), ...(presentation ? { presentation } : {}) };
}

/** The id that seeds a character's rig, palette and generated look: its name seed when it has one. */
export function lookSeed(id: string, identity: LookIdentity | undefined): string {
  return identity?.seed ?? id;
}

/** A character's look: the saved one wins; otherwise the one generated from its name (or id). */
export function resolvedAppearance(id: string, saved: CharacterAppearance | undefined, identity: LookIdentity | undefined): CharacterAppearance {
  return saved ?? defaultCharacterAppearance(lookSeed(id, identity), identity?.presentation);
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
  return (p.standingHipHeight + p.headHeight + p.headRadius * HUMANOID_HEAD_ELONGATION) * rig.scale[1];
}

/** Standing height in whole centimetres, as the editor shows it. */
export function characterHeightCm(visual: AvatarVisualConfig): number {
  return Math.round(standingHeight(characterRig(visual)) * 100);
}
