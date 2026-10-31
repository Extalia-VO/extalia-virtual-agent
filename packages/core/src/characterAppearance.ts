import { decode, object, oneOf, type DecodeResult } from './validation.js';

/**
 * Saved look of one Office character. Presentation is a style preset chosen by
 * the user; it is never inferred from a name, title, model or provider.
 */
export const CHARACTER_PRESENTATIONS = ['feminine', 'masculine'] as const;
export type CharacterPresentation = (typeof CHARACTER_PRESENTATIONS)[number];

export const CHARACTER_HAIR_STYLES = [
  'long', 'wavy', 'ponytail', 'bun', 'bob', 'medium', 'curly', 'afro',
  'textured-crop', 'side-part', 'short-fade', 'undercut', 'slicked-back', 'high-ponytail',
] as const;
export type CharacterHairStyle = (typeof CHARACTER_HAIR_STYLES)[number];

/** Outfit layers (blazer, coat, vest, cardigan or none) and shoes. */
export const CHARACTER_OUTFITS = ['executive', 'business-casual', 'creative', 'technical', 'service', 'casual', 'ceo', 'architect'] as const;
export type CharacterOutfit = (typeof CHARACTER_OUTFITS)[number];

export const CHARACTER_TOPS = ['shirt', 'blouse', 'knit', 'turtleneck'] as const;
export type CharacterTop = (typeof CHARACTER_TOPS)[number];

export const CHARACTER_BOTTOMS = ['trousers', 'skirt', 'dress'] as const;
export type CharacterBottom = (typeof CHARACTER_BOTTOMS)[number];

export const CHARACTER_STATURES = ['default', 'commanding', 'tall', 'athletic', 'slender', 'petite'] as const;
export type CharacterStature = (typeof CHARACTER_STATURES)[number];

/** Walking style; idle weight shift uses it until navigation exists. */
export const CHARACTER_GAITS = ['feminine', 'masculine'] as const;
export type CharacterGait = (typeof CHARACTER_GAITS)[number];

export const CHARACTER_GLASSES = ['none', 'rectangular', 'round', 'rimless'] as const;
export const CHARACTER_WATCHES = ['none', 'classic', 'luxury', 'smart'] as const;
export const CHARACTER_EARRINGS = ['none', 'studs', 'hoops'] as const;
export const CHARACTER_BAGS = ['none', 'briefcase', 'messenger', 'tote'] as const;

export interface CharacterAccessories {
  glasses: (typeof CHARACTER_GLASSES)[number];
  watch: (typeof CHARACTER_WATCHES)[number];
  earrings: (typeof CHARACTER_EARRINGS)[number];
  bag: (typeof CHARACTER_BAGS)[number];
  /** Shown with collared tops only. */
  tie: boolean;
  badge: boolean;
  headphones: boolean;
}

export const CHARACTER_OUTFIT_SLOTS = ['top', 'bottom', 'outer'] as const;
export type CharacterOutfitSlot = (typeof CHARACTER_OUTFIT_SLOTS)[number];
/** Independently fitted garments. Omitted top/bottom use the body's defaults; outer may be `none`. */
export type CharacterOutfitParts = Partial<Record<CharacterOutfitSlot, string>>;

export interface CharacterAppearance {
  presentation: CharacterPresentation;
  hairStyle: CharacterHairStyle;
  hairColor: string;
  skinTone: string;
  outfit: CharacterOutfit;
  top: CharacterTop;
  bottom: CharacterBottom;
  /**
   * A fitted outfit model from the avatar outfit catalog (`avatars/outfits/<group>/<id>.glb`),
   * worn instead of the body's scanned outfit; `outfit` stays the style for portraits and the
   * procedural fallback. Staff uniforms are catalog models too.
   */
  outfitModel?: string;
  /** Separate fitted garments; complete outfit selection clears these overrides. */
  outfitParts?: CharacterOutfitParts;
  /** Optional garment colors per tint zone; generated palettes are used when omitted. */
  topColor?: string;
  bottomColor?: string;
  /** Jacket, coat or waistcoat. */
  outerColor?: string;
  /** Tie, bow tie, scarf, badge stripe. */
  accentColor?: string;
  stature: CharacterStature;
  /** Standing height; omitted keeps the generated height. */
  heightCm?: number;
  gait: CharacterGait;
  accessories: CharacterAccessories;
}

