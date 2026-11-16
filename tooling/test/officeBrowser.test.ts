import { afterEach, describe, expect, it, vi } from 'vitest';
import { officeBrowserArgs, officeRendererInfo } from '../bench/office-browser.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('Office benchmark browser policy', () => {
  it('uses Metal only on macOS and preserves the native blocklist by default', () => {
    expect(officeBrowserArgs('darwin')).toContain('--use-angle=metal');
    for (const platform of ['win32', 'linux']) expect(officeBrowserArgs(platform)).not.toContain('--use-angle=metal');
    expect(officeBrowserArgs('darwin')).not.toContain('--ignore-gpu-blocklist');
  });
  it('requires an explicit valid policy to override the blocklist', () => {
    expect(officeBrowserArgs('linux', 'ignore-blocklist')).toContain('--ignore-gpu-blocklist');
    expect(() => officeBrowserArgs('linux', 'invalid')).toThrow('Invalid --gpu-policy');
  });
  it('does not invent a renderer when no QA scene is ready', () => {
    vi.stubGlobal('window', {});
    expect(officeRendererInfo()).toBeNull();
  });
  it.each([['ANGLE (SwiftShader Device)', true], ['ANGLE (Apple GPU)', false], [null, null]])(
    'reports the actual renderer string and cautious software hint: %s', (name, softwareHint) => {
      const values: Record<string, unknown> = { version: 'WebGL 2.0', vendor: 'WebKit', renderer: 'WebKit WebGL', unmaskedRenderer: name, unmaskedVendor: 'ANGLE' };
      vi.stubGlobal('window', { devicePixelRatio: 2, __EXTALIA_BENCH__: { renderer: {
        getContext: () => ({
          VERSION: 'version', VENDOR: 'vendor', RENDERER: 'renderer', drawingBufferWidth: 800, drawingBufferHeight: 600,
          getExtension: () => name === null ? null : { UNMASKED_RENDERER_WEBGL: 'unmaskedRenderer', UNMASKED_VENDOR_WEBGL: 'unmaskedVendor' },
          getParameter: (key: string) => values[key], getContextAttributes: () => ({ antialias: false }),
        }),
        getPixelRatio: () => 1, domElement: { getAttribute: () => 'three.js' },
      } } });
      expect(officeRendererInfo()).toMatchObject({ unmaskedRenderer: name, softwareRendererHint: softwareHint,
        pixelRatio: 1, nativeDpr: 2, drawingBuffer: { width: 800, height: 600 } });
    },
  );
});
