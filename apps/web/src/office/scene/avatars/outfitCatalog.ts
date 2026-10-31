/**
 * Outfit choices of a character: the scanned outfit styles every body wears, plus the fitted
 * outfit models found at build time under `avatars/outfits/<group>/<id>.glb` (the garment
 * catalog and the staff uniforms). Nothing here lists model ids by hand except the two staff
 * roles: a new file in the catalog becomes a choice for its gender group automatically.
 * Renderer-independent (no three.js).
 */
import {
  CHARACTER_OUTFIT_MODEL, CHARACTER_OUTFITS,
  type CharacterAppearance, type CharacterOutfit, type CharacterOutfitParts, type CharacterOutfitSlot, type CharacterPresentation,
} from '@extalia/core';
import { humanoidInstanceSeed } from './rig';
import { outfitUrls, pieceUrls } from './sourceAvatarFiles';

export type OutfitGroup = 'male' | 'female';
export type StaffRole = 'receptionist' | 'bartender';
type UrlMap = Readonly<Record<string, string>>;

/** Staff uniform per facility role: catalog model ids (one file per gender group). */
export const STAFF_UNIFORMS: Readonly<Record<StaffRole, string>> = { receptionist: 'reception-uniform', bartender: 'bartender-uniform' };
/** Style each uniform stands for in portraits and the procedural fallback. */
const UNIFORM_STYLES: Readonly<Record<StaffRole, CharacterOutfit>> = { receptionist: 'executive', bartender: 'service' };
const STAFF_BY_MODEL = new Map(Object.entries(STAFF_UNIFORMS).map(([role, id]) => [id, role as StaffRole]));

/** Everyday styles a generated look may draw; signature looks (CEO, architect) stay opt-in. */
export const EVERYDAY_STYLES: readonly CharacterOutfit[] = ['executive', 'business-casual', 'creative', 'technical', 'service', 'casual'];

export interface OutfitModel { id: string; group: OutfitGroup; url: string; staff?: StaffRole }
export interface OutfitPieceModel { id: string; group: OutfitGroup; slot: CharacterOutfitSlot; url: string }

export type OutfitChoice = { kind: 'style'; style: CharacterOutfit } | { kind: 'model'; id: string };

export function presentationGroup(presentation: CharacterPresentation): OutfitGroup {
  return presentation === 'feminine' ? 'female' : 'male';
}

const MODEL_PATH = /^\/(public|local)-assets\/avatars\/outfits\/(male|female)\/([^/]+)\.glb$/;

/** Every outfit model in the bundle, public files first, sorted by id. */
export function outfitModels(urls: UrlMap = outfitUrls): OutfitModel[] {
  const found = new Map<string, OutfitModel>();
  const entries = Object.entries(urls).map(([path, url]) => ({ match: MODEL_PATH.exec(path), url }))
    .filter((entry): entry is { match: RegExpExecArray; url: string } => entry.match !== null)
    .sort((a, b) => (a.match[1] === 'public' ? 0 : 1) - (b.match[1] === 'public' ? 0 : 1));
  for (const { match, url } of entries) {
    const group = match[2] as OutfitGroup, id = match[3]!;
    // File names may carry the catalog prefix (`outfit-dress`) or not (`dress`): the id is the name.
    if (!CHARACTER_OUTFIT_MODEL.test(id) || found.has(`${group}/${id}`)) continue;
    const staff = STAFF_BY_MODEL.get(id);
    found.set(`${group}/${id}`, { id, group, url, ...(staff ? { staff } : {}) });
  }
  return [...found.values()].sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}

export function outfitModelUrl(id: string | undefined, group: OutfitGroup, urls: UrlMap = outfitUrls): string | undefined {
  return id ? outfitModels(urls).find(model => model.id === id && model.group === group)?.url : undefined;
}

const PIECE_PATH = /^\/(public|local)-assets\/avatars\/wardrobe\/(male|female)\/(top|bottom|outer)\/([^/]+)\.glb$/;