/** Office presence ids: `<sessionId>:<agentId>`. */
export type CharacterAppearances = Record<string, CharacterAppearance>;

export const CHARACTER_APPEARANCES_SCHEMA = 'extalia.character-appearances.v1';
export const CHARACTER_HEIGHT_CM = { min: 145, max: 195 } as const;
export const MAX_CHARACTER_APPEARANCES = 500;
export const MAX_CHARACTER_ID_LENGTH = 300;

export interface CharacterAppearanceStore {
  schema: typeof CHARACTER_APPEARANCES_SCHEMA;
  characters: CharacterAppearances;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const APPEARANCE_FIELDS = new Set(['presentation', 'hairStyle', 'hairColor', 'skinTone', 'outfit', 'outfitModel', 'outfitParts', 'top', 'bottom', 'topColor', 'bottomColor', 'outerColor', 'accentColor', 'stature', 'heightCm', 'gait', 'accessories']);
/** Outfit model ids are catalog file names: lowercase words joined by hyphens. */
export const CHARACTER_OUTFIT_MODEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,7}$/;
const ACCESSORY_FIELDS = new Set(['glasses', 'watch', 'earrings', 'bag', 'tie', 'badge', 'headphones']);

function onlyKnown(value: Record<string, unknown>, known: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${field}.${key}: unknown field.`);
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error(`${field}: expected a color such as #3a4b5c.`);
  return value.toLowerCase();
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field}: expected true or false.`);
  return value;
}

/** Presence ids are single-line, bounded and session-scoped (`<sessionId>:<agentId>`). */
export function isCharacterId(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CHARACTER_ID_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) return false;
  const split = value.indexOf(':');
  return split > 0 && split < value.length - 1;
}

/** The session a character belongs to. */
export function characterSessionId(characterId: string): string {
  return characterId.slice(0, characterId.indexOf(':'));
}

/** Strict reader: every field is a known value, colors are `#rrggbb`, sizes are bounded. */
export function readCharacterAppearance(raw: unknown, field = 'appearance'): CharacterAppearance {
  const value = object(raw, field);
  onlyKnown(value, APPEARANCE_FIELDS, field);
  const accessories = object(value.accessories, `${field}.accessories`);
  onlyKnown(accessories, ACCESSORY_FIELDS, `${field}.accessories`);
  const appearance: CharacterAppearance = {
    presentation: oneOf(value.presentation, CHARACTER_PRESENTATIONS, `${field}.presentation`),
    hairStyle: oneOf(value.hairStyle, CHARACTER_HAIR_STYLES, `${field}.hairStyle`),
    hairColor: color(value.hairColor, `${field}.hairColor`),
    skinTone: color(value.skinTone, `${field}.skinTone`),
    outfit: oneOf(value.outfit, CHARACTER_OUTFITS, `${field}.outfit`),
    top: oneOf(value.top, CHARACTER_TOPS, `${field}.top`),
    bottom: oneOf(value.bottom, CHARACTER_BOTTOMS, `${field}.bottom`),
    stature: oneOf(value.stature, CHARACTER_STATURES, `${field}.stature`),
    gait: oneOf(value.gait, CHARACTER_GAITS, `${field}.gait`),
    accessories: {
      glasses: oneOf(accessories.glasses, CHARACTER_GLASSES, `${field}.accessories.glasses`),
      watch: oneOf(accessories.watch, CHARACTER_WATCHES, `${field}.accessories.watch`),
      earrings: oneOf(accessories.earrings, CHARACTER_EARRINGS, `${field}.accessories.earrings`),
      bag: oneOf(accessories.bag, CHARACTER_BAGS, `${field}.accessories.bag`),
      tie: flag(accessories.tie, `${field}.accessories.tie`),
      badge: flag(accessories.badge, `${field}.accessories.badge`),
      headphones: flag(accessories.headphones, `${field}.accessories.headphones`),
    },
  };
  if (value.outfitModel !== undefined) {
    if (typeof value.outfitModel !== 'string' || value.outfitModel.length > 64 || !CHARACTER_OUTFIT_MODEL.test(value.outfitModel)) {
      throw new Error(`${field}.outfitModel: expected an outfit id such as reception-uniform.`);
    }
    appearance.outfitModel = value.outfitModel;
  }
  if (value.outfitParts !== undefined) {
    const parts = object(value.outfitParts, `${field}.outfitParts`);
    onlyKnown(parts, new Set(CHARACTER_OUTFIT_SLOTS), `${field}.outfitParts`);
    const selected: CharacterOutfitParts = {};
    for (const slot of CHARACTER_OUTFIT_SLOTS) {
      const id = parts[slot];
      if (id === undefined) continue;
      if (typeof id !== 'string' || id.length > 64 || !CHARACTER_OUTFIT_MODEL.test(id) || (id === 'none' && slot !== 'outer')) {
        throw new Error(`${field}.outfitParts.${slot}: expected a fitted garment id${slot === 'outer' ? ' or none' : ''}.`);
      }
      selected[slot] = id;
    }
    if (appearance.outfitModel !== undefined) throw new Error(`${field}: choose a complete outfit or separate garments.`);
    appearance.outfitParts = selected;
  }
  for (const key of ['topColor', 'bottomColor', 'outerColor', 'accentColor'] as const) {
    if (value[key] !== undefined) appearance[key] = color(value[key], `${field}.${key}`);
  }
  if (value.heightCm !== undefined) {
    const height = value.heightCm;
    if (typeof height !== 'number' || !Number.isInteger(height) || height < CHARACTER_HEIGHT_CM.min || height > CHARACTER_HEIGHT_CM.max) {
      throw new Error(`${field}.heightCm: expected a whole number from ${CHARACTER_HEIGHT_CM.min} to ${CHARACTER_HEIGHT_CM.max}.`);
    }
    appearance.heightCm = height;
  }
  return appearance;
}

