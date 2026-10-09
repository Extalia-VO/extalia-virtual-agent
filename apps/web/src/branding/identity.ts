import typeface from './righteous.json';

/**
 * Extalia identity: the `/>` symbol and the Righteous wordmark, drawn from
 * the font's glyph outlines (SIL OFL 1.1, see public/fonts/Righteous-OFL.txt)
 * so the logo needs no web font.
 */
const SYMBOL_OUTLINES: [number, number][][] = [
  [[-0.65, -0.5], [-0.47, -0.5], [-0.15, 0.5], [-0.33, 0.5]],
  [[0.03, 0.5], [0.26, 0.5], [0.76, 0], [0.26, -0.5], [0.03, -0.5], [0.53, 0]],
];

/**
 * The symbol's gradient, from its base to its top, shared with the office's
 * rooftop sign so every rendition of the logo matches.
 */
export const SYMBOL_GRADIENT: readonly (readonly [offset: number, color: string])[] = [
  [0, '#10b9ac'],
  [0.55, '#83cb35'],
  [1, '#f8e719'],
];

const polygonPath = (points: number[][], xOffset = 0, flipY = 1) =>
  points.map(([x = 0, y = 0], index) => `${index ? 'L' : 'M'}${(x + xOffset).toFixed(5)} ${(flipY - y).toFixed(5)}`).join(' ') + ' Z';

export const SYMBOL_PATH = SYMBOL_OUTLINES.map(points => polygonPath(points, 0.65, 0.5)).join(' ');

type Glyph = { width: number; outlines: number[][][]; holes?: number[][][] };
const glyphs = typeface.glyphs as Record<string, Glyph>;

let cursor = 0;
const parts: string[] = [];
for (const character of 'extalia') {
  const glyph = glyphs[character];
  if (!glyph) continue;
  for (const contour of [...glyph.outlines, ...(glyph.holes ?? [])]) parts.push(polygonPath(contour, cursor));
  cursor += glyph.width + 0.14;
}

export const WORDMARK_PATH = parts.join(' ');
export const WORDMARK_WIDTH = cursor - 0.14;