/** Published fitted separates; public files take precedence over local copies. */
export function pieceModels(urls: UrlMap = pieceUrls): OutfitPieceModel[] {
  const found = new Map<string, OutfitPieceModel>();
  const entries = Object.entries(urls).map(([path, url]) => ({ match: PIECE_PATH.exec(path), url }))
    .filter((entry): entry is { match: RegExpExecArray; url: string } => entry.match !== null)
    .sort((a, b) => (a.match[1] === 'public' ? 0 : 1) - (b.match[1] === 'public' ? 0 : 1));
  for (const { match, url } of entries) {
    const group = match[2] as OutfitGroup, slot = match[3] as CharacterOutfitSlot, id = match[4]!;
    const key = `${group}/${slot}/${id}`;
    if (!CHARACTER_OUTFIT_MODEL.test(id) || id === 'none' || found.has(key)) continue;
    found.set(key, { group, slot, id, url });
  }
  return [...found.values()].sort((a, b) => `${a.group}/${a.slot}/${a.id}`.localeCompare(`${b.group}/${b.slot}/${b.id}`));
}

export function pieceChoices(presentation: CharacterPresentation, slot: CharacterOutfitSlot, urls: UrlMap = pieceUrls): OutfitPieceModel[] {
  return pieceModels(urls).filter(piece => piece.group === presentationGroup(presentation) && piece.slot === slot);
}

/** Each slot has its own stable seed; a new bottom does not reroll the top or jacket. */
export function seededOutfitParts(seed: string, presentation: CharacterPresentation, urls: UrlMap = pieceUrls): CharacterOutfitParts | undefined {
  const top = pieceChoices(presentation, 'top', urls), bottom = pieceChoices(presentation, 'bottom', urls);
  const outer = pieceChoices(presentation, 'outer', urls);
  if (!top.length && !bottom.length && !outer.length) return undefined;
  const selectedTop = rendezvous(seed, top, piece => piece.id, 'wardrobe-top');
  const selectedBottom = rendezvous(seed, bottom, piece => piece.id, 'wardrobe-bottom');
  return {
    ...(selectedTop ? { top: selectedTop.id } : {}),
    ...(selectedBottom ? { bottom: selectedBottom.id } : {}),
    outer: rendezvous(seed, ['none', ...outer.map(piece => piece.id)], String, 'wardrobe-outer')!,
  };
}

/** Change one slot without losing the others; an omitted slot means the body's default garment. */
export function applyOutfitPiece(appearance: CharacterAppearance, slot: CharacterOutfitSlot, id: string | undefined): CharacterAppearance {
  const parts = { ...appearance.outfitParts };
  if (id === undefined) delete parts[slot];
  else parts[slot] = id;
  const next = { ...appearance, outfitParts: parts };
  delete next.outfitModel;
  return next;
}

/** Everything a character of this presentation may wear: every style, then the group's models (never a staff uniform). */
export function outfitChoices(presentation: CharacterPresentation, urls: UrlMap = outfitUrls): OutfitChoice[] {
  const group = presentationGroup(presentation);
  return [
    ...CHARACTER_OUTFITS.map(style => ({ kind: 'style' as const, style })),
    ...outfitModels(urls).filter(model => model.group === group && !model.staff).map(model => ({ kind: 'model' as const, id: model.id })),
  ];
}

export function choiceValue(choice: OutfitChoice): string {
  return choice.kind === 'style' ? `style:${choice.style}` : `model:${choice.id}`;
}

export function appearanceChoice(appearance: Pick<CharacterAppearance, 'outfit' | 'outfitModel' | 'outfitParts'>): string {
  if (appearance.outfitParts) return `parts:${['top', 'bottom', 'outer'].map(slot => appearance.outfitParts?.[slot as CharacterOutfitSlot] ?? '').join('/')}`;
  return appearance.outfitModel ? `model:${appearance.outfitModel}` : `style:${appearance.outfit}`;
}

/** Wear a choice: a style clears the model; a model keeps the style for portraits and the fallback. */
export function applyOutfitChoice(appearance: CharacterAppearance, value: string): CharacterAppearance {
  const next = { ...appearance };
  delete next.outfitParts;
  if (value.startsWith('model:')) next.outfitModel = value.slice(6);
  else {
    delete next.outfitModel;
    const style = value.slice(6) as CharacterOutfit;
    if ((CHARACTER_OUTFITS as readonly string[]).includes(style)) next.outfit = style;
  }
  return next;
}

