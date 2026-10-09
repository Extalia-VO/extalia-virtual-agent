/**
 * electron-builder `beforeBuild` hook. Returning false tells electron-builder that
 * node_modules are handled elsewhere: esbuild already bundled every runtime
 * dependency into dist/*.cjs, so nothing is installed, rebuilt or copied.
 */
export default async function beforeBuild() {
  return false;
}
