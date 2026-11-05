import { buildUrlIndex } from './loadProgress';

const glob = (pattern: Record<string, string>) => pattern;
/** Same files the scene loads; built urls are hashed, so they are matched through these maps. Url strings only, no three. */
export const loadIndex = buildUrlIndex([
  glob(import.meta.glob<string>('/public-assets/avatars/**/*.glb', { eager: true, query: '?url', import: 'default' })),
  glob(import.meta.glob<string>('/public-assets/{building,architecture,floors,furniture,landscape,vehicles}/*.glb', { eager: true, query: '?url', import: 'default' })),
]);
