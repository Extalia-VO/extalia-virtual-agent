import { describe, expect, it } from 'vitest';
import {
  CONTEXT_RING_RADIUS, DEFAULT_CHOICE, HERMES_CHOICE, choiceFromOptions, choiceFromValue, choiceValue, cleanChoice, contextRing,
  effortSelectOptions, modelSelectOptions, permissionSelectOptions,
} from '../src/chat/composerOptions';

const modelLabels = { defaultLabel: (model: string | undefined) => (model ? `Default (${model})` : 'Default') };
const effortLabels = { effort: (value: string) => value.toUpperCase(), defaultLabel: (effort: string | undefined) => (effort ? `Default (${effort})` : 'Default') };
const permissionLabels = {
  label: (mode: string) => `label ${mode}`,
  description: (mode: string) => `about ${mode}`,
  managed: { label: 'Managed by Hermes', description: 'Hermes approvals' },
};

describe('permission picker', () => {
  it('offers the four modes in order, each with a one-line description', () => {
    const options = permissionSelectOptions('extalia-native', permissionLabels as never);
    expect(options.map(option => option.value)).toEqual(['workspace', 'ask', 'accept-edits', 'plan']);
    expect(options[3]).toMatchObject({ label: 'label plan', description: 'about plan', icon: 'eye' });
    expect(options.every(option => !option.disabled)).toBe(true);
  });

  it('offers only the modes the runtime lists, keeping the current one visible', () => {
    const only = permissionSelectOptions('extalia-native', permissionLabels as never, { modes: ['workspace', 'plan'] });
    expect(only.map(option => option.value)).toEqual(['workspace', 'plan']);
    const kept = permissionSelectOptions('extalia-native', permissionLabels as never, { modes: ['workspace'], current: 'ask' });
    expect(kept.map(option => option.value)).toEqual(['workspace', 'ask']);
  });

  it('shows Hermes sessions one disabled entry, since Hermes manages its own approvals', () => {
    expect(permissionSelectOptions('hermes', permissionLabels as never)).toEqual([
      { value: HERMES_CHOICE, label: 'Managed by Hermes', description: 'Hermes approvals', icon: 'bulb', disabled: true },
    ]);
  });
});

describe('model and effort pickers', () => {
  it('lists the default first, then the workspace models without repeats', () => {
    const options = modelSelectOptions({ defaultModel: 'claude-x', models: ['claude-x', 'gpt-y', 'gpt-y', ' '] }, modelLabels);
    expect(options).toEqual([
      { value: DEFAULT_CHOICE, label: 'Default (claude-x)' },
      { value: 'gpt-y', label: 'gpt-y' },
    ]);
  });

  it('keeps the session\'s current model listed even when the runtime does not list it', () => {
    const options = modelSelectOptions({ defaultModel: undefined, models: ['a'], current: 'older-model' }, modelLabels);
    expect(options.map(option => option.value)).toEqual([DEFAULT_CHOICE, 'a', 'older-model']);
    expect(options[0]!.label).toBe('Default');
  });

  it('hides the effort picker when the runtime cannot change the effort', () => {
    expect(effortSelectOptions({ efforts: [] }, effortLabels)).toEqual([]);
    expect(effortSelectOptions({ efforts: ['low', 'high'], defaultEffort: 'high' }, effortLabels)).toEqual([
      { value: DEFAULT_CHOICE, label: 'Default (HIGH)' },
      { value: 'low', label: 'LOW' },
      { value: 'high', label: 'HIGH' },
    ]);
    expect(effortSelectOptions({ efforts: ['low'] }, effortLabels)[0]).toEqual({ value: DEFAULT_CHOICE, label: 'Default' });
  });
});

describe('choices', () => {
  it('reads the stored choice and drops the workspace default and unknown modes', () => {
    expect(choiceFromOptions({ model: 'm', effort: 'low', permissionMode: 'plan' } as never)).toEqual({ model: 'm', effort: 'low', permissionMode: 'plan' });
    expect(choiceFromOptions({ permissionMode: 'workspace' } as never)).toEqual({});
    expect(choiceFromOptions({ permissionMode: 'root' } as never)).toEqual({});
    expect(choiceFromOptions(undefined)).toEqual({});
  });

  it('maps the default entry to and from an empty choice', () => {
    expect(choiceValue(undefined)).toBe(DEFAULT_CHOICE);
    expect(choiceValue('m')).toBe('m');
    expect(choiceFromValue(DEFAULT_CHOICE)).toBeUndefined();
    expect(choiceFromValue('m')).toBe('m');
  });

  it('cleans a choice for storing or sending', () => {
    expect(cleanChoice({ model: '', effort: undefined, permissionMode: 'workspace' } as never)).toEqual({});
    expect(cleanChoice({ model: 'm', permissionMode: 'accept-edits' })).toEqual({ model: 'm', permissionMode: 'accept-edits' });
  });
});

describe('context ring', () => {
  it('is hidden when the context or the window is unknown', () => {
    expect(contextRing(undefined)).toBeUndefined();
    expect(contextRing({ usedTokens: 1000 })).toBeUndefined();
    expect(contextRing({ usedTokens: 1000, windowTokens: 0 })).toBeUndefined();
  });

  it('draws the share in use and tones it at 80% and 95%', () => {
    const ring = contextRing({ usedTokens: 124_000, windowTokens: 200_000 })!;
    expect(ring.percent).toBe(62);
    expect(ring.tone).toBe('normal');
    expect(ring.circumference).toBeCloseTo(2 * Math.PI * CONTEXT_RING_RADIUS);
    expect(ring.dash).toBeCloseTo(ring.circumference * 0.62);
    expect(contextRing({ usedTokens: 79, windowTokens: 100 })!.tone).toBe('normal');
    expect(contextRing({ usedTokens: 80, windowTokens: 100 })!.tone).toBe('warning');
    expect(contextRing({ usedTokens: 94, windowTokens: 100 })!.tone).toBe('warning');
    expect(contextRing({ usedTokens: 95, windowTokens: 100 })!.tone).toBe('danger');
  });

  it('caps the drawing at a full ring when the context is over the window', () => {
    const ring = contextRing({ usedTokens: 250, windowTokens: 100 })!;
    expect(ring.percent).toBe(100);
    expect(ring.dash).toBeCloseTo(ring.circumference);
    expect(ring.tone).toBe('danger');
  });
});
