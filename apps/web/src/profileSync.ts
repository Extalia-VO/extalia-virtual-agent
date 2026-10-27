import type { AgentHostApi, ProfilePreferences } from '@extalia/platform';
import { useEffect, useRef } from 'react';
import { decodePreferences, type Preferences } from './preferences';

/**
 * Interface preferences follow the Extalia profile (`<data>/config/profile.json`)
 * whenever an agent host is available, so the Web client (through the Bridge)
 * and Desktop look the same. localStorage stays as a mirror: the pre-paint
 * script `public/boot-appearance.js` reads it to avoid a theme flash. The static
 * Web build without a host keeps using localStorage only.
 */

export const PROFILE_FIELDS = ['language', 'theme', 'material', 'font', 'sidebar'] as const satisfies readonly (keyof Preferences & keyof ProfilePreferences)[];
type Field = typeof PROFILE_FIELDS[number];

export const toProfilePreferences = (preferences: Preferences): ProfilePreferences =>
  Object.fromEntries(PROFILE_FIELDS.map(field => [field, preferences[field]])) as ProfilePreferences;

/** A value this client understands (unknown values may come from a newer client). */
function known(field: Field, value: unknown): boolean {
  return typeof value === 'string' && decodePreferences({ [field]: value })[field] === value;
}

export interface ProfileMerge {
  /** What this client shows: the profile's value where it knows it, its own value otherwise. */
  preferences: Preferences;
  /**
   * What to treat as already saved in the profile. Fields the profile lacks are
   * left out, so they are saved back; fields with values this client does not
   * know count as saved, so a newer client's choice is never overwritten.
   */
  synced: ProfilePreferences;
}

export function mergeProfilePreferences(local: Preferences, profile: ProfilePreferences): ProfileMerge {
  const preferences = { ...local };
  const synced: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    if (value === undefined) continue;
    if (known(field, value)) (preferences as Record<Field, string>)[field] = value;
    synced[field] = (preferences as Record<Field, string>)[field];
  }
  return { preferences, synced: synced as ProfilePreferences };
}

/** Fields of `next` that differ from what the profile holds. */
export function profileChanges(synced: ProfilePreferences, next: Preferences): ProfilePreferences {
  const changes: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) if (synced[field] !== next[field]) changes[field] = next[field];
  return changes as ProfilePreferences;
}

export interface ProfileSaver {
  /** Record what the profile holds now. */
  markSynced(synced: ProfilePreferences): void;
  /** Save changed fields after `delayMs` of quiet. */
  schedule(next: Preferences): void;
  /** Save a pending change now. */
  flush(): Promise<void>;
}

export function createProfileSaver(save: AgentHostApi['saveProfile'], delayMs = 400): ProfileSaver {
  let synced: ProfilePreferences = {};
  let pending: Preferences | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (!next) return;
    const changes = profileChanges(synced, next);
    if (!Object.keys(changes).length) return;
    // Optimistic: a second change made while saving only sends what differs from this one.
    const before = synced;
    synced = { ...synced, ...changes };
    try { await save({ preferences: changes }); }
    catch (error) {
      // Not saved: the next change sends these fields again.
      for (const field of PROFILE_FIELDS) if (field in changes && synced[field] === changes[field]) (synced as Record<string, string | undefined>)[field] = before[field];
      console.warn('Extalia could not save interface preferences to the profile.', error);
    }
  }

  return {
    markSynced(next) { synced = { ...next }; },
    schedule(next) {
      if (!Object.keys(profileChanges(synced, next)).length) { pending = undefined; clearTimeout(timer); return; }
      pending = next;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, delayMs);
    },
    flush,
  };
}

/**
 * Load the profile once a host is available, show its preferences (updating the
 * localStorage mirror through `apply`), then save later changes back, debounced.
 */
export function useProfileSync(agents: AgentHostApi | undefined, preferences: Preferences, apply: (next: Preferences) => void): void {
  const saver = useRef<ProfileSaver | undefined>(undefined);
  const latest = useRef(preferences);
  const applyRef = useRef(apply);
  // Kept current for the asynchronous profile load below.
  useEffect(() => { latest.current = preferences; applyRef.current = apply; });

  useEffect(() => {
    if (!agents) return;
    let active = true;
    const current = createProfileSaver(patch => agents.saveProfile(patch));
    agents.getProfile().then(profile => {
      if (!active) return;
      const merged = mergeProfilePreferences(latest.current, profile.preferences ?? {});
      current.markSynced(merged.synced);
      saver.current = current;
      if (PROFILE_FIELDS.some(field => merged.preferences[field] !== latest.current[field])) applyRef.current(merged.preferences);
      // Fields the profile does not have yet (a first start after upgrading) are saved from this device.
      current.schedule(merged.preferences);
    }, () => { /* An older host without profiles: preferences stay on this device. */ });
    return () => {
      active = false;
      if (saver.current === current) saver.current = undefined;
      void current.flush();
    };
  }, [agents]);

  useEffect(() => { saver.current?.schedule(preferences); }, [preferences]);
}
