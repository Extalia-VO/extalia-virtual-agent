/**
 * Who wears what: the allocation of generated looks among the characters visible in the Office.
 * Renderer-independent (no three.js) and deterministic for a given roster and salt.
 *
 * Rules (owner requirements):
 * - Casual clothing is unique among the visible characters. Formal clothing (staff uniforms, suits,
 *   evening wear; see `DRESS_CODE`) may be shared.
 * - Only generated looks (characters without a saved appearance) are allocated. A saved look always
 *   wins and is never changed, but its casual items count as taken. A character's casual look is
 *   "taken" by a complete outfit model as a whole, or by its fitted top and its fitted outer layer
 *   (outer `none` is not exclusive; bottoms may repeat).
 * - Generated hair is drawn from the detailed GLB hair of the character's gender group, unique
 *   among the visible characters while the pool lasts, and re-rolled between Office sessions by a
 *   per-session random salt. Outfits do not depend on the salt.
 *
 * Algorithm: characters are processed in a stable order (sorted by look seed). Each ranks the
 * casual candidates by highest-random-weight hashing of its seed (its stable preference order) and
 * takes the first one nobody holds. When the casual pool of its gender group is exhausted it wears a
 * formal outfit instead (the least worn one first), and, when the group has no formal outfit at all,
 * a staff uniform; with no catalog at all it keeps the body's own outfit. Characters that were
 * already allocated in this session keep their look when still valid (`previous`), so a character
 * who joins or leaves never changes what the others wear; a fresh roster is a pure greedy pass.
 */
import type { CharacterAppearance, CharacterHairStyle, CharacterOutfitParts, CharacterPresentation } from '@extalia/core';
import { detailedHairStyles, glbHairStyle } from './hairCatalog';
import { dressCode, outfitModels, pieceChoices, presentationGroup, type OutfitGroup } from './outfitCatalog';
import { humanoidInstanceSeed } from './rig';
import { outfitUrls, pieceUrls } from './sourceAvatarFiles';

type UrlMap = Readonly<Record<string, string>>;

export interface LookRosterEntry {
  /** Presence id (informational). */
  id: string;
  /** The seed the look is generated from (`lookSeed`): one generated look per seed. */
  seed: string;
  presentation: CharacterPresentation;
  /** A saved (or locked staff) look: never changed; its casual items and hair count as taken. */
  saved?: CharacterAppearance | undefined;
}

export interface GeneratedLook {
  presentation: CharacterPresentation;
  outfitModel?: string;
  outfitParts?: CharacterOutfitParts;
  hairStyle: CharacterHairStyle;
  /** Wears formal clothing (shareable) rather than a unique casual look. */
  formal: boolean;
}

export interface AllocationOptions {
  outfits?: UrlMap;
  pieces?: UrlMap;
  /** Earlier allocation of this session; still-valid looks are kept. */
  previous?: ReadonlyMap<string, GeneratedLook> | undefined;
}

function ranked<T>(seed: string, candidates: readonly T[], key: (item: T) => string, namespace: string): T[] {
  return candidates.map(item => ({ item, k: key(item), score: humanoidInstanceSeed(`${seed}|${key(item)}`, namespace) }))
    .sort((a, b) => b.score - a.score || (a.k < b.k ? -1 : 1)).map(entry => entry.item);
}

const modelKey = (group: OutfitGroup, id: string) => `${group}/model/${id}`;
const pieceKey = (group: OutfitGroup, slot: 'top' | 'outer', id: string) => `${group}/${slot}/${id}`;
const PRESENTATION_OF: Readonly<Record<OutfitGroup, CharacterPresentation>> = { female: 'feminine', male: 'masculine' };

interface GroupCatalog { casualModels: string[]; formalModels: string[]; uniforms: string[]; tops: string[]; outers: string[]; bottoms: string[] }

