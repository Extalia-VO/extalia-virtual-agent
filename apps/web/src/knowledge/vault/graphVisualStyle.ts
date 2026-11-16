/*! @license
 * Copyright (c) 2026 n23eos. MIT License.
 * Density-aware paths inspired by Advanced Graph View (MIT):
 * src/render/EdgeMesh.ts and GraphRenderer.ts, revision
 * 17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d, n23eos/advanced_graph_view.
 * License: apps/web/public/THIRD_PARTY_SOFTWARE.md.
 * Extalia keeps endpoint colour gradients in linear RGB. Opacity is composed
 * by the GPU over the actual canvas, avoiding opaque background-colour ribbons.
 */
export function graphEdgeColour(own: readonly number[], light: boolean): [number, number, number] {
  return [0, 1, 2].map(channel => {
    const value = Number.isFinite(own[channel]) ? Math.max(0, Math.min(1, own[channel]!)) : 0;
    return light ? .012 + value * .68 : .015 + value * .94;
  }) as [number, number, number];
}

/** Density changes transparency, never endpoint hue; focused paths still obey the user's slider. */
export function graphEdgeOpacity(light: boolean, opacity: number, visibleEdges: number, emphasis: 'normal' | 'focus' | 'muted'): number {
  if (!Number.isFinite(opacity) || opacity <= 0) return 0;
  const density = Math.max(light ? .28 : .18, Math.min(1, Math.sqrt(220 / Math.max(1, visibleEdges))));
  const normal = Math.min(light ? .4 : .34, opacity * density * (light ? 2.2 : 1.5));
  if (emphasis === 'muted') return normal * .12;
  return emphasis === 'focus' ? Math.min(light ? .64 : .7, opacity * (light ? 2.5 : 2.8) + normal * .35) : normal;
}
