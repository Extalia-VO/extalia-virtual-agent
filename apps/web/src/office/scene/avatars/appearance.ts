import { humanoidInstanceSeed, type HumanoidStature } from "./rig";
export type AvatarModelVariant = "office-classic" | "female-casual" | "business-man" | "business-woman";

export type AvatarPresentation = "female" | "male" | "neutral" | "unconfigured";

export type AvatarOutfitStyle = "ceo" | "architect" | "executive" | "business-casual" | "creative" | "technical" | "service" | "casual" | "source-outfit";

/** Authored head silhouettes shared by the 3D rig and the 2D board portrait. */
export type AvatarHairVariant =
  | "short-fade" | "slicked-back" | "side-part" | "undercut" | "textured-crop"
  | "shoulder-bob" | "executive-medium" | "curly" | "ponytail" | "high-ponytail" | "source-native" | "wavy" | "afro";

export type AvatarBagStyle = "briefcase" | "messenger" | "tote";
export type AvatarGlassesStyle = "rectangular" | "round" | "rimless";

export interface AvatarClothingConfig {
  style?: AvatarOutfitStyle;
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
  clothing?: AvatarClothingConfig;
  accessories?: AvatarAccessoryConfig;
}


/** Customization contract is independent of presence and runtime state. */
export type CharacterAppearance = Omit<AvatarVisualConfig, "identityId" | "modelUrl" | "modelVariant" | "accessories"> & {
  accessories?: Pick<AvatarAccessoryConfig, "glasses" | "glassesStyle" | "headphones" | "watch" | "watchStyle" | "badge" | "custom">;
};

export function characterAppearance(id: string): AvatarVisualConfig {
  const seed = humanoidInstanceSeed(id);
  const female = (seed >>> 6) % 2 === 1;
  const hair = female ? ["shoulder-bob", "wavy", "ponytail", "curly"] : ["side-part", "short-fade", "textured-crop", "afro"];
  const skins = ["#c79a82", "#d0a084", "#a9765e", "#e0b394", "#8e634d"];
  const colors = ["#263038", "#4d382d", "#292426", "#6a5140", "#282b32"];
  return { identityId: id, skinTone: skins[(seed >>> 12) % skins.length] ?? "#c79a82", hairColor: colors[(seed >>> 15) % colors.length] ?? "#302b2c", presentation: female ? "female" : "male", hairVariant: hair[(seed >>> 10) % hair.length] ?? "side-part", accessories: { glasses: seed % 4 === 0, watch: seed % 3 === 0, badge: true } };
}
