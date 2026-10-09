import righteousTypeface from "../assets/fonts/extalia-righteous.json";

export const EXTALIA_CAPTION = "Virtual Agent";
export const EXTALIA_CODING_OUTLINES: [number, number][][] = [
  [[-0.65, -0.5], [-0.47, -0.5], [-0.15, 0.5], [-0.33, 0.5]] as const,
  [[0.03, 0.5], [0.26, 0.5], [0.76, 0], [0.26, -0.5], [0.03, -0.5], [0.53, 0]] as const
] as const;

const polygonPath = (points: number[][], xOffset = 0, flipY = 1) =>
  points.map(([x, y], index) => `${index ? "L" : "M"}${(x! + xOffset).toFixed(5)} ${(flipY - y!).toFixed(5)}`).join(" ") + " Z";

export const EXTALIA_CODING_SVG_PATH = EXTALIA_CODING_OUTLINES.map(points => polygonPath(points, 0.65, 0.5)).join(" ");

// Use the exact local Righteous outlines and spacing already used on the building.
let cursor = 0;
const wordParts: string[] = [];
for (const character of "extalia") {
  const glyph = righteousTypeface.glyphs[character as keyof typeof righteousTypeface.glyphs]!;
  for (const contour of [...glyph.outlines, ...("holes" in glyph ? glyph.holes : [])]) {
    wordParts.push(polygonPath(contour, cursor));
  }
  cursor += glyph.width + 0.14;
}
export const EXTALIA_WORDMARK_SVG_PATH = wordParts.join(" ");
export const EXTALIA_WORDMARK_WIDTH = cursor - 0.14;
