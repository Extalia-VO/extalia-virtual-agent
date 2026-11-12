import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { executableLaunchPlan, npmNodeShimTarget } from '../src/npmCommand.js';

const fixture = (version: string) => readFile(new URL(`./fixtures/executable-discovery/npm-${version}.cmd`, import.meta.url), 'utf8');
const bin = String.raw`C:\Tools Folder\example-cli.cmd`;
const node = String.raw`C:\Standalone Node\node.exe`;
const script = String.raw`C:\Tools Folder\node_modules\example-cli\bin\cli.js`;

describe('safe native/npm executable launch plans', () => {
  it.each(['7.0.0', '9.0.2'])('recognizes a real generated upstream cmd-shim %s fixture and keeps all user arguments literal', async version => {
    const text = await fixture(version);
    expect(npmNodeShimTarget(text)).toBe(String.raw`node_modules\example-cli\bin\cli.js`);
    const args = ['chat', '--query', 'keep "quotes" & %PATH% !delayed! | $(command)\nsecond line', ''];
    const plan = await executableLaunchPlan(bin, args, { platform: 'win32', readShim: async () => text,
      checkScript: async file => file === script, checkExecutable: async file => file === node, resolveNode: async () => node });
    expect(plan).toEqual({ command: node, args: [script, ...args] });
    expect(plan).not.toHaveProperty('shell');
    expect(plan.args).not.toBe(args);
  });

  it('uses the standard npm adjacent Node before an external resolver', async () => {
    const resolveNode = vi.fn(async () => node), local = String.raw`C:\Tools Folder\node.exe`;
    const plan = await executableLaunchPlan(bin, [], { platform: 'win32', readShim: () => fixture('9.0.2'), checkScript: async () => true,
      checkExecutable: async file => file === local, resolveNode });
    expect(plan.command).toBe(local); expect(resolveNode).not.toHaveBeenCalled();
  });

  it.each(['extra-effect', 'different-runtime', 'node-flags', 'expanded-target', 'oversize'] as const)('refuses modified/unsupported wrappers (%s) without invoking a shell', async mutation => {
    const original = await fixture('7.0.0');
    const text = mutation === 'extra-effect' ? `${original}\r\necho an extra effect\r\n`
      : mutation === 'different-runtime' ? original.replaceAll('node', 'python')
        : mutation === 'node-flags' ? original.replace('"%_prog%"', '"%_prog%" --require injected.js')
          : mutation === 'expanded-target' ? original.replace('example-cli', '%UNTRUSTED%') : 'x'.repeat(32_769);
    const resolver = vi.fn(async () => node);
    expect(npmNodeShimTarget(text)).toBeUndefined();
    await expect(executableLaunchPlan(bin, ['untrusted & prompt'], { platform: 'win32', readShim: async () => text, resolveNode: resolver })).rejects.toThrow(/not a supported npm Node shim/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses a missing JavaScript target and missing standalone Node', async () => {
    const base = { platform: 'win32', readShim: () => fixture('9.0.2'), checkExecutable: async () => false };
    await expect(executableLaunchPlan(bin, [], { ...base, checkScript: async () => false })).rejects.toThrow(/unavailable JavaScript/);
    await expect(executableLaunchPlan(bin, [], { ...base, checkScript: async () => true, resolveNode: async () => undefined })).rejects.toThrow(/standalone Node/);
  });

  it('keeps native/POSIX launch arguments as separate copied strings', async () => {
    expect(await executableLaunchPlan(String.raw`C:\Tools\hermes.exe`, ['chat', 'literal & prompt'], { platform: 'win32' }))
      .toEqual({ command: String.raw`C:\Tools\hermes.exe`, args: ['chat', 'literal & prompt'] });
    expect(await executableLaunchPlan('/tmp/example/hermes', ['chat'], { platform: 'linux' })).toEqual({ command: '/tmp/example/hermes', args: ['chat'] });
    await expect(executableLaunchPlan(String.raw`C:\Tools\example.ps1`, [], { platform: 'win32' })).rejects.toThrow(/not a supported/);
  });
});
