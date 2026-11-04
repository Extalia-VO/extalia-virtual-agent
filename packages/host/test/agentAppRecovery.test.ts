import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
let runtime: AgentHostRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

describe('recoverAgentAppConnection', () => {
  it('validates the action at the boundary and previews without writing', async () => {
    const root = await temp('extalia-agent-app-recovery-');
    const homeDirectory = path.join(root, 'home');
    const dataDirectory = path.join(root, 'data');
    await mkdir(homeDirectory);
    runtime = await createAgentHost({
      kind: 'desktop', version: '0.0.0-test', homeDirectory, importHome: homeDirectory, dataDirectory,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' },
    });
    const recover = runtime.host.recoverAgentAppConnection!;
    for (const bad of ['', 'delete', 'Rollback', undefined, 1, null, {}]) {
      await expect(recover(bad as never)).rejects.toThrow(/preview, roll back or keep/);
    }
    await expect(recover('preview')).resolves.toEqual({ action: 'preview', restored: [], resolved: false });
    await expect(recover('keep')).resolves.toMatchObject({ action: 'keep', restored: [] });
  });
});
