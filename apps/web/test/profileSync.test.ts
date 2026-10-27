import type { ProfilePreferences, UserProfilePatch } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/preferences.js';
import { createProfileSaver, mergeProfilePreferences, profileChanges, toProfilePreferences } from '../src/profileSync.js';

const local: Preferences = { theme: 'light', material: 'standard', language: 'en', sidebar: 'expanded', font: 'inter' };

describe('profile preference merge', () => {
  it('takes every known profile value and keeps local values for fields the profile lacks', () => {
    const merged = mergeProfilePreferences(local, { language: 'id', theme: 'dark' });
    expect(merged.preferences).toEqual({ ...local, language: 'id', theme: 'dark' });
    // Missing fields are not treated as saved, so the device's values are saved back.
    expect(merged.synced).toEqual({ language: 'id', theme: 'dark' });
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({ material: 'standard', sidebar: 'expanded', font: 'inter' });
  });

  it('seeds an empty profile from this device', () => {
    const merged = mergeProfilePreferences(local, {});
    expect(merged.preferences).toEqual(local);
    expect(profileChanges(merged.synced, merged.preferences)).toEqual(toProfilePreferences(local));
  });

  it('keeps local values for profile values this client does not know, without overwriting them', () => {
    const merged = mergeProfilePreferences(local, { material: 'plasma-glass', font: 'comic', language: 'id' });
    expect(merged.preferences).toEqual({ ...local, language: 'id' });
    expect(merged.synced).toEqual({ material: 'standard', font: 'inter', language: 'id' });
    expect(profileChanges(merged.synced, merged.preferences)).toEqual({ theme: 'light', sidebar: 'expanded' });
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
});
