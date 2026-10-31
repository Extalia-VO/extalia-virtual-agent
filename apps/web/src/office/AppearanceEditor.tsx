import {
  CHARACTER_BAGS, CHARACTER_BOTTOMS, CHARACTER_EARRINGS, CHARACTER_GAITS, CHARACTER_GLASSES, CHARACTER_HEIGHT_CM,
  CHARACTER_PRESENTATIONS, CHARACTER_STATURES, CHARACTER_TOPS, CHARACTER_WATCHES,
  getCharacterHairOptions, resolveCharacterHair,
  type CharacterAccessories, type CharacterAppearance, type CharacterHairStyle, type CharacterOutfitSlot,
} from '@extalia/core';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { Select, type SelectOption } from '../ui/Select';
import { localHairStyles } from './scene/avatars/sourceAssets';
import {
  applyPresentationPreset, avatarVisual, characterHeightCm, defaultCharacterAppearance, HAIR_COLORS, lookSeed, SKIN_TONES, type LookIdentity,
} from './scene/avatars/appearance';
import {
  applyOutfitChoice, applyOutfitPiece, appearanceChoice, choiceValue, defaultOutfit, outfitChoices, pieceChoices, randomizeOutfit, staffAppearance, UNIFORM_ACCENTS,
  type StaffRole,
} from './scene/avatars/outfitCatalog';

/** Garment swatches; "auto" keeps the outfit's own palette. */
export const GARMENT_COLORS = ['#26324a', '#3a3d42', '#efe9dc', '#a9c4dc', '#9fb39a', '#6d2333', '#b0875c', '#5f4a6e'] as const;

type Text = Messages['appearance'];

/** Order-independent comparison, so a draft equal to the saved look is not "changed". */
function sameAppearance(a: CharacterAppearance, b: CharacterAppearance): boolean {
  const canonical = (value: unknown): unknown => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([key, item]) => [key, canonical(item)]))
    : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

type OptionalKey = 'topColor' | 'bottomColor' | 'outerColor' | 'accentColor' | 'heightCm';

/** `outfit-relaxed-streetwear` → "Relaxed streetwear". */
export function outfitModelLabel(id: string): string {
  const words = id.replace(/^(?:outfit-)?(?:source-)?/, '').split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function withOptional<K extends OptionalKey>(draft: CharacterAppearance, key: K, value: CharacterAppearance[K]): CharacterAppearance {
  const next = { ...draft };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function Field<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly SelectOption<T>[]; onChange(value: T): void;
}) {
  const id = useId();
  return <Select id={id} label={label} value={value} options={options} onChange={onChange} className="appearance-select" />;
}

function Swatches({ legend, value, colors, names, auto, custom, onChange }: {
  legend: string; value: string | undefined; colors: readonly string[]; names: readonly string[];
  auto?: string; custom: string; onChange(value: string | undefined): void;
}) {
  const name = useId();
  const own = value !== undefined && !colors.includes(value);
  return <fieldset className="appearance-swatches">
    <legend>{legend}</legend>
    <div className="appearance-swatch-row">
      {auto && <label className="appearance-swatch auto" title={auto}>
        <input type="radio" name={name} checked={value === undefined} aria-label={auto} onChange={() => onChange(undefined)} />
        <span aria-hidden="true" />
      </label>}
      {colors.map((color, index) => <label key={color} className="appearance-swatch" title={names[index]}>
        <input type="radio" name={name} checked={value === color} aria-label={names[index] ?? color} onChange={() => onChange(color)} />
        <span style={{ background: color }} aria-hidden="true" />
      </label>)}
      <label className={`appearance-swatch custom${own ? ' selected' : ''}`} title={custom}>
        <input type="color" value={value ?? '#808080'} aria-label={custom} onChange={event => onChange(event.target.value.toLowerCase())} />
      </label>
    </div>
  </fieldset>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="switch appearance-switch">
    <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="switch-track" aria-hidden="true" />
    <span>{label}</span>
  </label>;
}

/**
 * Per-character look: presentation presets plus individual options. Every change
 * previews on the selected character; Save stores it in the agent host so Web
 * and Desktop share it.
 */