export function decodeCharacterAppearance(raw: unknown): DecodeResult<CharacterAppearance> {
  return decode(() => readCharacterAppearance(raw));
}

export function emptyCharacterAppearanceStore(): CharacterAppearanceStore {
  return { schema: CHARACTER_APPEARANCES_SCHEMA, characters: {} };
}

/** The whole file is rejected when any entry is invalid; the host then keeps it aside. */
export function decodeCharacterAppearanceStore(raw: unknown): DecodeResult<CharacterAppearanceStore> {
  return decode(() => {
    const value = object(raw, 'store');
    onlyKnown(value, new Set(['schema', 'characters']), 'store');
    if (value.schema !== CHARACTER_APPEARANCES_SCHEMA) throw new Error(`schema: expected ${CHARACTER_APPEARANCES_SCHEMA}.`);
    const entries = Object.entries(object(value.characters, 'characters'));
    if (entries.length > MAX_CHARACTER_APPEARANCES) throw new Error(`characters: more than ${MAX_CHARACTER_APPEARANCES} entries.`);
    const characters = Object.fromEntries(entries.map(([id, item]) => {
      if (!isCharacterId(id)) throw new Error('characters: invalid character id.');
      return [id, readCharacterAppearance(item, `characters[${JSON.stringify(id)}]`)];
    }));
    return { schema: CHARACTER_APPEARANCES_SCHEMA, characters };
  });
}
