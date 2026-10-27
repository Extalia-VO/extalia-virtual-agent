import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermesModelCatalog, parseHermesModelBlock } from '../src/hermes.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const KEY = ['sk', 'local', 'x'.repeat(12)].join('-');

async function home(files: Record<string, string>) {
  const dir = await temp('extalia-hermes-models-');
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, '.hermes', relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return dir;
}

const LOCAL = `model:\n  default: "ag/gemini-3.8-flash-high"\n  provider: "custom"\n  base_url: "http://localhost:20128/v1"\n  api_key: "${KEY}"\nagent:\n  provider: ''\n`;

describe('Hermes model catalog', () => {
  it('reads the model block in both forms and ignores later sections', () => {
    expect(parseHermesModelBlock(LOCAL)).toEqual({ default: 'ag/gemini-3.8-flash-high', provider: 'custom', baseUrl: 'http://localhost:20128/v1', apiKey: KEY });
    expect(parseHermesModelBlock('model: anthropic/claude-sonnet # pinned\n')).toEqual({ default: 'anthropic/claude-sonnet' });
    expect(parseHermesModelBlock('agent:\n  model: nope\n')).toEqual({});
  });

  it('lists the models of a local endpoint, sends the key only there, and never returns it', async () => {
    const dir = await home({ 'config.yaml': LOCAL, 'profiles/elena/config.yaml': LOCAL.replace('ag/gemini-3.8-flash-high', 'or/qwen') });
    const calls: { url: string; auth?: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ data: [{ id: 'b/model' }, { id: 'a/model' }, { id: 'a/model' }, { id: 42 }] }), { status: 200 });
    }) as typeof fetch;
    const catalog = await hermesModelCatalog({}, dir, 'default', fake);
    expect(catalog).toEqual({ profile: 'default', defaultModel: 'ag/gemini-3.8-flash-high', provider: 'custom', endpoint: 'localhost:20128', models: ['a/model', 'b/model'], source: 'endpoint' });
    expect(calls).toEqual([{ url: 'http://localhost:20128/v1/models', auth: `Bearer ${KEY}` }]);
    expect(JSON.stringify(catalog)).not.toContain(KEY);
    expect((await hermesModelCatalog({}, dir, 'elena', fake)).defaultModel).toBe('or/qwen');
  });

  it('never queries a remote provider and reports an unreachable local one', async () => {
    const dir = await home({ 'config.yaml': 'model:\n  default: anthropic/claude\n  provider: anthropic\n  base_url: https://api.example.com/v1\n', 'profiles/off/config.yaml': LOCAL });
    let called = 0;
    const fake = (async () => { called++; throw new Error('down'); }) as typeof fetch;
    expect(await hermesModelCatalog({}, dir, 'default', fake)).toEqual({ profile: 'default', defaultModel: 'anthropic/claude', provider: 'anthropic', models: [], source: 'config' });
    expect(called).toBe(0);
    expect(await hermesModelCatalog({}, dir, 'off', fake)).toMatchObject({ defaultModel: 'ag/gemini-3.8-flash-high', endpoint: 'localhost:20128', models: [], source: 'config', error: 'unreachable' });
    expect(called).toBe(1);
  });

  it('rejects profile names that could leave the profiles folder', async () => {
    const dir = await home({});
    await expect(hermesModelCatalog({}, dir, '../secrets')).rejects.toThrow('Unknown Hermes profile.');
    expect(await hermesModelCatalog({}, dir, 'default')).toEqual({ profile: 'default', models: [], source: 'none', error: 'config-missing' });
  });
});
