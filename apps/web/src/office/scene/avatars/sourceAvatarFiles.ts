import { bodyUrls as publicBodies, hairUrls as publicHair } from './publicAvatarFiles';

/** Private fallback files are reachable only through explicit local-assets development mode. */
const privateBodies = import.meta.glob<string>('/local-assets/avatars/bodies/**/*.glb', { eager: true, query: '?url', import: 'default' });
const privateHair = import.meta.glob<string>('/local-assets/avatars/hair/*/*.glb', { eager: true, query: '?url', import: 'default' });
export const bodyUrls = { ...privateBodies, ...publicBodies };
export const hairUrls = { ...privateHair, ...publicHair };
