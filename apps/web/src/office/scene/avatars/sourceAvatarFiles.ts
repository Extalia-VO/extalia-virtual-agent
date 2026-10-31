import { bodyUrls as publicBodies, hairUrls as publicHair, outfitUrls as publicOutfits, pieceUrls as publicPieces, reviewedPrivateAvatarFiles } from './publicAvatarFiles';
import { reviewedSourceGarments } from './reviewedSourceGarments';

/** Private fallback files are reachable only through explicit local-assets development mode. */
const privateBodies = import.meta.glob<string>('/local-assets/avatars/bodies/**/*.glb', { eager: true, query: '?url', import: 'default' });
const privateHair = import.meta.glob<string>('/local-assets/avatars/hair/*/*.glb', { eager: true, query: '?url', import: 'default' });
export const bodyUrls = { ...privateBodies, ...publicBodies };
export const hairUrls = { ...privateHair, ...publicHair };
const privateOutfits = import.meta.glob<string>('/local-assets/avatars/outfits/{male,female}/*.glb', { eager: true, query: '?url', import: 'default' });
const privatePieces = import.meta.glob<string>('/local-assets/avatars/wardrobe/{male,female}/{top,bottom,outer}/*.glb', { eager: true, query: '?url', import: 'default' });
const manifests = import.meta.glob<unknown>('/local-assets/avatars/reviewed-source-garments.json', { eager: true, import: 'default' });
const reviewed = reviewedSourceGarments(manifests['/local-assets/avatars/reviewed-source-garments.json'], { ...privateOutfits, ...privatePieces });
// Raw fitting experiments stay available to Blender, never to characters (including local mode).
const reviewedPrivateOutfits = reviewedPrivateAvatarFiles(privateOutfits, publicOutfits);
export const outfitUrls = { ...reviewedPrivateOutfits, ...reviewed.outfits, ...publicOutfits };

export const pieceUrls = { ...reviewedPrivateAvatarFiles(privatePieces, publicPieces), ...reviewed.pieces, ...publicPieces };