export function AppearanceEditor({ t, characterId: presenceId, identity, saved, uniform, defaults, onPreview, onSave, onClose }: {
  t: Text;
  characterId: string;
  /** v0.0.30: a named character's look seed; its generated look and palette come from the name. */
  identity?: LookIdentity | undefined;
  saved: CharacterAppearance | undefined;
  /** Facility staff: the role's uniform is locked; only its accent colour changes. */
  uniform?: StaffRole | undefined;
  /** The look "Default outfit" and Reset return to; the seeded generated look when omitted. */
  defaults?: CharacterAppearance | undefined;
  onPreview(appearance: CharacterAppearance | null): void;
  onSave(appearance: CharacterAppearance | null): Promise<void>;
  onClose(): void;
}) {
  const characterId = lookSeed(presenceId, identity);
  const presentation = identity?.presentation;
  // First spawn wears the generated (seeded) look; nothing is stored until the user saves.
  const generated = useMemo(() => {
    const look = defaults ?? defaultCharacterAppearance(characterId, presentation);
    return uniform ? staffAppearance(uniform, look) : look;
  }, [defaults, characterId, presentation, uniform]);
  const baseline = useMemo(() => uniform && saved ? staffAppearance(uniform, generated, saved) : saved ?? generated, [saved, generated, uniform]);
  const [draft, setDraft] = useState(baseline);
  // "Default outfit" follows the body currently being edited after a preset switch.
  const outfitDefaults = useMemo(() => uniform || generated.presentation === draft.presentation
    ? generated : defaultCharacterAppearance(characterId, draft.presentation), [uniform, generated, draft.presentation, characterId]);
  const [roll, setRoll] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId(), presetId = useId();
  const preview = useRef(onPreview);
  useEffect(() => { preview.current = onPreview; });
  useEffect(() => { preview.current(draft); }, [draft]);
  useEffect(() => () => preview.current(null), []);

  const changed = !sameAppearance(draft, baseline);
  const generatedHeight = useMemo(() => characterHeightCm(avatarVisual(characterId, withOptional(draft, 'heightCm', undefined))), [characterId, draft]);
  const edit = (next: CharacterAppearance) => { setNotice(null); setDraft(next); };
  const set = (patch: Partial<Omit<CharacterAppearance, OptionalKey>>) => edit({ ...draft, ...patch });
  const outfitOptions: SelectOption<string>[] = outfitChoices(draft.presentation).map(choice => ({
    value: choiceValue(choice),
    label: choice.kind === 'style' ? t.outfits[choice.style] : `${t.outfitModels} · ${t.modelOutfit(outfitModelLabel(choice.id))}`,
  }));
  const currentOutfit = appearanceChoice(draft);
  // A saved model that is not in this build stays visible as the current value.
  if (!outfitOptions.some(option => option.value === currentOutfit)) {
    outfitOptions.push({ value: currentOutfit, label: draft.outfitParts ? t.separateOutfit : draft.outfitModel ? t.modelOutfit(outfitModelLabel(draft.outfitModel)) : currentOutfit, disabled: true });
  }
  const pieceOptions = (slot: CharacterOutfitSlot): SelectOption<string>[] => {
    const result: SelectOption<string>[] = [
      { value: slot === 'outer' ? 'none' : '__body_default__', label: slot === 'outer' ? t.none : t.scanDefault },
      ...pieceChoices(draft.presentation, slot).map(piece => ({ value: piece.id,
        label: (t.pieceNames as Record<string, string>)[piece.id] ?? t.modelOutfit(outfitModelLabel(piece.id)) })),
    ];
    if (!draft.outfitParts) result.unshift({ value: 'complete', label: t.fromCompleteOutfit, disabled: true });
    const current = draft.outfitParts?.[slot];
    if (current && !result.some(option => option.value === current)) {
      return [...result, { value: current, label: t.modelOutfit(outfitModelLabel(current)), disabled: true }];
    }
    return result;
  };
  const randomize = () => {
    const next = roll + 1;
    setRoll(next);
    if (uniform) {
      const choices = UNIFORM_ACCENTS.filter(color => color !== draft.accentColor);
      edit({ ...draft, accentColor: choices[(next * 7 + characterId.length) % choices.length]! });
    } else edit(randomizeOutfit(draft, characterId, next));
  };
  const accessory = (patch: Partial<CharacterAccessories>) => edit({ ...draft, accessories: { ...draft.accessories, ...patch } });
  const options = <T extends string>(values: readonly T[], label: (value: T) => string): SelectOption<T>[] => values.map(value => ({ value, label: label(value) }));
  const withNone = <T extends string>(values: readonly ('none' | T)[], labels: Record<T, string>) =>
    options(values, value => value === 'none' ? t.none : labels[value as T]);
  // With local detailed models, only styles that have one are offered; the procedural character draws them all.
  const localStyles = localHairStyles();
  const hairOptions: SelectOption<CharacterHairStyle>[] = getCharacterHairOptions(draft.presentation)
    .filter(option => !localStyles || localStyles.has(option.id)).map(option => ({
    value: option.id,
    label: t.hairStyles[option.id],
  }));
  const resolvedHair = resolveCharacterHair(draft.hairStyle, draft.presentation);
  const hairFallback = resolvedHair.warning === 'legacy-bun';
  // Only the presentation's own hair is offered; a saved style of the other group stays visible as the current value.
  if (!hairOptions.some(option => option.value === draft.hairStyle)) {
    hairOptions.push({ value: draft.hairStyle, label: `${t.hairGroups[resolvedHair.group]} · ${t.hairStyles[draft.hairStyle]}`, disabled: true });
  }

  async function store(next: CharacterAppearance | null) {
    setSaving(true); setError(null); setNotice(null);
    try {
      await onSave(next);
      if (!next) setDraft(generated);
      setNotice(t.saved);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  }

  return <section className="appearance-editor" aria-labelledby={headingId}>
    <div className="office-panel-head">
      <strong id={headingId}>{t.title}</strong>
      <button type="button" className="icon-button small" aria-label={t.close} onClick={onClose}><Icon name="close" /></button>
    </div>
    <p className="muted-note">{t.lead}</p>
    {/* Buttons, not radios: choosing the current preset again re-applies it. */}
    <div className="appearance-preset-field">
      <span id={presetId}>{t.preset}</span>
      <div className="segmented appearance-presets" role="group" aria-labelledby={presetId}>
        {CHARACTER_PRESENTATIONS.map(value => <button key={value} type="button" className="segment-label" aria-pressed={draft.presentation === value}
          onClick={() => edit(applyPresentationPreset(draft, value, characterId))}>{t.presets[value]}</button>)}
      </div>
    </div>

    <fieldset className="appearance-group">
      <legend>{t.hair}</legend>
      <Field label={t.hairStyle} value={resolvedHair.aliasOf ?? draft.hairStyle} options={hairOptions} onChange={hairStyle => set({ hairStyle })} />
      {hairFallback && <p className="muted-note" role="status">{t.bunFallbackNotice}</p>}
      <Swatches legend={t.hairColor} value={draft.hairColor} colors={HAIR_COLORS} names={t.hairColors} custom={t.customColor} onChange={hairColor => hairColor && set({ hairColor })} />
      <Swatches legend={t.skinTone} value={draft.skinTone} colors={SKIN_TONES} names={t.skinTones} custom={t.customColor} onChange={skinTone => skinTone && set({ skinTone })} />
    </fieldset>

    <fieldset className="appearance-group">
      <legend>{t.clothing}</legend>
      {uniform ? <>
        <p className="appearance-uniform"><strong>{t.staffUniform}</strong> · {t.uniformRoles[uniform]}</p>
        <p className="muted-note">{t.uniformNote}</p>
        <Swatches legend={t.accentColor} value={draft.accentColor} colors={UNIFORM_ACCENTS} names={UNIFORM_ACCENTS} custom={t.customColor}
          onChange={value => value && edit({ ...draft, accentColor: value })} />
      </> : <>
        <div className="appearance-grid">
          <Field label={t.outfit} value={currentOutfit} options={outfitOptions} onChange={value => edit(applyOutfitChoice(draft, value))} />
          {(['top', 'bottom', 'outer'] as const).map(slot => <Field key={slot} label={t.pieceSlots[slot]}
            value={draft.outfitParts ? draft.outfitParts[slot] ?? (slot === 'outer' ? 'none' : '__body_default__') : 'complete'} options={pieceOptions(slot)}
            onChange={value => edit(applyOutfitPiece(draft, slot, value === '__body_default__' ? undefined : value))} />)}
          {!draft.outfitParts && !draft.outfitModel && <>
            <Field label={t.fallbackTop} value={draft.top} options={options(CHARACTER_TOPS, value => t.tops[value])} onChange={top => set({ top })} />
            <Field label={t.fallbackBottom} value={draft.bottom} options={options(CHARACTER_BOTTOMS, value => t.bottoms[value])} onChange={bottom => set({ bottom })} />
          </>}
        </div>
        <p className="muted-note">{t.pieceNote}</p>
        {(draft.outfitParts || draft.bottom !== 'dress') && <Swatches legend={t.topColor} value={draft.topColor} colors={GARMENT_COLORS} names={t.garmentColors} auto={t.autoColor} custom={t.customColor}
          onChange={value => edit(withOptional(draft, 'topColor', value))} />}
        <Swatches legend={!draft.outfitParts && draft.bottom === 'dress' ? t.dressColor : t.bottomColor} value={draft.bottomColor} colors={GARMENT_COLORS} names={t.garmentColors} auto={t.autoColor} custom={t.customColor}
          onChange={value => edit(withOptional(draft, 'bottomColor', value))} />
        <Swatches legend={t.outerColor} value={draft.outerColor} colors={GARMENT_COLORS} names={t.garmentColors} auto={t.autoColor} custom={t.customColor}
          onChange={value => edit(withOptional(draft, 'outerColor', value))} />
        <Swatches legend={t.accentColor} value={draft.accentColor} colors={GARMENT_COLORS} names={t.garmentColors} auto={t.autoColor} custom={t.customColor}
          onChange={value => edit(withOptional(draft, 'accentColor', value))} />
        <p className="muted-note">{t.outfitNote}</p>
      </>}
      <div className="appearance-outfit-actions">
        <button type="button" className="button" disabled={saving} onClick={randomize}><Icon name="refresh" />{t.randomize}</button>
        <button type="button" className="button" disabled={saving || sameAppearance(defaultOutfit(draft, outfitDefaults), draft)} onClick={() => edit(defaultOutfit(draft, outfitDefaults))}>{t.defaultOutfit}</button>
      </div>
    </fieldset>

    <fieldset className="appearance-group">
      <legend>{t.body}</legend>
      <Field label={t.stature} value={draft.stature} options={options(CHARACTER_STATURES, value => t.statures[value])} onChange={stature => set({ stature })} />
      <label className="field appearance-range">
        <span>{t.height} <output>{t.heightValue(draft.heightCm ?? generatedHeight)}</output></span>
        <input type="range" min={CHARACTER_HEIGHT_CM.min} max={CHARACTER_HEIGHT_CM.max} step={1} value={draft.heightCm ?? generatedHeight}
          aria-valuetext={t.heightValue(draft.heightCm ?? generatedHeight)} onChange={event => edit(withOptional(draft, 'heightCm', Number(event.target.value)))} />
      </label>
    </fieldset>

    <fieldset className="appearance-group">
      <legend>{t.accessories}</legend>
      <div className="appearance-grid">
        <Field label={t.glasses} value={draft.accessories.glasses} options={withNone(CHARACTER_GLASSES, t.glassesStyles)} onChange={glasses => accessory({ glasses })} />
        <Field label={t.watch} value={draft.accessories.watch} options={withNone(CHARACTER_WATCHES, t.watches)} onChange={watch => accessory({ watch })} />
        <Field label={t.earrings} value={draft.accessories.earrings} options={withNone(CHARACTER_EARRINGS, t.earringStyles)} onChange={earrings => accessory({ earrings })} />
        <Field label={t.bag} value={draft.accessories.bag} options={withNone(CHARACTER_BAGS, t.bags)} onChange={bag => accessory({ bag })} />
      </div>
      <div className="appearance-switches">
        <Toggle label={t.tie} checked={draft.accessories.tie} onChange={tie => accessory({ tie })} />
        <Toggle label={t.badge} checked={draft.accessories.badge} onChange={badge => accessory({ badge })} />
        <Toggle label={t.headphones} checked={draft.accessories.headphones} onChange={headphones => accessory({ headphones })} />
      </div>
    </fieldset>

    <fieldset className="appearance-group">
      <legend>{t.movement}</legend>
      <Segmented legend={t.gait} value={draft.gait} className="appearance-segmented" options={options(CHARACTER_GAITS, value => t.gaits[value])} onChange={gait => set({ gait })} />
      <p className="muted-note">{t.gaitNote}</p>
    </fieldset>

    <p className="muted-note">{t.previewNote}</p>
    {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    {notice && !changed && <p className="muted-note" role="status">{notice}</p>}
    <div className="appearance-actions">
      <button type="button" className="button primary" disabled={!changed || saving} onClick={() => { void store(draft); }}>{saving ? t.saving : t.save}</button>
      <button type="button" className="button" disabled={!changed || saving} onClick={() => { setNotice(null); setDraft(baseline); }}>{t.cancel}</button>
      <button type="button" className="button" disabled={(!saved && !changed) || saving} onClick={() => { void store(null); }}>{t.reset}</button>
    </div>
  </section>;
}
