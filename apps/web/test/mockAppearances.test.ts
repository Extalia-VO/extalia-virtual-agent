import type { CharacterAppearance } from '@extalia/core';
import { describe, expect, it, vi } from 'vitest';
import { createMockAppearances } from '../src/host/mockAppearances';
import { defaultCharacterAppearance } from '../src/office/scene/avatars/appearance';

const LOOK: CharacterAppearance = { ...defaultCharacterAppearance('s1:primary'), presentation: 'feminine', bottom: 'dress', gait: 'feminine' };

describe('mock host character appearances', () => {
  it('validates like the real host and prunes characters of deleted sessions', async () => {
    const sessions = new Set(['s1', 's2']);
    const looks = createMockAppearances(() => sessions);
    expect(await looks.characterAppearances()).toEqual({});
    expect(await looks.saveCharacterAppearance('s1:primary', LOOK)).toEqual({ 's1:primary': LOOK });
    await looks.saveCharacterAppearance('s2:worker', { ...LOOK, gait: 'masculine' });
    await expect(looks.saveCharacterAppearance('nobody', LOOK)).rejects.toThrow(/Choose a character/);
    await expect(looks.saveCharacterAppearance('s9:primary', LOOK)).rejects.toThrow(/no longer exists/);
    await expect(looks.saveCharacterAppearance('s1:primary', { ...LOOK, skinTone: 'tan' })).rejects.toThrow(/skinTone/);
    sessions.delete('s2');
    expect(Object.keys(await looks.characterAppearances())).toEqual(['s1:primary']);
    expect(await looks.saveCharacterAppearance('s1:primary', null)).toEqual({});
  });

  it('is part of the development mock host', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
    const { createMockPlatform } = await import('../src/host/mockHost');
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const [session] = (await agents.getState()).sessions;
    const id = `${session!.id}:primary`;
    expect(await agents.saveCharacterAppearance(id, LOOK)).toEqual({ [id]: LOOK });
    await agents.deleteSession(session!.id);
    expect(await agents.characterAppearances()).toEqual({});
    vi.unstubAllGlobals();
  });
});
