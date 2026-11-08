import { Select } from '../../ui/Select';
import type { Messages } from '../../i18n';
import { GRAPH_PRESETS, type GraphAppearance, type GraphPreset } from './graphAppearance';

/** Bounded visual controls only; these never alter graph membership or the vault. */
export function GraphAppearanceControls({ t, value, onChange }: { t: Messages; value: GraphAppearance; onChange: (value: GraphAppearance) => void }) {
  const k = t.knowledge.vaultGraph;
  const presets = Object.keys(GRAPH_PRESETS) as GraphPreset[];
  const preset = presets.find(name => (Object.keys(GRAPH_PRESETS[name]) as (keyof GraphAppearance)[])
    .every(key => GRAPH_PRESETS[name][key] === value[key])) ?? '';
  return <div className="graph-appearance">
    <div className="field"><span>{k.preset}</span><Select aria-label={k.preset} value={preset} placeholder={k.preset}
      onChange={name => { if (name) onChange({ ...GRAPH_PRESETS[name] }); }}
      options={presets.map(name => ({ value: name, label: k.presets[name] }))} /></div>
    {([
      ['nodeSize', k.nodeSize, .25, 2, .05], ['glow', k.glowStrength, 0, 2, .05],
      ['linkOpacity', k.linkOpacity, .01, .8, .01], ['linkWidth', k.linkWidth, .25, 3, .05],
    ] as const).map(([key, label, min, max, step]) => <label key={key} className="graph-range"><span>{label}<output aria-hidden="true">{value[key].toFixed(2)}</output></span>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value[key]} onChange={event => onChange({ ...value, [key]: Number(event.target.value) })} />
    </label>)}
    <label className="graph-check"><input type="checkbox" checked={value.showLinks} onChange={event => onChange({ ...value, showLinks: event.target.checked })} />{k.showLinks}</label>
  </div>;
}