/**
 * Highest-random-weight pick: each candidate gets a hash of (seed, candidate) and the largest
 * wins. Stable across reloads, varied across ids, and when the catalog gains an outfit only the
 * characters the new outfit wins for change (about 1 in N), not everyone.
 */
export function rendezvous<T>(seed: string, candidates: readonly T[], key: (item: T) => string, namespace = 'outfit'): T | undefined {
  let best: T | undefined, score = -1;
  for (const candidate of candidates) {
    const value = humanoidInstanceSeed(`${seed}|${key(candidate)}`, namespace);
    if (value > score) { score = value; best = candidate; }
  }
  return best;
}

/** The generated (first-spawn) outfit: an everyday style or one of the group's everyday models. */
export function seededOutfitChoice(seed: string, presentation: CharacterPresentation, urls: UrlMap = outfitUrls): OutfitChoice {
  const group = presentationGroup(presentation);
  const pool: OutfitChoice[] = [
    ...EVERYDAY_STYLES.map(style => ({ kind: 'style' as const, style })),
    ...outfitModels(urls).filter(model => model.group === group && !model.staff).map(model => ({ kind: 'model' as const, id: model.id })),
  ];
  return rendezvous(seed, pool, choiceValue) ?? { kind: 'style', style: 'business-casual' };
}

// ── Palettes ──

export interface ZonePalette { top: string; bottom: string; outer: string; accent: string }

/**
 * Tasteful coordinated palettes per outfit family (shirt, trousers or skirt, jacket or knit
 * layer, tie/scarf accent): muted office neutrals and soft casual tones, never random RGB.
 */
export const OUTFIT_PALETTES: Readonly<Record<'office' | 'casual', readonly ZonePalette[]>> = {
  office: [
    { top: '#f1eee6', bottom: '#262c38', outer: '#2c3445', accent: '#7c2a35' },
    { top: '#e4ebf2', bottom: '#33373d', outer: '#3d4148', accent: '#2f5d7c' },
    { top: '#f4f1ea', bottom: '#4a4038', outer: '#5c4f43', accent: '#b0875c' },
    { top: '#e9e4ef', bottom: '#2d2b33', outer: '#46405a', accent: '#8a6f9e' },
    { top: '#eef2ec', bottom: '#2f3a33', outer: '#3f4f45', accent: '#9b8550' },
    { top: '#f6f3ee', bottom: '#1f2228', outer: '#23272f', accent: '#0f8f86' },
    { top: '#dfe6ee', bottom: '#5a5d63', outer: '#6b6f76', accent: '#26324a' },
    { top: '#f2e9e1', bottom: '#3b2f2c', outer: '#6d4c41', accent: '#c19a6b' },
  ],
  casual: [
    { top: '#c5d2cf', bottom: '#3b443b', outer: '#526250', accent: '#d4b779' },
    { top: '#e8d0bf', bottom: '#463c3b', outer: '#80635d', accent: '#d3a281' },
    { top: '#c3cedc', bottom: '#303947', outer: '#3f5676', accent: '#a9bfd2' },
    { top: '#ddd1df', bottom: '#413e4a', outer: '#6e657f', accent: '#d6af89' },
    { top: '#e5e2d9', bottom: '#303a45', outer: '#394d5b', accent: '#be9967' },
    { top: '#d9e2d0', bottom: '#5b5447', outer: '#8a7d63', accent: '#c9a26a' },
  ],
};

const CASUAL_STYLES: ReadonlySet<CharacterOutfit> = new Set(['casual', 'creative', 'technical']);

export function paletteFamily(style: CharacterOutfit, model?: string): 'office' | 'casual' {
  if (model) return model.endsWith('-uniform') ? 'office' : 'casual';
  return CASUAL_STYLES.has(style) ? 'casual' : 'office';
}

/** The seeded palette of an identity for a style (stable; varied across characters). */
export function seededPalette(seed: string, style: CharacterOutfit, model?: string): ZonePalette {
  const family = OUTFIT_PALETTES[paletteFamily(style, model)];
  return rendezvous(seed, family, palette => `${palette.top}${palette.outer}`, 'palette') ?? family[0]!;
}

