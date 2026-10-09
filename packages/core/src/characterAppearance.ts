import { decode, object, oneOf, type DecodeResult } from './validation.js';

/**
 * Saved look of one Office character. Presentation is a style preset chosen by
 * the user; it is never inferred from a name, title, model or provider.
 */
export const CHARACTER_PRESENTATIONS = ['feminine', 'masculine', 'neutral'] as const;
export type CharacterPresentation = (typeof CHARACTER_PRESENTATIONS)[number];

export const CHARACTER_HAIR_STYLES = [
  'long', 'wavy', 'ponytail', 'bun', 'bob', 'medium', 'curly', 'afro',
  'textured-crop', 'side-part', 'short-fade', 'undercut', 'slicked-back',
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
export const CHARACTER_GAITS = ['feminine', 'masculine', 'neutral'] as const;
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

export interface CharacterAppearance {
  presentation: CharacterPresentation;
  hairStyle: CharacterHairStyle;
  hairColor: string;
  skinTone: string;
  outfit: CharacterOutfit;
  top: CharacterTop;
  bottom: CharacterBottom;
  /** Optional garment colours; generated palettes are used when omitted. */
  topColor?: string;
  bottomColor?: string;
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
const APPEARANCE_FIELDS = new Set(['presentation', 'hairStyle', 'hairColor', 'skinTone', 'outfit', 'top', 'bottom', 'topColor', 'bottomColor', 'stature', 'heightCm', 'gait', 'accessories']);
const ACCESSORY_FIELDS = new Set(['glasses', 'watch', 'earrings', 'bag', 'tie', 'badge', 'headphones']);

function onlyKnown(value: Record<string, unknown>, known: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${field}.${key}: unknown field.`);
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error(`${field}: expected a colour such as #3a4b5c.`);
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

/** Strict reader: every field is a known value, colours are `#rrggbb`, sizes are bounded. */
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
  if (value.topColor !== undefined) appearance.topColor = color(value.topColor, `${field}.topColor`);
  if (value.bottomColor !== undefined) appearance.bottomColor = color(value.bottomColor, `${field}.bottomColor`);
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
