/*! @license
 * Copyright (c) 2026 n23eos. MIT License.
 * Density-aware paths inspired by Advanced Graph View (MIT):
 * src/render/EdgeMesh.ts and GraphRenderer.ts, revision
 * 17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d, n23eos/advanced_graph_view.
 * License: apps/web/public/THIRD_PARTY_SOFTWARE.md.
 * Extalia adds endpoint colour gradients. Linear RGB matches Three's vertex
 * colours, so interpolation stays smooth and direction-independent.
 */
export function graphEdgeColour(own: readonly number[], _other: readonly number[], background: readonly number[], light: boolean, opacity: number, visibleEdges: number, emphasis: 'normal' | 'focus' | 'muted'): [number, number, number] {
  const density = Math.max(light ? .36 : .2, Math.min(1, Math.sqrt(180 / Math.max(1, visibleEdges))));
  const emphasisWeight = emphasis === 'focus' ? 2.4 : emphasis === 'muted' ? .14 : 1;
  const coverage = Math.min(.94, opacity * density * emphasisWeight * (light ? 2.6 : 1.2));
  return [0, 1, 2].map(c => {
    // Darken category colours against pale canvases; retain hue in both themes.
    const ink = light ? .015 + own[c]! * .22 : .08 + own[c]! * .75;
    return background[c]! + (ink - background[c]!) * coverage;
  }) as [number, number, number];
}
