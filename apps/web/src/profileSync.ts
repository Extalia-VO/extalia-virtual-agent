import type { AgentHostApi, ProfilePreferences } from '@extalia/platform';
import { useEffect, useRef } from 'react';
import { DEFAULT_PREFERENCES, decodePreferences, type Preferences } from './preferences';
import { attachProfileClientState } from './profileClientState';

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
  /** Host values where known, defaults for absent fields; newer unknown values keep this client's display fallback. */
  preferences: Preferences;
  /**
   * Effective host values, including defaults for absent fields. Loading an
   * empty profile must never seed it from an old browser mirror. Unknown values
   * count as saved so this client cannot overwrite a newer client's choice.
   */
  synced: ProfilePreferences;
}

export function mergeProfilePreferences(local: Preferences, profile: ProfilePreferences): ProfileMerge {
  const preferences = { ...DEFAULT_PREFERENCES };
  const synced: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    if (value !== undefined) (preferences as Record<Field, string>)[field] = known(field, value) ? value : local[field];
    synced[field] = preferences[field];
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
  /** Cancel queued writes when this host/profile is detached. Entered saves may still settle. */
  dispose(): void;
}

export function createProfileSaver(save: AgentHostApi['saveProfile'], delayMs = 400): ProfileSaver {
  let disposed = false;
  let synced: ProfilePreferences = {};
  let pending: Preferences | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (disposed || !next) return;
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
    markSynced(next) { if (!disposed) synced = { ...next }; },
    schedule(next) {
      if (disposed) return;
      if (!Object.keys(profileChanges(synced, next)).length) { pending = undefined; clearTimeout(timer); return; }
      pending = next;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, delayMs);
    },
    flush,
    dispose() { disposed = true; pending = undefined; clearTimeout(timer); timer = undefined; },
  };
}

/**
 * Load the profile once a host is available, show its preferences (updating the
 * localStorage mirror through `apply`), then save later changes back, debounced.
 */
export function useProfileSync(agents: AgentHostApi | undefined, preferences: Preferences, apply: (next: Preferences) => void, profileIdentity?: string): void {
  const saver = useRef<ProfileSaver | undefined>(undefined);
  const latest = useRef(preferences);
  const applyRef = useRef(apply);
  // Kept current for the asynchronous profile load below.
  useEffect(() => { latest.current = preferences; applyRef.current = apply; });

  useEffect(() => {
    if (!agents) return;
    let active = true;
    const current = createProfileSaver(patch => agents.saveProfile(patch));
    // Bind before loading: an old browser cache cannot become a host setting
    // while this profile's authoritative state is still arriving.
    const clientState = attachProfileClientState(patch => agents.saveProfile(patch));
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 1_000;
    const load = () => {
      agents.getProfile().then(profile => {
        if (!active) return;
        clientState.hydrate(profile.clientState);
        const merged = mergeProfilePreferences(latest.current, profile.preferences ?? {});
        current.markSynced(merged.synced);
        saver.current = current;
        if (PROFILE_FIELDS.some(field => merged.preferences[field] !== latest.current[field])) applyRef.current(merged.preferences);
        // Missing fields use defaults; an old mirror never seeds a fresh host.
      }, () => {
        // A temporary reconnect failure is not an empty profile. Keep writes
        // fenced until the current host supplies authoritative settings.
        if (!active) return;
        retry = setTimeout(load, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      });
    };
    load();
    return () => {
      active = false;
      clearTimeout(retry);
      if (saver.current === current) saver.current = undefined;
      current.dispose();
      clientState.dispose();
    };
  }, [agents, profileIdentity]);

  useEffect(() => { saver.current?.schedule(preferences); }, [preferences]);
}