function groupCatalog(group: OutfitGroup, outfits: UrlMap, pieces: UrlMap): GroupCatalog {
  const models = outfitModels(outfits).filter(model => model.group === group);
  const presentation = PRESENTATION_OF[group];
  return {
    casualModels: models.filter(model => !model.staff && dressCode(model.id) === 'casual').map(model => model.id),
    formalModels: models.filter(model => !model.staff && dressCode(model.id) === 'formal').map(model => model.id),
    uniforms: models.filter(model => model.staff).map(model => model.id),
    tops: pieceChoices(presentation, 'top', pieces).map(piece => piece.id),
    outers: pieceChoices(presentation, 'outer', pieces).map(piece => piece.id),
    bottoms: pieceChoices(presentation, 'bottom', pieces).map(piece => piece.id),
  };
}

/** Casual items a saved look holds. */
function casualKeys(look: CharacterAppearance): string[] {
  const group = presentationGroup(look.presentation), keys: string[] = [];
  if (look.outfitModel && dressCode(look.outfitModel) === 'casual') keys.push(modelKey(group, look.outfitModel));
  const parts = look.outfitParts;
  if (parts?.top && dressCode(parts.top) === 'casual') keys.push(pieceKey(group, 'top', parts.top));
  if (parts?.outer && parts.outer !== 'none' && dressCode(parts.outer) === 'casual') keys.push(pieceKey(group, 'outer', parts.outer));
  return keys;
}

let catalogOverride: { outfits?: UrlMap; pieces?: UrlMap } | undefined;

/** Tests: allocate from another file catalog than the bundled one (`undefined` restores it). */
export function setLookCatalog(catalog: { outfits?: UrlMap; pieces?: UrlMap } | undefined): void {
  catalogOverride = catalog; standalone.clear(); allocation = new Map(); signature = ''; version++;
}

