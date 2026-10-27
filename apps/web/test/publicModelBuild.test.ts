import { build, type ConfigEnv, type UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';
import { bodyUrls, hairUrls } from '../src/office/scene/avatars/publicAvatarFiles';

function webConfig(command: ConfigEnv['command'], mode: string): UserConfig {
  if (typeof config !== 'function') throw new Error('Expected the web configuration factory.');
  const result = config({ command, mode });
  if (result instanceof Promise) throw new Error('Expected a synchronous web configuration.');
  return result;
}

function avatarAlias(options: UserConfig): string | undefined {
  const aliases = options.resolve?.alias;
  if (!Array.isArray(aliases)) return undefined;
  return aliases.find(alias => alias.find instanceof RegExp && alias.find.test('./sourceAvatarFiles'))?.replacement;
}

describe('public model build boundary', () => {
  it('uses public Blender avatar files in builds and ordinary development even with private files installed', () => {
    expect(Object.keys(bodyUrls).every(path => path.startsWith('/public-assets/avatars/bodies/'))).toBe(true);
    expect(Object.keys(hairUrls).every(path => path.startsWith('/public-assets/avatars/hair/'))).toBe(true);
    for (const [command, mode] of [['build', 'production'], ['build', 'development'], ['serve', 'development']] as const) {
      expect(avatarAlias(webConfig(command, mode))).toMatch(/[\\/]avatars[\\/]publicAvatarFiles\.ts$/);
    }
    expect(avatarAlias(webConfig('serve', 'local-assets'))).toBeUndefined();
    expect(() => webConfig('build', 'local-assets')).toThrow('development server only');
  });

  it('never visits the private avatar module while bundling real avatar selection code', async () => {
    const options = webConfig('build', 'production');
    const publicFile = avatarAlias(options)!;
    const sourceFile = publicFile.replace('publicAvatarFiles.ts', 'sourceAssets.ts');
    let privateModuleVisited = false;
    const result = await build({
      root: publicFile.replace(/[\\/]src[\\/].*$/, ''),
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      resolve: options.resolve,
      plugins: [{
        name: 'avatar-boundary-fixture',
        resolveId(id) { if (id === 'virtual:avatar-boundary') return '\0avatar-boundary'; },
        load(id) {
          if (id.endsWith('/sourceAvatarFiles.ts')) {
            privateModuleVisited = true;
            throw new Error('A public build reached private avatar files.');
          }
          if (id === '\0avatar-boundary') return `export { bodyAssetUrl, sourceAvatarUrls, localHairStyles } from ${JSON.stringify(sourceFile)};`;
        },
      }],
      build: { write: false, minify: false, rollupOptions: { input: 'virtual:avatar-boundary', preserveEntrySignatures: 'strict' } },
    });
    expect(privateModuleVisited).toBe(false);
    const bundles = Array.isArray(result) ? result : [result];
    const outputs = bundles.flatMap(bundle => 'output' in bundle ? bundle.output : []);
    expect(outputs.some(item => item.type === 'chunk' && item.code.includes('function sourceAvatarUrls'))).toBe(true);
    const assets = outputs.filter(item => item.type === 'asset');
    expect(assets).toHaveLength(12);
    expect(assets.every(item => item.fileName.endsWith('.glb'))).toBe(true);
    expect(assets.filter(item => /\/(?:office-classic|female-casual)-/.test(item.fileName))).toHaveLength(2);
    expect(assets.filter(item => /-detail-/.test(item.fileName))).toHaveLength(10);
    expect(assets.some(item => /\/(?:business-man|business-woman)-/.test(item.fileName))).toBe(false);
    expect(outputs.some(item => item.type === 'chunk' && Object.keys(item.modules).some(id => id.endsWith('/publicAvatarFiles.ts')))).toBe(true);
    expect(outputs.some(item => item.type === 'chunk' && Object.keys(item.modules).some(id => id.endsWith('/sourceAvatarFiles.ts')))).toBe(false);
  });

  it('keeps even small GLBs and the existing fonts as standalone files', () => {
    const inlineLimit = webConfig('build', 'production').build?.assetsInlineLimit;
    if (typeof inlineLimit !== 'function') throw new Error('Expected the asset inline policy.');
    const content = new Uint8Array(0) as Parameters<typeof inlineLimit>[1];
    for (const file of ['floor-panel.glb', 'inter.woff2', 'geist.ttf', 'display.otf']) {
      expect(inlineLimit(file, content)).toBe(false);
    }
    expect(inlineLimit('icon.svg', content)).toBeUndefined();
  });
});
