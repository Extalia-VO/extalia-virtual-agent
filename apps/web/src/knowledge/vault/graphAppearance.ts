/** View-only appearance settings; never change the indexed notes, links or permissions. */
export interface GraphAppearance {
  nodeSize: number;
  glow: number;
  linkOpacity: number;
  linkWidth: number;
  showLinks: boolean;
}
export const GRAPH_PRESETS = {
  nebula: { nodeSize: .65, glow: .75, linkOpacity: .24, linkWidth: .85, showLinks: true },
  minimal: { nodeSize: .55, glow: .15, linkOpacity: .2, linkWidth: .7, showLinks: true },
} satisfies Record<string, GraphAppearance>;
export type GraphPreset = keyof typeof GRAPH_PRESETS;
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback;
export function graphAppearance(value?: Partial<GraphAppearance>): GraphAppearance {
  const defaults = GRAPH_PRESETS.nebula;
  return {
    nodeSize: bounded(value?.nodeSize, defaults.nodeSize, .25, 2),
    glow: bounded(value?.glow, defaults.glow, 0, 2),
    linkOpacity: bounded(value?.linkOpacity, defaults.linkOpacity, .01, .8),
    linkWidth: bounded(value?.linkWidth, defaults.linkWidth, .25, 3),
    showLinks: typeof value?.showLinks === 'boolean' ? value.showLinks : defaults.showLinks,
  };
}
