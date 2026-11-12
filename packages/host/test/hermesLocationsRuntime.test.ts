import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createConnectService } from '../src/connect/service.js';
import { discoverRuntimes, hermesEnvironment, hermesModelCatalog, runHermesTurn } from '../src/hermes.js';
import { hermesDelegationLimits } from '../src/hermesDelegation.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
describe('Hermes installation and explicit profile coherence', () => {
  it.skipIf(process.platform === 'win32')('reads the explicit named profile and launches that profile from a different project directory', async () => {
    const root = await temp('extalia-hermes-profile-location-');
    const home = path.join(root, 'home'), installation = path.join(root, 'hermes'), profile = path.join(installation, 'profiles', 'team');
    const project = path.join(root, 'project');
    await Promise.all([mkdir(home), mkdir(profile, { recursive: true }), mkdir(project)]);
    await writeFile(path.join(installation, 'config.yaml'), 'model: example/root\ndelegation:\n  oneshot_max_children: 1\n');
    await writeFile(path.join(profile, 'config.yaml'), 'model: example/team\ndelegation:\n  oneshot_max_children: 2\n  max_concurrent_children: 2\n');
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const script = path.join(bin, 'hermes');
    await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
process.stdin.resume(); process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.env.HERMES_HOME, 'launch.json'), JSON.stringify({home:process.env.HERMES_HOME,args:process.argv.slice(2),cwd:process.cwd()}));
  console.log(JSON.stringify({type:'result',session_id:'example-session',exit_code:0,text:'Done',tokens:{input:0,output:0,total:0,cache_read:0,cache_write:0},duration_ms:1}));
});
`); await chmod(script, 0o755);
    const env = { HOME: home, HERMES_HOME: profile, HERMES_MANAGED_DIR: path.join(root, 'no-managed'), PATH: path.dirname(process.execPath) };
    expect((await hermesModelCatalog(env, home, 'default')).defaultModel).toBe('example/team');
    expect((await hermesDelegationLimits(env, home, 'default')).oneshotMaxChildren).toBe(2);
    const result = await runHermesTurn({ executable: script, cwd: project, homeDirectory: home, profile: 'default', prompt: 'Check profile isolation.',
      env, signal: new AbortController().signal, yolo: false, emit: () => undefined });
    expect(result.outcome).toBe('completed');
    expect(JSON.parse(await readFile(path.join(installation, 'launch.json'), 'utf8'))).toMatchObject({ home: installation, args: expect.arrayContaining(['-p', 'team']), cwd: await realpath(project) });
  });

  it('normalizes Windows child environment casing without losing PATH or the selected installation', () => {
    expect(hermesEnvironment({ Path: 'D:\\Tools', LocalAppData: 'D:\\Local', SystemRoot: 'C:\\Windows' }, 'D:\\Home', 'win32'))
      .toMatchObject({ PATH: 'D:\\Tools', LOCALAPPDATA: 'D:\\Local', SYSTEMROOT: 'C:\\Windows', HERMES_HOME: 'D:\\Local\\hermes' });
  });

  it.each(['relative', 'unresolved'] as const)('rejects an invalid %s home without reading/writing that location or hiding other integrations', async kind => {
    const root = await temp('extalia-invalid-agent-location-');
    const home = path.join(root, 'home'), data = path.join(root, 'data'); await mkdir(home);
    const invalid = kind === 'relative' ? path.relative(process.cwd(), path.join(root, 'candidate')) : path.join(root, '%EXTALIA_MISSING_TEST_HOME%', 'candidate');
    const run = vi.fn(async () => ({ code: 0, stdout: 'Hermes 0.21.0', stderr: '' }));
    const env = { HERMES_HOME: invalid, EXTALIA_HERMES_BIN: process.execPath, PATH: '', HOME: home };
    const connector = createConnectService({ platform: process.platform, homeDirectory: home, extaliaHome: data, env, run,
      findBinary: async () => undefined, nodePath: process.execPath });
    const connections = await connector.connections();
    expect(connections).toHaveLength(5);
    const hermes = connections.find(item => item.app === 'hermes')!;
    expect(hermes).toMatchObject({ installed: false, connected: false });
    expect(hermes.configPath).toBeUndefined(); expect(hermes.warnings.join(' ')).toMatch(/absolute|environment/i);
    await expect(connector.plan('hermes')).rejects.toThrow(/absolute|environment/i);
    await expect(connector.apply('hermes')).rejects.toThrow(/absolute|environment/i);
    expect((await discoverRuntimes(env, home)).find(item => item.id === 'hermes')?.available).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, 'candidate', 'config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
