import type { ProfilePreferences, UserProfilePatch } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/preferences.js';
import { createProfileSaver, mergeProfilePreferences, profileChanges, toProfilePreferences } from '../src/profileSync.js';

const local: Preferences = { theme: 'light', material: 'standard', language: 'en', sidebar: 'expanded', font: 'inter' };

describe('profile preference merge', () => {
  it('takes known host values and defaults for fields missing from the host', () => {
    const merged = mergeProfilePreferences(local, { language: 'id', theme: 'dark' });
    expect(merged.preferences).toEqual({ ...DEFAULT_PREFERENCES, language: 'id', theme: 'dark' });
    expect(merged.synced).toEqual(toProfilePreferences(merged.preferences));
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({});
  });

  it('returns first-install defaults instead of restoring an old browser mirror into a deleted profile', () => {
    const previous: Preferences = { theme: 'dark', material: 'standard', language: 'id', sidebar: 'compact', font: 'inter' };
    const merged = mergeProfilePreferences(previous, {});
    expect(merged.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({});
    expect(profileChanges(merged.synced, { ...merged.preferences, language: 'id' })).toEqual({ language: 'id' });
  });

  it('keeps display fallbacks for unknown newer host values without overwriting them', () => {
    const merged = mergeProfilePreferences(local, { material: 'plasma-glass', font: 'comic', language: 'id' });
    expect(merged.preferences).toEqual({ ...DEFAULT_PREFERENCES, material: local.material, font: local.font, language: 'id' });
    expect(merged.synced).toEqual(toProfilePreferences(merged.preferences));
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({});
  });

  it('changes nothing when the profile already matches', () => {
    const merged = mergeProfilePreferences(DEFAULT_PREFERENCES, toProfilePreferences(DEFAULT_PREFERENCES));
    expect(merged.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({});
  });
});

describe('profile saver', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces, sends only changed fields, and retries fields that failed to save', async () => {
    const calls: UserProfilePatch[] = [];
    let fail = false;
    const save = vi.fn(async (patch: UserProfilePatch) => {
      calls.push(patch);
      if (fail) throw new Error('offline');
      return { schema: 'extalia.profile.v1' as const, preferences: patch.preferences as ProfilePreferences, updatedAt: '2026-10-01T00:00:00.000Z' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saver = createProfileSaver(save, 400);
    saver.markSynced(toProfilePreferences(local));

    saver.schedule({ ...local, theme: 'dark' });
    saver.schedule({ ...local, theme: 'dark', font: 'geist' });
    await vi.advanceTimersByTimeAsync(399);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ preferences: { theme: 'dark', font: 'geist' } }]);

    // Back to what is saved: nothing to send.
    saver.schedule({ ...local, theme: 'dark', font: 'geist' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    fail = true;
    saver.schedule({ ...local, theme: 'dark', font: 'geist', language: 'id' });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls[1]).toEqual({ preferences: { language: 'id' } });
    fail = false;
    saver.schedule({ ...local, theme: 'dark', font: 'geist', language: 'id', sidebar: 'compact' });
    await saver.flush();
    expect(calls[2]).toEqual({ preferences: { language: 'id', sidebar: 'compact' } });
    warn.mockRestore();
  });

  it('drops queued saves on host detachment and never flushes a stale profile during cleanup', async () => {
    const save = vi.fn(async () => ({ schema: 'extalia.profile.v1' as const, preferences: {}, updatedAt: '2026-10-01T00:00:00.000Z' }));
    const saver = createProfileSaver(save, 400);
    saver.markSynced(toProfilePreferences(DEFAULT_PREFERENCES));
    saver.schedule({ ...DEFAULT_PREFERENCES, theme: 'dark' });
    saver.dispose();
    await saver.flush();
    saver.schedule({ ...DEFAULT_PREFERENCES, language: 'id' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });

});