/** Accent swatches offered for staff uniforms (the brand colour first). */
export const UNIFORM_ACCENTS = ['#10b9ac', '#0f8f86', '#26324a', '#7c2a35', '#b0875c', '#5f4a6e'] as const;

// ── Randomize, default, staff ──

/**
 * Re-roll the outfit and its colours (`roll` makes each press differ yet stays reproducible).
 * Hair, skin, body and accessories stay as they are.
 */
export function randomizeOutfit(appearance: CharacterAppearance, seed: string, roll: number, urls: UrlMap = outfitUrls, pieces: UrlMap = pieceUrls): CharacterAppearance {
  const rollSeed = `${seed}#roll${roll}`;
  const parts = seededOutfitParts(rollSeed, appearance.presentation, pieces);
  if (parts) {
    // Exclude the current pick independently in each slot when another choice exists.
    for (const slot of ['top', 'bottom', 'outer'] as const) {
      const candidates = [...(slot === 'outer' ? ['none'] : []), ...pieceChoices(appearance.presentation, slot, pieces).map(piece => piece.id)]
        .filter(id => id !== appearance.outfitParts?.[slot]);
      const selected = rendezvous(rollSeed, candidates, String, `wardrobe-${slot}`) ?? parts[slot];
      if (selected === undefined) delete parts[slot];
      else parts[slot] = selected;
    }
    const palette = seededPalette(rollSeed, appearance.outfit);
    const next = { ...appearance, outfitParts: parts, topColor: palette.top, bottomColor: palette.bottom, outerColor: palette.outer, accentColor: palette.accent };
    delete next.outfitModel;
    return next;
  }
  const choices = outfitChoices(appearance.presentation, urls).filter(choice => choice.kind === 'model' || EVERYDAY_STYLES.includes(choice.style));
  const current = appearanceChoice(appearance);
  const choice = rendezvous(rollSeed, choices.filter(item => choiceValue(item) !== current), choiceValue) ?? choices[0]!;
  const next = applyOutfitChoice(appearance, choiceValue(choice));
  const palette = seededPalette(rollSeed, next.outfit, next.outfitModel);
  return { ...next, topColor: palette.top, bottomColor: palette.bottom, outerColor: palette.outer, accentColor: palette.accent };
}

/** Back to the generated outfit and colours of `defaults`; hair, skin, body and accessories stay. */
export function defaultOutfit(appearance: CharacterAppearance, defaults: CharacterAppearance): CharacterAppearance {
  const next: CharacterAppearance = { ...appearance, outfit: defaults.outfit, top: defaults.top, bottom: defaults.bottom };
  for (const key of ['outfitModel', 'topColor', 'bottomColor', 'outerColor', 'accentColor'] as const) {
    if (defaults[key] === undefined) delete next[key];
    else next[key] = defaults[key];
  }
  if (defaults.outfitParts === undefined) delete next.outfitParts;
  else next.outfitParts = { ...defaults.outfitParts };
  return next;
}

/**
 * A staff member always wears the role's uniform. From a saved look only the person's own
 * features (hair, skin, body, gait, accessories) and the uniform accent colour carry over.
 */
export function staffAppearance(role: StaffRole, uniform: CharacterAppearance, saved?: CharacterAppearance): CharacterAppearance {
  const base = saved ? { ...saved } : { ...uniform };
  const look: CharacterAppearance = {
    ...base,
    outfit: UNIFORM_STYLES[role], outfitModel: STAFF_UNIFORMS[role], top: uniform.top, bottom: uniform.bottom,
    accessories: { ...base.accessories, badge: true },
  };
  delete look.outfitParts;
  for (const key of ['topColor', 'bottomColor', 'outerColor'] as const) {
    if (uniform[key] === undefined) delete look[key];
    else look[key] = uniform[key];
  }
  const accent = saved?.accentColor ?? uniform.accentColor;
  if (accent === undefined) delete look.accentColor;
  else look.accentColor = accent;
  return look;
}

export function staffRoleOfModel(id: string | undefined): StaffRole | undefined {
  return id ? STAFF_BY_MODEL.get(id) : undefined;
}
