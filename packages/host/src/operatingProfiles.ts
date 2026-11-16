import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { decodeOperatingProfile, OPERATING_PROFILE_LIMITS, type OperatingProfile } from '@extalia/core';
import { normalizeOperatingProfileInput, type OperatingProfileInput } from '@extalia/platform';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

const SCHEMA = 'extalia.operating-profiles.v1';
export function createOperatingProfileStore(directory: string, now = () => new Date().toISOString()) {
  const file = path.join(directory, 'operating-profiles.json');
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => { const result = chain.then(work, work); chain = result.catch(() => undefined); return result; };
  async function load(): Promise<OperatingProfile[]> {
    let handle;
    try { handle = await open(file, 'r'); } catch (error) { if (isNotFound(error)) return []; throw error; }
    let raw: unknown;
    try {
      const buffer = Buffer.alloc(OPERATING_PROFILE_LIMITS.storeBytes + 1);
      let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead; }
      if (total > OPERATING_PROFILE_LIMITS.storeBytes) throw new Error('Operating profile store exceeds its size limit.');
      raw = JSON.parse(buffer.toString('utf8', 0, total));
    } finally { await handle.close(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid operating profile store; the file was left unchanged.');
    const value = raw as Record<string, unknown>;
    if (value.schema !== SCHEMA || Object.keys(value).some(key => !['schema', 'profiles'].includes(key)) || !Array.isArray(value.profiles) || value.profiles.length > OPERATING_PROFILE_LIMITS.profiles) throw new Error('Invalid operating profile store; the file was left unchanged.');
    const profiles = value.profiles.map(item => { const result = decodeOperatingProfile(item); if (!result.ok) throw new Error(result.errors.join(' ')); return result.value; });
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Duplicate operating profile ids.');
    return profiles;
  }
  async function write(profiles: OperatingProfile[]) {
    const value = { schema: SCHEMA, profiles };
    // Pretty printing is also budgeted: the reader and outbound catalog stay bounded.
    if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > OPERATING_PROFILE_LIMITS.storeBytes) throw new Error('Operating profiles exceed the 512 KiB library limit.');
    await writeJsonAtomic(file, value);
  }
  return {
    list: () => serialized(load),
    save: (raw: OperatingProfileInput, validate?: (candidate: OperatingProfile) => Promise<void> | void) => serialized(async () => {
      const input = normalizeOperatingProfileInput(raw), profiles = await load();
      const createId = input.createRequestId ? `op_${input.createRequestId}` : undefined;
      const replay = createId ? profiles.find(profile => profile.id === createId) : undefined;
      if (replay) {
        const payload = (profile: Pick<OperatingProfile, 'name' | 'purpose' | 'personality' | 'defaults'>) => ({ name: profile.name,
          ...(profile.purpose !== undefined ? { purpose: profile.purpose } : {}), ...(profile.personality !== undefined ? { personality: profile.personality } : {}), defaults: profile.defaults });
        if (!isDeepStrictEqual(payload(replay), payload(input))) throw new Error('This creation request already saved a different profile. Refresh before changing it.');
        return structuredClone(replay);
      }
      const previous = input.id ? profiles.find(profile => profile.id === input.id) : undefined;
      if (input.id && (!previous || previous.revision !== input.expectedRevision)) throw new Error('This operating profile changed. Refresh before saving.');
      if (!previous && profiles.length >= OPERATING_PROFILE_LIMITS.profiles) throw new Error('Keep at most 32 operating profiles.');
      const stamp = now();
      const decoded = decodeOperatingProfile({ id: previous?.id ?? createId ?? `op_${randomUUID()}`, name: input.name, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), ...(input.personality !== undefined ? { personality: input.personality } : {}), defaults: input.defaults });
      if (!decoded.ok) throw new Error(decoded.errors.join(' '));
      await validate?.(decoded.value);
      const next = previous ? profiles.map(profile => profile.id === previous.id ? decoded.value : profile) : [...profiles, decoded.value];
      await write(next); return structuredClone(decoded.value);
    }),
    delete: (id: string, expectedRevision: number, validate?: () => Promise<void> | void) => serialized(async () => {
      const profiles = await load(), previous = profiles.find(profile => profile.id === id);
      if (!previous || previous.revision !== expectedRevision) throw new Error('This operating profile changed. Refresh before deleting.');
      await validate?.(); await write(profiles.filter(profile => profile.id !== id));
    }),
  };
}
