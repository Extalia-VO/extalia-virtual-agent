import { rename } from 'node:fs/promises';
import path from 'node:path';
import type { ProfilePreferences, UserProfile } from '@extalia/platform';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { PRIVATE_FILE_MODE } from './paths.js';

/**
 * The shared user profile, `<dataDirectory>/config/profile.json`. Web (through
 * the Bridge) and Desktop read and write the same file, so the interface looks
 * the same in both. Only a display name and interface preferences live here;
 * no secrets.
 */

export const PROFILE_SCHEMA = 'extalia.profile.v1';
export const PROFILE_FILE = 'profile.json';
export const DISPLAY_NAME_LIMIT = 80;
const NEVER_SAVED = new Date(0).toISOString();
const PREFERENCE_KEYS = ['language', 'theme', 'material', 'font', 'sidebar'] as const satisfies readonly (keyof ProfilePreferences)[];
const LANGUAGES = ['en', 'id'] as const;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A profile change the host refuses; the message is safe to show. */
export class ProfileError extends Error {
  override name = 'UserError';
}

export const emptyProfile = (): UserProfile => ({ schema: PROFILE_SCHEMA, preferences: {}, updatedAt: NEVER_SAVED });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > DISPLAY_NAME_LIMIT || CONTROL.test(clean)) return undefined;
  return clean;
}

function validPreference(key: keyof ProfilePreferences, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return key === 'language' ? (LANGUAGES as readonly string[]).includes(value) : TOKEN.test(value);
}

/** Decode a stored profile field by field; invalid fields are dropped, never passed on. */
export function decodeProfile(raw: unknown): UserProfile {
  const profile = emptyProfile();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return profile;
  const value = raw as Record<string, unknown>;
  const name = cleanName(value.displayName);
  if (name) profile.displayName = name;
  const preferences = value.preferences && typeof value.preferences === 'object' && !Array.isArray(value.preferences) ? value.preferences as Record<string, unknown> : {};
  for (const key of PREFERENCE_KEYS) if (validPreference(key, preferences[key])) (profile.preferences as Record<string, string>)[key] = preferences[key] as string;
  if (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) profile.updatedAt = value.updatedAt;
  return profile;
}

/** Apply a patch from a client. Anything malformed is refused as a whole, so nothing half-applies. */
export function applyProfilePatch(current: UserProfile, patch: unknown, stamp: string): UserProfile {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProfileError('The profile change is not valid.');
  const { displayName, preferences, ...rest } = patch as Record<string, unknown>;
  if (Object.keys(rest).length) throw new ProfileError(`Unknown profile field: ${Object.keys(rest)[0]}.`);
  const next: UserProfile = { ...current, preferences: { ...current.preferences }, updatedAt: stamp };
  if (displayName !== undefined) {
    if (displayName === null || (typeof displayName === 'string' && !displayName.trim())) delete next.displayName;
    else {
      const name = cleanName(displayName);
      if (!name) throw new ProfileError(`Use a display name of up to ${DISPLAY_NAME_LIMIT} characters without control characters.`);
      next.displayName = name;
    }
  }
  if (preferences !== undefined) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new ProfileError('The interface preferences are not valid.');
    for (const [key, value] of Object.entries(preferences as Record<string, unknown>)) {
      if (!(PREFERENCE_KEYS as readonly string[]).includes(key)) throw new ProfileError(`Unknown interface preference: ${key}.`);
      const field = key as keyof ProfilePreferences;
      if (value === null || value === undefined) { delete next.preferences[field]; continue; }
      if (!validPreference(field, value)) throw new ProfileError(`The ${key} preference is not valid.`);
      (next.preferences as Record<string, string>)[field] = value;
    }
  }
  return next;
}

export interface ProfileStore {
  get(): Promise<UserProfile>;
  save(patch: unknown): Promise<UserProfile>;
}

/**
 * Profile storage with serialized writes. The file is re-read before each
 * change so a save from another client of the same data directory is merged,
 * not lost. A damaged file is kept aside (`profile.damaged-<time>.json`).
 */
export function createProfileStore(configDirectory: string, now: () => string = () => new Date().toISOString()): ProfileStore {
  const file = path.join(configDirectory, PROFILE_FILE);
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<UserProfile> {
    let raw: unknown;
    try { raw = await readJson<unknown>(file, undefined); }
    catch {
      await rename(file, file.replace(/\.json$/, `.damaged-${Date.now()}.json`)).catch(() => undefined);
      return emptyProfile();
    }
    return decodeProfile(raw);
  }

  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    get: () => serialized(load),
    save: patch => serialized(async () => {
      const next = applyProfilePatch(await load(), patch, now());
      await writeJsonAtomic(file, next, { mode: PRIVATE_FILE_MODE });
      return next;
    }),
  };
}
