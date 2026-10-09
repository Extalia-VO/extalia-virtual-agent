import { ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import corporateTypeface from "../../assets/fonts/extalia-inter-semibold.json";
import righteousTypeface from "../../assets/fonts/extalia-righteous.json";
import { EXTALIA_CODING_OUTLINES } from "../../branding/extaliaIdentity";

/**
 * Local outline glyphs for Extalia signage. Each glyph is a set of
 * closed outlines in a 1-unit-tall em box; holes are listed separately.
 * Building geometry from shapes avoids fetching fonts and keeps the
 * whole word in a single ExtrudeGeometry (one draw call per material).
 */
type Pt = [number, number];
interface Glyph {
  width: number;
  outlines: Pt[][];
  holes?: Pt[][];
}

const S = 0.18; // stroke

const GLYPHS: Record<string, Glyph> = {
  E: {
    width: 0.68,
    outlines: [[
      [0, 0], [0.68, 0], [0.68, S], [S, S], [S, 0.41], [0.58, 0.41], [0.58, 0.59],
      [S, 0.59], [S, 1 - S], [0.68, 1 - S], [0.68, 1], [0, 1]
    ] as const] as const
  },
  X: {
    width: 0.76,
    outlines: [
      [[0, 0], [0.21, 0], [0.76, 1], [0.55, 1]] as const,
      [[0.55, 0], [0.76, 0], [0.21, 1], [0, 1]] as const
    ] as const
  },
  T: {
    width: 0.72,
    outlines: [[
      [0.27, 0], [0.45, 0], [0.45, 1 - S], [0.72, 1 - S], [0.72, 1], [0, 1], [0, 1 - S], [0.27, 1 - S]
    ] as const] as const
  },
  A: {
    width: 0.8,
    outlines: [[
      [0, 0], [0.2, 0], [0.265, 0.26], [0.535, 0.26], [0.6, 0], [0.8, 0], [0.5, 1], [0.3, 1]
    ] as const] as const,
    holes: [[[0.31, 0.42], [0.4, 0.76], [0.49, 0.42]] as const] as const
  },
  L: {
    width: 0.62,
    outlines: [[[0, 0], [0.62, 0], [0.62, S], [S, S], [S, 1], [0, 1]] as const] as const
  },
  I: {
    width: S,
    outlines: [[[0, 0], [S, 0], [S, 1], [0, 1]] as const] as const
  }
};

// Local, cap-height-normalized Inter SemiBold outlines; no font fetch at runtime.
const contourPoints = (contours: number[][][]): Pt[][] =>
  contours.map(contour => contour.map(([x = 0, y = 0]): Pt => [x, y]));
const CORPORATE_GLYPHS: Record<string, Glyph> = Object.fromEntries(
  Object.entries(corporateTypeface.glyphs).map(([char, glyph]) => [char, {
    width: glyph.width,
    outlines: contourPoints(glyph.outlines),
    holes: "holes" in glyph ? contourPoints(glyph.holes) : undefined
  }])
);
const RIGHTEOUS_GLYPHS: Record<string, Glyph> = Object.fromEntries(
  Object.entries(righteousTypeface.glyphs).map(([char, glyph]) => [char, {
    width: glyph.width,
    outlines: contourPoints(glyph.outlines),
    holes: "holes" in glyph ? contourPoints(glyph.holes) : undefined
  }])
);
type WordTypeface = "block" | "corporate" | "righteous";

function wordGlyphs(text: string, typeface: WordTypeface): Glyph[] {
  const glyphs = typeface === "righteous" ? RIGHTEOUS_GLYPHS : typeface === "corporate" ? CORPORATE_GLYPHS : GLYPHS;
  const word = typeface === "righteous" ? text : text.toUpperCase();
  return [...word].map((char) => glyphs[char]!).filter(Boolean);
}

export interface GlyphWordOptions {
  /** Glyph height unit in metres. */
  size: number;
  /** Extrusion depth in metres. */
  depth: number;
  /** Letter spacing as a fraction of size. */
  tracking?: number;
  bevel?: number;
  /** Local font subsets; Righteous preserves lowercase, block keeps interior signage. */
  typeface?: WordTypeface;
}

/** Returns a centred (x, y) extruded word; front face points +Z at z = depth. */
export function createGlyphWordShapes(text: string, options: Pick<GlyphWordOptions, "size" | "tracking" | "typeface">): Shape[] {
  const { size, tracking = 0.16, typeface = "block" } = options;
  const shapes: Shape[] = [];
  let cursor = 0;
  const glyphs = wordGlyphs(text, typeface);
  const total = glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + tracking * Math.max(0, glyphs.length - 1);
  const originX = -total / 2;

  for (const glyph of glyphs) {
    for (const outline of glyph.outlines) {
      const shape = new Shape(outline.map(([x, y]) => ({ x: (originX + cursor + x) * size, y: (y - 0.5) * size }) as never));
      for (const hole of glyph.holes ?? []) {
        shape.holes.push(new Path(hole.map(([x, y]) => ({ x: (originX + cursor + x) * size, y: (y - 0.5) * size }) as never)));
      }
      shapes.push(shape);
    }
    cursor += glyph.width + tracking;
  }

  return shapes;
}

export function createGlyphWordGeometry(text: string, options: GlyphWordOptions): ExtrudeGeometry {
  const { size, depth, bevel = Math.min(depth * 0.35, size * 0.03) } = options;
  const shapes = createGlyphWordShapes(text, options);
  const geometry = new ExtrudeGeometry(shapes, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    curveSegments: 1
  });
  geometry.translate(0, 0, bevel);
  geometry.computeVertexNormals();
  return geometry;
}

/** Word width in metres for layout (matches createGlyphWordGeometry). */
export function glyphWordWidth(text: string, size: number, tracking = 0.16, typeface: WordTypeface = "block"): number {
  const glyphs = wordGlyphs(text, typeface);
  return (glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + tracking * Math.max(0, glyphs.length - 1)) * size;
}

/** Two separate, bevelled outlines form the rooftop coding emblem: />. */
export function createCodingMarkShapes(size: number): Shape[] {
  const outlines = EXTALIA_CODING_OUTLINES;
  // Centre the full 1.41-em silhouette, retaining a clear gap between / and >.
  return outlines.map(outline => new Shape(outline.map(([x, y]) => new Vector2((x - 0.055) * size, y * size))));
}

export function createCodingMarkGeometry(size: number, depth: number, bevel = 0.025): ExtrudeGeometry {
  const shapes = createCodingMarkShapes(size);
  const geometry = new ExtrudeGeometry(shapes, {
    depth: Math.max(0.001, depth - bevel * 2), bevelEnabled: bevel > 0,
    bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 1
  });
  geometry.translate(0, 0, bevel);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
