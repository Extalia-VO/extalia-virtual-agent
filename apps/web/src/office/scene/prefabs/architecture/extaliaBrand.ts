import { Color, Float32BufferAttribute, type BufferGeometry, type Material, type Shape } from "three";
import { createCodingMarkShapes, createGlyphWordShapes, glyphWordWidth } from "./extrudedGlyphs";

export const EXTALIA_WORD = "extalia";
export const EXTALIA_WORDMARK_STYLE = { typeface: "righteous", tracking: 0.14 } as const;

/**
 * The rooftop sign is the brand reference: the /> mark runs teal → green → yellow
 * from its base to its top. Every rendition (3D, canvas, screens) uses these stops.
 */
export const EXTALIA_MARK_GRADIENT = [
  [0, "#10b9ac"],
  [0.55, "#83cb35"],
  [1, "#f8e719"]
] as const;
/** Light, neutral face colour of the lowercase wordmark. */
export const EXTALIA_WORD_COLOR = "#edf1f5";

const markStops = EXTALIA_MARK_GRADIENT.map(([stop, hex]) => [stop, new Color(hex)] as const);

/** Mark colour at normalised height `t` (0 base … 1 top), interpolated in linear space. */
export function extaliaMarkColor(t: number, target = new Color()) {
  const value = Math.max(0, Math.min(1, t));
  const upper = markStops.findIndex(([stop]) => stop >= value);
  if (upper <= 0) return target.copy(markStops[0]![1]!);
  const [fromStop, from] = markStops[upper - 1]!, [toStop, to] = markStops[upper]!;
  return target.copy(from).lerp(to, (value - fromStop) / (toStop - fromStop));
}

/** Bake the gradient into a vertically centred coding-mark geometry as vertex colours. */
export function applyExtaliaMarkGradient<T extends BufferGeometry>(geometry: T, height: number): T {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const color = new Color();
  for (let i = 0; i < positions.count; i++) {
    extaliaMarkColor(positions.getY(i) / height + 0.5, color).toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Let a vertex-coloured acrylic face emit its own gradient when lit at night. */
export function emitMarkGradient<T extends Material>(material: T): T {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor;\n#endif");
  };
  material.customProgramCacheKey = () => "extalia-coding-gradient-v1";
  return material;
}

export function extaliaBrandLayout(height: number) {
  const wordWidth = glyphWordWidth(EXTALIA_WORD, height, EXTALIA_WORDMARK_STYLE.tracking, EXTALIA_WORDMARK_STYLE.typeface);
  const iconWidth = 1.41 * height * 1.04;
  const gap = height * 0.38;
  return { width: wordWidth + iconWidth + gap, wordX: (iconWidth + gap) / 2, iconX: -(wordWidth + gap) / 2 };
}

export const extaliaBrandWidth = (height: number): number => extaliaBrandLayout(height).width;
type Paint = string | CanvasGradient | CanvasPattern;

/** Canvas version of the mark gradient; canvas y grows downward, so the base is the larger y. */
export function extaliaMarkCanvasGradient(ctx: CanvasRenderingContext2D, centerY: number, markHeight: number) {
  const gradient = ctx.createLinearGradient(0, centerY + markHeight / 2, 0, centerY - markHeight / 2);
  for (const [stop, hex] of EXTALIA_MARK_GRADIENT) gradient.addColorStop(stop, hex);
  return gradient;
}

/** Draw the same local font outlines used by the 3D signage, including counters. */
export function drawExtaliaBrand(ctx: CanvasRenderingContext2D, options: {
  centerX: number; centerY: number; height: number; maxWidth?: number; wordColor?: Paint; iconColor?: Paint;
}) {
  const height = Math.min(options.height, (options.maxWidth ?? Infinity) / extaliaBrandWidth(1));
  const layout = extaliaBrandLayout(height);
  const draw = (shapes: Shape[], offset: number, color: Paint) => {
    ctx.fillStyle = color;
    for (const shape of shapes) {
      ctx.beginPath();
      for (const path of [shape, ...shape.holes]) {
        path.getPoints().forEach((point, index) => {
          const x = options.centerX + offset + point.x;
          const y = options.centerY - point.y;
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
  };
  ctx.save();
  draw(createCodingMarkShapes(height * 1.04), layout.iconX,
    options.iconColor ?? extaliaMarkCanvasGradient(ctx, options.centerY, height * 1.04));
  draw(createGlyphWordShapes(EXTALIA_WORD, { ...EXTALIA_WORDMARK_STYLE, size: height }), layout.wordX, options.wordColor ?? EXTALIA_WORD_COLOR);
  ctx.restore();
}
