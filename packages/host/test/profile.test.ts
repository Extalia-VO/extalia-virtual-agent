import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProfilePatch, createAgentHost, createProfileStore, decodeProfile, emptyProfile } from '../src/index.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const STAMP = '2026-10-01T00:00:00.000Z';

describe('profile decoding and patches', () => {
  it('keeps valid fields and drops invalid ones from a stored file', () => {
    expect(decodeProfile({ schema: 'extalia.profile.v1', displayName: '  Ada   L. ', preferences: { language: 'id', theme: 'dark', material: 'liquid-glass-pro', font: 'Bad Font', sidebar: 7, extra: 'x' }, updatedAt: STAMP }))
      .toEqual({ schema: 'extalia.profile.v1', displayName: 'Ada L.', preferences: { language: 'id', theme: 'dark', material: 'liquid-glass-pro' }, updatedAt: STAMP });
    expect(decodeProfile({ preferences: { language: 'fr' }, displayName: 'x'.repeat(81), updatedAt: 'yesterday' })).toEqual(emptyProfile());
    expect(decodeProfile(null)).toEqual(emptyProfile());
    expect(decodeProfile([1])).toEqual(emptyProfile());
  });

  it('merges a patch, clears fields with null or an empty name, and refuses malformed input as a whole', () => {
    const base = applyProfilePatch(emptyProfile(), { displayName: 'Ada', preferences: { language: 'en', theme: 'solar' } }, STAMP);
    expect(base).toEqual({ schema: 'extalia.profile.v1', displayName: 'Ada', preferences: { language: 'en', theme: 'solar' }, updatedAt: STAMP });
    expect(applyProfilePatch(base, { preferences: { theme: 'dark', font: 'inter' } }, STAMP).preferences).toEqual({ language: 'en', theme: 'dark', font: 'inter' });
    expect(applyProfilePatch(base, { displayName: '', preferences: { theme: null } }, STAMP)).toEqual({ schema: 'extalia.profile.v1', preferences: { language: 'en' }, updatedAt: STAMP });
    for (const bad of [null, 'x', [], { preferences: { language: 'fr' } }, { preferences: { theme: '../../etc' } }, { preferences: { colour: 'red' } }, { preferences: 'dark' }, { displayName: 'a\u0007b' }, { displayName: 7 }, { avatar: 'x' }]) {
      expect(() => applyProfilePatch(base, bad, STAMP)).toThrow();
    }
  });
});

describe('profile store', () => {
  it('starts empty, saves atomically with mode 0600, and serializes concurrent saves', async () => {
    const config = path.join(await temp(), 'config');
    const store = createProfileStore(config, () => STAMP);
    expect(await store.get()).toEqual(emptyProfile());
    await Promise.all([store.save({ preferences: { theme: 'dark' } }), store.save({ preferences: { language: 'id' } }), store.save({ displayName: 'Ada' })]);
    const saved = await store.get();
    expect(saved).toEqual({ schema: 'extalia.profile.v1', displayName: 'Ada', preferences: { theme: 'dark', language: 'id' }, updatedAt: STAMP });
    expect(JSON.parse(await readFile(path.join(config, 'profile.json'), 'utf8'))).toEqual(saved);
    if (process.platform !== 'win32') expect((await stat(path.join(config, 'profile.json'))).mode & 0o777).toBe(0o600);
    expect((await readdir(config)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await expect(store.save({ preferences: { language: 'fr' } })).rejects.toThrow(/language/);
    expect(await store.get()).toEqual(saved);
  });

  it('picks up changes another client wrote and keeps a damaged file aside', async () => {
    const config = path.join(await temp(), 'config');
    await mkdir(config, { recursive: true });
    const store = createProfileStore(config, () => STAMP);
    await writeFile(path.join(config, 'profile.json'), JSON.stringify({ schema: 'extalia.profile.v1', preferences: { font: 'geist' }, updatedAt: STAMP }));
    expect((await store.save({ preferences: { theme: 'light' } })).preferences).toEqual({ font: 'geist', theme: 'light' });
    await writeFile(path.join(config, 'profile.json'), '{not json');
    expect(await store.get()).toEqual(emptyProfile());
    expect((await readdir(config)).some(name => /^profile\.damaged-\d+\.json$/.test(name))).toBe(true);
  });
});

describe('agent host profile API and welcome setup version', () => {
  it('serves the profile, reports the data folder, and asks configs from older setups to run the welcome setup once', async () => {
    const root = await temp();
    const data = path.join(root, 'data');
    await mkdir(path.join(data, 'config'), { recursive: true });
    const connection = { id: 'c_1', profileId: 'default', name: 'Local', preset: 'custom', api: 'openai-chat', baseUrl: 'http://localhost:9/v1', model: 'm', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off' }, createdAt: STAMP, updatedAt: STAMP };
    await writeFile(path.join(data, 'config', 'extalia.json'), JSON.stringify({ schema: 'extalia.host-config.v1', setupComplete: true, workflow: 'managed', profile: { id: 'default', name: 'Personal' }, connections: [connection], workspaces: [] }));
    const options = { kind: 'bridge' as const, version: 'test', dataDirectory: data, importHome: root, env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH } };

    let runtime = await createAgentHost(options);
    try {
      const { host } = runtime;
      const state = await host.getState();
      expect(state).toMatchObject({ setupComplete: false, dataDirectory: data, connections: [{ id: 'c_1' }] });
      expect(await host.getProfile()).toEqual(emptyProfile());
      const saved = await host.saveProfile({ displayName: 'Ada', preferences: { language: 'id', theme: 'dark' } });
      expect(saved).toMatchObject({ displayName: 'Ada', preferences: { language: 'id', theme: 'dark' } });
      await expect(host.saveProfile({ preferences: { language: 'fr' } } as never)).rejects.toThrow();
      // Switching workflows does not finish the welcome setup in managed mode; completing it does.
      expect((await host.setWorkflow('managed')).setupComplete).toBe(false);
      expect((await host.completeSetup('observe')).setupComplete).toBe(true);
      expect(JSON.parse(await readFile(path.join(data, 'config', 'extalia.json'), 'utf8'))).toMatchObject({ setupComplete: true, setupVersion: 2 });
    } finally { await runtime.close(); }

    runtime = await createAgentHost(options);
    try {
      expect((await runtime.host.getState()).setupComplete).toBe(true);
      expect((await runtime.host.getProfile()).displayName).toBe('Ada');
    } finally { await runtime.close(); }
  });

  it('marks setup complete when the observe workflow is chosen', async () => {
    const root = await temp();
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), importHome: root, env: { EXTALIA_SECRET_STORE: 'memory' } });
    try {
      expect((await runtime.host.getState()).setupComplete).toBe(false);
      expect((await runtime.host.setWorkflow('observe')).setupComplete).toBe(true);
    } finally { await runtime.close(); }
  });
});
