/** Licensed Blender avatars shared by the Office, studio and portraits. */
type UrlMap = Readonly<Record<string, string>>;

/** The original outfit variants share identical geometry; keep one physical GLB per body. */
export function publicBodyAliases(files: UrlMap): UrlMap {
  const urls = { ...files };
  for (const [source, alias] of [
    ['male/office-classic', 'male/business-man'],
    ['female/female-casual', 'female/business-woman'],
  ] as const) {
    const url = files[`/public-assets/avatars/bodies/${source}.glb`];
    if (url) urls[`/public-assets/avatars/bodies/${alias}.glb`] = url;
  }
  return urls;
}

/** Local garment drafts stay outside the character catalog until their exact body/slot/id ships. */
export function reviewedPrivateAvatarFiles(privateFiles: UrlMap, publishedFiles: UrlMap): UrlMap {
  const prefix = '/local-assets/';
  return Object.fromEntries(Object.entries(privateFiles).filter(([path]) =>
    path.startsWith(prefix) && Object.hasOwn(publishedFiles, `/public-assets/${path.slice(prefix.length)}`)));
}

const files = import.meta.glob<string>('/public-assets/avatars/bodies/**/*.glb', { eager: true, query: '?url', import: 'default' });
export const bodyUrls = publicBodyAliases(files);
export const hairUrls = import.meta.glob<string>('/public-assets/avatars/hair/{male,female,shared}/*-detail.glb', { eager: true, query: '?url', import: 'default' });
/** Fitted outfit models (`avatars/outfits/<group>/<id>.glb`): the garment catalog and staff uniforms. */
export const outfitUrls = import.meta.glob<string>('/public-assets/avatars/outfits/{male,female}/*.glb', { eager: true, query: '?url', import: 'default' });

/** Body-fitted, independently wearable garments. */
export const pieceUrls = import.meta.glob<string>('/public-assets/avatars/wardrobe/{male,female}/{top,bottom,outer}/*.glb', { eager: true, query: '?url', import: 'default' });