/** Allocate generated looks to the entries without a saved look; the result is keyed by seed. */
export function allocateGeneratedLooks(characters: readonly LookRosterEntry[], salt: string, options: AllocationOptions = {}): Map<string, GeneratedLook> {
  const outfits = options.outfits ?? catalogOverride?.outfits ?? outfitUrls, pieces = options.pieces ?? catalogOverride?.pieces ?? pieceUrls;
  const catalogs = new Map<OutfitGroup, GroupCatalog>();
  const catalog = (group: OutfitGroup) => {
    let found = catalogs.get(group);
    if (!found) { found = groupCatalog(group, outfits, pieces); catalogs.set(group, found); }
    return found;
  };
  const takenCasual = new Set<string>(), hairUse = new Map<string, number>(), formalUse = new Map<string, number>();
  const countHair = (style: string) => hairUse.set(style, (hairUse.get(style) ?? 0) + 1);
  const result = new Map<string, GeneratedLook>();

  // Saved looks win and hold their items.
  for (const entry of characters) {
    if (!entry.saved) continue;
    for (const key of casualKeys(entry.saved)) takenCasual.add(key);
    countHair(glbHairStyle(entry.saved.hairStyle, entry.saved.presentation));
  }
  const seen = new Set<string>();
  const generated = characters.filter(entry => !entry.saved).filter(entry => !seen.has(entry.seed) && seen.add(entry.seed))
    .sort((a, b) => a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0);

  const hold = (group: OutfitGroup, look: GeneratedLook) => {
    if (look.outfitModel) {
      if (look.formal) formalUse.set(modelKey(group, look.outfitModel), (formalUse.get(modelKey(group, look.outfitModel)) ?? 0) + 1);
      else takenCasual.add(modelKey(group, look.outfitModel));
    }
    if (look.outfitParts?.top) takenCasual.add(pieceKey(group, 'top', look.outfitParts.top));
    if (look.outfitParts?.outer && look.outfitParts.outer !== 'none') takenCasual.add(pieceKey(group, 'outer', look.outfitParts.outer));
  };

  // Sticky pass: a look held earlier in this session stays while still valid (outfit and hair independently).
  const kept = new Map<string, { outfit?: Omit<GeneratedLook, 'hairStyle'>; hair?: CharacterHairStyle }>();
  for (const entry of generated) {
    const before = options.previous?.get(entry.seed);
    if (!before || before.presentation !== entry.presentation) continue;
    const group = presentationGroup(entry.presentation), cat = catalog(group);
    const keep: { outfit?: Omit<GeneratedLook, 'hairStyle'>; hair?: CharacterHairStyle } = {};
    const { hairStyle, ...outfit } = before;
    const keys: string[] = [];
    let valid = false;
    if (before.outfitModel) {
      valid = before.formal ? [...cat.formalModels, ...cat.uniforms].includes(before.outfitModel) : cat.casualModels.includes(before.outfitModel);
      if (valid && !before.formal) keys.push(modelKey(group, before.outfitModel));
    } else if (before.outfitParts) {
      const { top, outer } = before.outfitParts;
      valid = (top === undefined || cat.tops.includes(top)) && (outer === undefined || outer === 'none' || cat.outers.includes(outer));
      if (top) keys.push(pieceKey(group, 'top', top));
      if (outer && outer !== 'none') keys.push(pieceKey(group, 'outer', outer));
    }
    if (valid && keys.every(key => !takenCasual.has(key))) { keep.outfit = outfit; hold(group, before); }
    if (detailedHairStyles(entry.presentation).includes(hairStyle) && !hairUse.has(hairStyle)) { keep.hair = hairStyle; countHair(hairStyle); }
    kept.set(entry.seed, keep);
  }

  for (const entry of generated) {
    const group = presentationGroup(entry.presentation), cat = catalog(group), keep = kept.get(entry.seed);
    let outfit = keep?.outfit;
    if (!outfit) {
      outfit = chooseOutfit(entry.seed, group, cat, takenCasual, formalUse);
      hold(group, { ...outfit, hairStyle: 'bob' });
    }
    let hairStyle = keep?.hair;
    if (!hairStyle) {
      const pool = ranked(`${entry.seed}|${salt}`, detailedHairStyles(entry.presentation), String, 'hair');
      const fewest = Math.min(...pool.map(style => hairUse.get(style) ?? 0));
      hairStyle = pool.find(style => (hairUse.get(style) ?? 0) === fewest) ?? (entry.presentation === 'feminine' ? 'bob' : 'side-part');
      countHair(hairStyle);
    }
    result.set(entry.seed, { ...outfit, hairStyle });
  }
  return result;
}

function chooseOutfit(seed: string, group: OutfitGroup, cat: GroupCatalog, taken: ReadonlySet<string>, formalUse: ReadonlyMap<string, number>): Omit<GeneratedLook, 'hairStyle'> {
  const presentation = PRESENTATION_OF[group];
  type Candidate = { rank: string; model?: string; top?: string; bare?: true };
  const candidates: Candidate[] = [
    ...cat.casualModels.map(id => ({ rank: `model:${id}`, model: id })),
    ...(cat.tops.length ? cat.tops.map(id => ({ rank: `top:${id}`, top: id }))
      : cat.outers.length || cat.bottoms.length ? [{ rank: 'top:none', bare: true as const }] : []),
  ];
  for (const candidate of ranked(seed, candidates, item => item.rank, 'casual-look')) {
    if (candidate.model !== undefined) {
      if (taken.has(modelKey(group, candidate.model))) continue;
      return { presentation, outfitModel: candidate.model, formal: false };
    }
    if (candidate.top !== undefined && taken.has(pieceKey(group, 'top', candidate.top))) continue;
    // Outer layer: the first of the character's own order that nobody holds; "none" is never exclusive.
    const outer = ranked(seed, ['none', ...cat.outers.filter(id => !taken.has(pieceKey(group, 'outer', id)))], String, 'wardrobe-outer')[0]!;
    const bottom = ranked(seed, cat.bottoms, String, 'wardrobe-bottom')[0];
    return {
      presentation, formal: false,
      outfitParts: { ...(candidate.top !== undefined ? { top: candidate.top } : {}), ...(bottom ? { bottom } : {}), outer },
    };
  }
  // Casual pool exhausted: formal clothing may be shared (least worn first), staff uniforms as the last resort.
  for (const pool of [cat.formalModels, cat.uniforms]) {
    if (!pool.length) continue;
    const order = ranked(seed, pool, String, 'formal-look');
    const least = Math.min(...order.map(id => formalUse.get(modelKey(group, id)) ?? 0));
    const id = order.find(item => (formalUse.get(modelKey(group, item)) ?? 0) === least)!;
    return { presentation, outfitModel: id, formal: true };
  }
  // No catalog at all: the body's own outfit.
  return { presentation, formal: true };
}

