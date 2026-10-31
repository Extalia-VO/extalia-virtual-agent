import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, type Object3D } from 'three';
import { officeInteriorText, type Language } from '../../../../../i18n';
import { ScreenTextureCache, type TextureConsumer, type TextureHost } from './screenTextureCache';
import { DESIGN_WIDTH, type SurfaceSpec } from './screenContent';
import { paintScreen } from './screenPainters';
import { measureScreenPixels } from './screenPhotometry';

/** A canvas plus its GPU texture and the photometry of what is currently painted on it. */
export interface ScreenSurface {
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  /** Average linear luminance (0..1) and peak-normalised colour of the current frame. */
  luminance: number;
  color: readonly [number, number, number];
  version: number;
}

export interface ScreenConsumer extends TextureConsumer<ScreenSurface> {
  group: Object3D;
}

let sampler: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function sampleContext() {
  if (sampler) return sampler;
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 9;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  sampler = { canvas, ctx };
  return sampler;
}

const host: TextureHost<ScreenSurface, SurfaceSpec> = {
  create(spec) {
    const canvas = document.createElement('canvas');
    canvas.width = spec.pixelWidth; canvas.height = spec.pixelHeight;
    // A CPU-backed 2D canvas: every paint is sampled for photometry (drawImage + getImageData below), and
    // reading back a GPU-accelerated canvas stalled the WebGL frame on each repaint.
    canvas.getContext('2d', { willReadFrequently: true });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    // Screens are tiny in the overview: mip-mapping keeps them from shimmering while the camera moves.
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    return { canvas, texture, luminance: 0, color: [0, 0, 0], version: 0 };
  },
  paint(surface, spec, _now, frame) {
    const ctx = surface.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(spec.pixelWidth / DESIGN_WIDTH, 0, 0, spec.pixelHeight / spec.designHeight, 0, 0);
    paintScreen(ctx, spec, frame, Date.now(), text => officeInteriorText(spec.language as Language, text));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.texture.needsUpdate = true;
    const probe = sampleContext();
    if (probe) {
      probe.ctx.drawImage(surface.canvas, 0, 0, 16, 9);
      const measured = measureScreenPixels(probe.ctx.getImageData(0, 0, 16, 9).data);
      surface.luminance = measured.luminance; surface.color = measured.color;
    }
    surface.version++;
  },
  dispose(surface) { surface.texture.dispose(); },
};

/** One cache for the whole scene: screens with the same content share a surface. */
export const screenTextures = new ScreenTextureCache<ScreenSurface, SurfaceSpec, ScreenConsumer>(host, { budgetPerTick: 8, minIntervalMs: 500, graceMs: 8000 });
