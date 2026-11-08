/*! @license
 * Copyright (c) 2026 n23eos. MIT License.
 * Adapted from Advanced Graph View (MIT), n23eos/advanced_graph_view:
 * src/render/NodeTexture.ts, src/render/nodeAppearance.ts and src/encoding/colorScales.ts
 * at 17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d.
 * https://github.com/n23eos/advanced_graph_view/tree/17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d
 * License: apps/web/public/THIRD_PARTY_SOFTWARE.md.
 * Pure texture/encoding math; no Pixi, Obsidian or runtime integration.
 */

export const GRAPH_GALAXY_PALETTE = [
  '#7c3aed', '#22d3ee', '#f472b6', '#38bdf8', '#a78bfa', '#5eead4',
  '#fb7185', '#818cf8', '#67e8f9', '#c084fc', '#f0abfc', '#fde047',
] as const;
export const GRAPH_GALAXY_BACKDROP = '#05050f';
export const GRAPH_STAR_SIZE_FACTOR = 1.8;
export const GRAPH_STAR_CORE_RATIO = .4;
export const GRAPH_NODE_FOG_FLOOR = .55;
const STAR_GLOW_LAYERS = 10;
const STAR_GLOW_FALLOFF = .09;
const STAR_GLOW_FLOOR = .012;

/**
 * Sample the reference's concentric white fills, source-over composited into
 * one texture. The opaque core is rendered separately by the instanced mesh.
 */
export function graphStarHaloOpacity(radialDistance: number): number {
  if (!Number.isFinite(radialDistance) || radialDistance < 0 || radialDistance >= 1) return 0;
  let opacity = 0;
  for (let layer = STAR_GLOW_LAYERS; layer >= 1; layer--) {
    const t = layer / STAR_GLOW_LAYERS;
    const radius = GRAPH_STAR_CORE_RATIO + (1 - GRAPH_STAR_CORE_RATIO) * t;
    if (radialDistance >= radius) continue;
    const alpha = STAR_GLOW_FALLOFF * (1 - t) + STAR_GLOW_FLOOR;
    opacity += alpha * (1 - opacity);
  }
  return opacity;
}

/** Analytic equivalent of the reference texture, antialiased at each layer. */
export const GRAPH_STAR_HALO_GLSL = /* glsl */ `
float graphStarHaloAlpha(float radialDistance, float edgeWidth) {
  float opacity = 0.0;
  for (int layer = ${STAR_GLOW_LAYERS}; layer >= 1; layer--) {
    float t = float(layer) / ${STAR_GLOW_LAYERS.toFixed(1)};
    float radius = ${GRAPH_STAR_CORE_RATIO} + ${1 - GRAPH_STAR_CORE_RATIO} * t;
    float coverage = 1.0 - smoothstep(radius - edgeWidth, radius, radialDistance);
    float alpha = (${STAR_GLOW_FALLOFF} * (1.0 - t) + ${STAR_GLOW_FLOOR}) * coverage;
    opacity += alpha * (1.0 - opacity);
  }
  return opacity;
}`;