// ── Session store ──

function randomSalt(): string {
  try {
    const words = crypto.getRandomValues(new Uint32Array(2));
    return `${words[0]!.toString(36)}${words[1]!.toString(36)}`;
  } catch { return Math.random().toString(36).slice(2, 12); }
}

let salt: string | undefined;
let allocation: ReadonlyMap<string, GeneratedLook> = new Map();
let signature = '';
let version = 0;
const listeners = new Set<() => void>();
const standalone = new Map<string, GeneratedLook>();

/** Per-session random salt for generated hair: new on every page load, kept in memory only. */
export function lookSalt(): string { return salt ??= randomSalt(); }

/** Replace the salt (tests, or a deliberate re-roll) and forget earlier allocations. */
export function setLookSalt(next: string | undefined): void {
  salt = next; standalone.clear(); allocation = new Map(); signature = ''; version++;
}

const savedSignature = (saved: CharacterAppearance | undefined) => saved
  ? JSON.stringify([saved.presentation, saved.outfitModel, saved.outfitParts?.top, saved.outfitParts?.outer, saved.hairStyle]) : '';

/** Publish the characters now visible in the Office; returns whether the allocation changed. */
export function setLookRoster(entries: readonly LookRosterEntry[]): boolean {
  const next = entries.map(entry => `${entry.seed}\u0000${entry.presentation}\u0000${savedSignature(entry.saved)}`).sort().join('\u0001');
  if (next === signature) return false;
  signature = next;
  allocation = allocateGeneratedLooks(entries, lookSalt(), { previous: allocation });
  version++;
  return true;
}

export function lookVersion(): number { return version; }
export function subscribeLooks(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notifyLookChange(): void { for (const listener of [...listeners]) listener(); }

/** The generated look of a seed: the roster's allocation, or (not visible) its own first choices. */
export function generatedLookOf(seed: string, presentation: CharacterPresentation): GeneratedLook {
  const rostered = allocation.get(seed);
  if (rostered?.presentation === presentation) return rostered;
  const key = `${lookSalt()}|${presentation}|${seed}`;
  let alone = standalone.get(key);
  if (!alone) {
    if (standalone.size > 1000) standalone.clear();
    alone = allocateGeneratedLooks([{ id: seed, seed, presentation }], lookSalt()).get(seed)!;
    standalone.set(key, alone);
  }
  return alone;
}

/** Re-roll the hair among the detailed GLB styles of the look's group (never the current one); `roll` makes each press differ. */
export function randomizeHair(appearance: CharacterAppearance, seed: string, roll: number): CharacterAppearance {
  const current = glbHairStyle(appearance.hairStyle, appearance.presentation);
  const pool = detailedHairStyles(appearance.presentation).filter(style => style !== current);
  const pick = ranked(`${seed}|${lookSalt()}#hair${roll}`, pool, String, 'hair-roll')[0];
  return pick ? { ...appearance, hairStyle: pick } : appearance;
}
