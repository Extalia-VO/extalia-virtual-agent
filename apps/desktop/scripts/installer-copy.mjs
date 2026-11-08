/** The installer shares the app's text catalog, while remaining English on every OS. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

let cached;
let brand;
export function installerCopy() {
  return cached ??= (async () => {
    // Type-only app imports disappear and unused UI translations are tree-shaken. This also
    // works on the supported Node 22 versions which cannot directly import TypeScript.
    const result = await build({
      stdin: { contents: 'export { INSTALLER_COPY } from "../../web/src/i18n.ts";', resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
      bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    return Object.freeze({ ...module.INSTALLER_COPY });
  })();
}

export function installerBrand() {
  return brand ??= (async () => {
    const result = await build({ stdin: { contents: 'export { SYMBOL_PATH, SYMBOL_GRADIENT, WORDMARK_PATH, WORDMARK_WIDTH } from "../../web/src/branding/identity.ts";',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    return { symbol: module.SYMBOL_PATH, gradient: module.SYMBOL_GRADIENT, wordmark: module.WORDMARK_PATH, width: module.WORDMARK_WIDTH };
  })();
}

export async function installerPhotos() {
  return Promise.all(['building', 'workspace', 'collaboration'].map(async view => ({
    name: `office-${view}.jpg`,
    data: `data:image/jpeg;base64,${(await readFile(new URL(`../installer/office/office-${view}.jpg`, import.meta.url))).toString('base64')}`,
  })));
}
