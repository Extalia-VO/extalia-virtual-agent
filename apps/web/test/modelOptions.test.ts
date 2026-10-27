import { describe, expect, it } from 'vitest';
import { delegationLimitOptions, groupedModelOptions, tierModelOptions } from '../src/setup/modelOptions';

describe('model options', () => {
  it('groups ids by their provider prefix in the endpoint order, with ungrouped ids last', () => {
    const options = groupedModelOptions(['openai/gpt-5', 'local-model', 'anthropic/claude-opus-5-5', 'openai/gpt-5-mini', 'anthropic/claude-opus-5-5'], { otherGroup: 'Other' });
    expect(options.map(option => option.value)).toEqual(['openai/gpt-5', 'openai/gpt-5-mini', 'anthropic/claude-opus-5-5', 'local-model']);
    expect(options.map(option => option.group)).toEqual(['openai', 'openai', 'anthropic', 'Other']);
  });

  it('drops blank ids and badges only the default model', () => {
    const options = groupedModelOptions([' ', 'a/one', 'a/two'], { otherGroup: 'Other', defaultModel: 'a/two', defaultBadge: 'Default' });
    expect(options).toEqual([
      { value: 'a/one', label: 'a/one', group: 'a' },
      { value: 'a/two', label: 'a/two', group: 'a', badge: 'Default' },
    ]);
  });

  it('puts the main model first as an empty tier value, then the grouped models', () => {
    const options = tierModelOptions(['anthropic/claude-haiku-4-5'], { mainModel: 'Main model (gpt)', otherGroup: 'Other' });
    expect(options[0]).toEqual({ value: '', label: 'Main model (gpt)' });
    expect(options.slice(1).map(option => option.value)).toEqual(['anthropic/claude-haiku-4-5']);
    expect(tierModelOptions([], { mainModel: 'Main model', otherGroup: 'Other' })).toEqual([{ value: '', label: 'Main model' }]);
  });

  it('offers 0 (off) to 8 and keeps a stored limit outside that range', () => {
    expect(delegationLimitOptions('3', 'Off').map(option => option.value)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(delegationLimitOptions('0', 'Off')[0]).toEqual({ value: '0', label: 'Off' });
    expect(delegationLimitOptions('12', 'Off').map(option => option.value).slice(-2)).toEqual(['8', '12']);
    expect(delegationLimitOptions('abc', 'Off').map(option => option.value)).not.toContain('abc');
  });
});
