/** Pure parts of the office loader: progress target, easing, and what-is-loading naming. No React, no three. */
export type OfficeLoadStage = 'engine' | 'scene' | 'ready';
export type LoadCategory = 'characters' | 'hair' | 'clothing' | 'building' | 'furniture' | 'landscape' | 'vehicles' | 'textures' | 'other';

/** Percent the bar may never pass while a stage is the latest one reached. */
export const STAGE_CEILING: Record<OfficeLoadStage, number> = { engine: 20, scene: 95, ready: 100 };
/** Percent the stage starts from. */
export const STAGE_FLOOR: Record<OfficeLoadStage, number> = { engine: 3, scene: 20, ready: 100 };
const SCENE_SPAN = 75;
/** Seconds without a finished file before the bar creeps on its own. */
export const CREEP_AFTER = 1.2;
/** Share of the remaining gap to the ceiling the creep covers per second. */
const CREEP_RATE = 0.03;

/** Real target (percent). Never decreases: the loader's total grows as new loads start. */
export function loadTarget(stage: OfficeLoadStage, loaded: number, total: number, previous: number): number {
  if (stage === 'ready') return 100;
  const real = stage === 'engine' ? STAGE_FLOOR.engine : STAGE_FLOOR.scene + (total > 0 ? SCENE_SPAN * Math.min(1, Math.max(0, loaded / total)) : 0);
  return Math.min(STAGE_CEILING[stage], Math.max(previous, STAGE_FLOOR[stage], real));
}

/** Slow asymptotic creep toward the stage ceiling; never passes it and never goes backwards. */
export function creepTarget(stage: OfficeLoadStage, target: number, dt: number): number {
  const ceiling = STAGE_CEILING[stage];
  if (target >= ceiling) return target;
  return Math.min(ceiling, target + (ceiling - target) * (1 - Math.exp(-CREEP_RATE * dt)));
}

export interface EaseOptions { tau?: number; minSpeed?: number; maxSpeed?: number }
/** Time-based exponential easing (percent). Frame-rate independent, with a speed floor so it lands and a cap so a count passes every integer. */
export function easeStep(displayed: number, target: number, dt: number, { tau = 0.35, minSpeed = 6, maxSpeed = 45 }: EaseOptions = {}): number {
  const gap = target - displayed;
  if (gap <= 0) return displayed;
  const eased = gap * (1 - Math.exp(-dt / tau));
  return displayed + Math.min(gap, Math.min(maxSpeed * dt, Math.max(eased, minSpeed * dt)));
}

/** Drop the Vite content hash (`name-AbCd1234.glb`) and the extension. */
export function stripHash(file: string): string {
  const base = (file.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  return stem.replace(/[-.]([A-Za-z0-9_-]{8})$/, (all, hash: string) => /[0-9A-Z_]/.test(hash) ? '' : all);
}

/** `outfit-victorian-bartender-ab12CD34.glb` → "Victorian bartender". */
export function humanizeName(file: string): string {
  const words = stripHash(file).replace(/^(?:outfit|source|wardrobe|hair|body)[-_]/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export interface CatalogEntry { category: LoadCategory; name: string }
/** Built (hashed) url → category + readable name, from the Vite url maps whose keys keep the source path. */
export function buildUrlIndex(groups: ReadonlyArray<Record<string, string>>): Map<string, CatalogEntry> {
  const index = new Map<string, CatalogEntry>();
  for (const group of groups) for (const [source, url] of Object.entries(group)) index.set(url, { category: categoryOfPath(source), name: humanizeName(source) });
  return index;
}

const IMAGE = /\.(png|jpe?g|webp|avif|ktx2?|hdr|exr|basis|svg)$/i;
/** Category from a source or dev path (directory names survive only there). */
export function categoryOfPath(path: string): LoadCategory {
  const clean = path.split(/[?#]/)[0] ?? '';
  if (IMAGE.test(clean)) return 'textures';
  if (/\/avatars\/bodies\//.test(clean)) return 'characters';
  if (/\/avatars\/hair\//.test(clean)) return 'hair';
  if (/\/avatars\/(outfits|wardrobe)\//.test(clean)) return 'clothing';
  if (/\/(building|architecture|floors)\//.test(clean)) return 'building';
  if (/\/furniture\//.test(clean)) return 'furniture';
  if (/\/landscape\//.test(clean)) return 'landscape';
  if (/\/vehicles\//.test(clean)) return 'vehicles';
  return 'other';
}

/** Index first (built urls), then the path itself (dev urls, data urls excluded). */
export function describeItem(url: string, index: ReadonlyMap<string, CatalogEntry>): CatalogEntry | null {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url ? { category: 'textures', name: '' } : null;
  const clean = url.split(/[?#]/)[0] ?? url;
  const known = index.get(url) ?? index.get(clean);
  if (known) return known;
  const name = humanizeName(clean);
  const byName = [...index.values()].find(entry => entry.name === name);
  return { category: byName?.category ?? categoryOfPath(clean), name };
}
