import { CHARACTER_APPEARANCES_SCHEMA, type CharacterAppearance } from '@extalia/core';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const LOOK: CharacterAppearance = {
  presentation: 'masculine', hairStyle: 'side-part', hairColor: '#292426', skinTone: '#a9765e',
  outfit: 'executive', top: 'shirt', bottom: 'trousers', stature: 'default', gait: 'masculine',
  accessories: { glasses: 'none', watch: 'classic', earrings: 'none', bag: 'briefcase', tie: true, badge: true, headphones: false },
};

const tempDir = useTempDirs();
const running: AgentHostRuntime[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(runtime => runtime.close())); });

async function start(data: string) {
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: data, env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH } });
  running.push(runtime);
  return runtime;
}

/** A host with one saved managed session; returns that session's primary character id. */
async function hostWithSession() {
  const root = await tempDir();
  const project = path.join(root, 'project');
  await mkdir(project);
  const data = path.join(root, 'data');
  const runtime = await start(data);
  const { host } = runtime;
  const saved = await host.saveConnection({ name: 'Local', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const session = await host.createSession(state.workspaces[0]!.id);
  return { runtime, host, data, session, characterId: `${session.id}:primary`, file: path.join(data, 'state', 'character-appearances.json') };
}

describe('saved character appearances', () => {
  it('saves, lists and resets a look, and keeps it across a restart', async () => {
    const { runtime, host, data, characterId, file } = await hostWithSession();
    expect(await host.characterAppearances()).toEqual({});
    expect(await host.saveCharacterAppearance(characterId, LOOK)).toEqual({ [characterId]: LOOK });
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored).toEqual({ schema: CHARACTER_APPEARANCES_SCHEMA, characters: { [characterId]: LOOK } });

    await runtime.close();
    running.splice(running.indexOf(runtime), 1);
    const restarted = await start(data);
    expect(await restarted.host.characterAppearances()).toEqual({ [characterId]: LOOK });
    expect(await restarted.host.saveCharacterAppearance(characterId, null)).toEqual({});
  });

  it('rejects invalid ids, unknown sessions and invalid looks without changing the file', async () => {
    const { host, session, characterId, file } = await hostWithSession();
    await host.saveCharacterAppearance(characterId, LOOK);
    const before = await readFile(file, 'utf8');
    await expect(host.saveCharacterAppearance('primary', LOOK)).rejects.toThrow(/Choose a character/);
    await expect(host.saveCharacterAppearance('s_missing:primary', LOOK)).rejects.toThrow(/no longer exists/);
    await expect(host.saveCharacterAppearance(`${session.id}:worker`, { ...LOOK, gender: 'male' } as unknown as CharacterAppearance)).rejects.toThrow(/gender: unknown field/);
    await expect(host.saveCharacterAppearance(characterId, { ...LOOK, hairColor: 'black' })).rejects.toThrow(/hairColor/);
    await expect(host.saveCharacterAppearance(characterId, { ...LOOK, heightCm: 250 })).rejects.toThrow(/heightCm/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('prunes looks of deleted sessions when listing', async () => {
    const { host, session, characterId, file } = await hostWithSession();
    await host.saveCharacterAppearance(characterId, LOOK);
    await host.saveCharacterAppearance(`${session.id}:worker-1`, { ...LOOK, gait: 'feminine' });
    await host.deleteSession(session.id);
    expect(await host.characterAppearances()).toEqual({});
    expect(JSON.parse(await readFile(file, 'utf8')).characters).toEqual({});
  });

  it('keeps a damaged or invalid file aside and starts empty', async () => {
    for (const content of ['{ not json', JSON.stringify({ schema: CHARACTER_APPEARANCES_SCHEMA, characters: { 's_1:primary': { ...LOOK, extra: 1 } } })]) {
      const root = await tempDir();
      const data = path.join(root, 'data');
      await mkdir(path.join(data, 'state'), { recursive: true });
      await writeFile(path.join(data, 'state', 'character-appearances.json'), content);
      const { host } = await start(data);
      expect(await host.characterAppearances()).toEqual({});
      const files = await readdir(path.join(data, 'state'));
      const aside = files.find(name => /^character-appearances\.damaged-\d+\.json$/.test(name));
      expect(aside).toBeDefined();
      expect(await readFile(path.join(data, 'state', aside!), 'utf8')).toBe(content);
      expect(files).not.toContain('character-appearances.json');
    }
  });
});
