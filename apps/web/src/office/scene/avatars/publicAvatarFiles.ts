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

const files = import.meta.glob<string>('/public-assets/avatars/bodies/**/*.glb', { eager: true, query: '?url', import: 'default' });
export const bodyUrls = publicBodyAliases(files);
export const hairUrls = import.meta.glob<string>('/public-assets/avatars/hair/{male,female,shared}/*-detail.glb', { eager: true, query: '?url', import: 'default' });
