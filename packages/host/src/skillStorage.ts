import path from 'node:path';

/** Mirrors the daemon's physical layout; SQL/profile approval namespaces are unchanged.
 * Windows keeps its authoritative legacy layout until handle-safe migration is supported.
 */
export function skillStoragePaths(dataDirectory: string, profile = 'default') {
  const legacy = path.join(dataDirectory, 'profiles', profile);
  const global = process.platform !== 'win32' && profile === 'default';
  const root = global ? path.join(dataDirectory, 'skills') : path.join(legacy, 'skills');
  return {
    root,
    objects: path.join(root, 'objects'),
    imports: global ? path.join(root, 'imports') : path.join(legacy, 'skill-imports'),
    market: global ? path.join(root, 'market') : path.join(legacy, 'skill-market'),
  };
}
