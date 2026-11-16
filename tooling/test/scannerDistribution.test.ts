import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCANNER_BINDING, copyScannerBundle, createScannerBinding, verifyScannerBinding, verifyScannerBundle, verifyScannerSignatures, writeScannerBinding } from '../scanner-distribution.mjs';
import { verifyPackagedScanner } from '../../apps/desktop/scripts/after-pack.mjs';

const temporary: string[] = [];
const target = { platform: 'darwin', arch: 'arm64' };
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(platform = 'darwin') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-scanner-distribution-')); temporary.push(root);
  const bundle = path.join(root, 'skillspector'), binary = path.join(root, 'extalia-daemon');
  await mkdir(path.join(bundle, 'payload', 'python', 'bin'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'worker'));
  // Header-only fixture: architecture detection is real, but this is never executable code.
  const interpreter = Buffer.alloc(64);
  if (platform === 'darwin') { interpreter.writeUInt32LE(0xfeedfacf, 0); interpreter.writeUInt32LE(0x0100000c, 4); }
  else { interpreter.writeUInt32BE(0x7f454c46, 0); interpreter.writeUInt16LE(183, 18); }
  const files = [{ path: 'python/bin/python3.13', body: interpreter, executable: true }, { path: 'worker/scan.py', body: 'Synthetic worker; never executed.', executable: false }];
  for (const file of files) { const absolute = path.join(bundle, 'payload', file.path); await writeFile(absolute, file.body); await chmod(absolute, file.executable ? 0o755 : 0o644); }
  const manifest = { schema_version: 1, target: { os: platform === 'darwin' ? 'macos' : 'linux', arch: 'aarch64' }, runtime_version: '3.13.18', scanner_version: '2.13.4', source_commit: '54824463814a0be01360792523ec7245a69190fc', normalizer_version: 'extalia-skillspector-v1', interpreter: files[0]!.path, entry_script: files[1]!.path,
    files: files.map(({ path, body, executable }) => ({ path, bytes: Buffer.byteLength(body), sha256: digest(body), executable })) };
  await writeFile(path.join(bundle, 'bundle-manifest.json'), JSON.stringify(manifest));
  await writeFile(binary, 'Synthetic daemon; never executed.');
  const bindingFile = path.join(root, SCANNER_BINDING), binding = await createScannerBinding(binary, bundle, { platform, arch: 'arm64' }); await writeScannerBinding(bindingFile, binding);
  return { root, bundle, binary, bindingFile, binding };
}

describe('pinned scanner distribution pairing', () => {
  it('binds the exact daemon and manifest and refuses a different binary or target', async () => {
    const fixtureData = await fixture();
    await expect(verifyScannerBinding({ ...fixtureData, target })).resolves.toEqual(fixtureData.binding);
    await expect(verifyScannerBinding({ ...fixtureData, target: { platform: 'darwin', arch: 'x64' } })).rejects.toThrow();
    await writeFile(fixtureData.binary, 'Different binary bytes');
    await expect(verifyScannerBinding({ ...fixtureData, target })).rejects.toThrow('daemon does not match');
  });
  it('rejects changed payloads even when the original manifest itself remains unchanged', async () => {
    const f = await fixture(); await writeFile(path.join(f.bundle, 'payload', 'worker', 'scan.py'), 'Changed source');
    await expect(verifyScannerBinding({ ...f, target })).rejects.toThrow();
  });
  it('retains scanner hash verification after outer signing changes only the daemon', async () => {
    const f = await fixture(); await writeFile(f.binary, 'Codesigned daemon bytes');
    await expect(verifyScannerBinding({ ...f, target, verifyDaemon: false })).resolves.toEqual(f.binding);
    await writeFile(path.join(f.bundle, 'payload', 'worker', 'scan.py'), 'Changed source');
    await expect(verifyScannerBinding({ ...f, target, verifyDaemon: false })).rejects.toThrow();
  });
  it('copies verified bundles and preserves unrelated files beside the managed destination', async () => {
    const f = await fixture(), directory = path.join(f.root, 'output'), destination = path.join(directory, 'skillspector');
    await mkdir(directory); await writeFile(path.join(directory, 'keep.txt'), 'Unrelated file');
    await copyScannerBundle(f.bundle, destination, target, f.binding.manifestSha256);
    await copyScannerBundle(f.bundle, destination, target, f.binding.manifestSha256);
    await expect(verifyScannerBundle(destination, target, f.binding.manifestSha256)).resolves.toBeDefined();
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('Unrelated file');
  });
  it('never replaces an unrelated directory at the bundle destination', async () => {
    const f = await fixture(), destination = path.join(f.root, 'unrelated'); await mkdir(destination); await writeFile(path.join(destination, 'keep.txt'), 'Keep');
    await expect(copyScannerBundle(f.bundle, destination, target, f.binding.manifestSha256)).rejects.toThrow();
    expect(await readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('Keep');
  });
  it.skipIf(process.platform === 'win32')('refuses a symlink destination without modifying its target', async () => {
    const f = await fixture(), destination = path.join(f.root, 'link'); await symlink(f.bundle, destination, 'dir');
    await expect(copyScannerBundle(f.bundle, destination, target, f.binding.manifestSha256)).rejects.toThrow();
    await expect(verifyScannerBundle(f.bundle, target, f.binding.manifestSha256)).resolves.toBeDefined();
  });
  it.skipIf(process.platform !== 'darwin')('requires Developer ID signatures for notarized distributions', async () => {
    const f = await fixture(); const file = path.join(f.bundle, 'payload', 'python', 'bin', 'python3.13'); const macho = Buffer.alloc(64); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4); await writeFile(file, macho);
    const run = (_command: string, args: string[]) => ({ status: 0, stdout: '', stderr: args[0] === '--display' ? 'Signature=adhoc\nTeamIdentifier=not set' : '' });
    await expect(verifyScannerSignatures(f.bundle, target, true, run)).rejects.toThrow('pre-signed with Developer ID');
    await expect(verifyScannerSignatures(f.bundle, target, false, run)).resolves.toBeUndefined();
  });
  it('includes the matching scanner and notices in the generated npm platform package', async () => {
    const packageTarget = { platform: 'linux', arch: 'arm64' };
    const f = await fixture('linux'), artifacts = path.join(f.root, 'artifacts'), source = path.join(artifacts, 'linux-arm64'); await mkdir(source, { recursive: true });
    const binary = path.join(source, 'extalia-daemon'); const macho = Buffer.alloc(64); macho.writeUInt32BE(0x7f454c46); macho.writeUInt16LE(183, 18); await writeFile(binary, macho);
    await copyScannerBundle(f.bundle, path.join(source, 'skillspector'), packageTarget, f.binding.manifestSha256);
    await writeScannerBinding(path.join(source, SCANNER_BINDING), await createScannerBinding(binary, path.join(source, 'skillspector'), packageTarget));
    const output = path.join(f.root, 'npm');
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../apps/cli/npm/generate.mjs', import.meta.url)), '--binaries', artifacts, '--out', output, '--require-scanner-target', 'linux-arm64']);
    const packageRoot = path.join(output, 'daemon-linux-arm64');
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('skillspector'); expect(manifest.files).toContain(SCANNER_BINDING);
    expect(await readFile(path.join(packageRoot, 'README.md'), 'utf8')).toContain('No system Python');
    await expect(verifyScannerBinding({ binary: path.join(packageRoot, 'bin', 'extalia-daemon'), bundle: path.join(packageRoot, 'skillspector'), bindingFile: path.join(packageRoot, SCANNER_BINDING), target: packageTarget })).resolves.toBeDefined();
  });
  it('stages only named daemon outputs without deleting unrelated files in either output directory', async () => {
    const f = await fixture(), sandbox = path.join(f.root, 'repository'); await mkdir(path.join(sandbox, 'tooling'), { recursive: true });
    for (const name of ['build-daemon.mjs', 'daemon.mjs', 'workspace.mjs', 'scanner-distribution.mjs']) await copyFile(new URL(`../${name}`, import.meta.url), path.join(sandbox, 'tooling', name));
    await writeFile(path.join(sandbox, 'package.json'), '{"version":"1.2.3"}');
    const platform = process.platform === 'linux' ? 'win32' : 'linux', artifactTarget = `${platform}-x64`, binaryName = platform === 'win32' ? 'extalia-daemon.exe' : 'extalia-daemon';
    const staged = path.join(sandbox, 'apps', 'desktop', 'build-resources', 'daemon', `${platform === 'win32' ? 'win' : 'linux'}-x64`), output = path.join(sandbox, 'output', artifactTarget);
    for (const directory of [staged, output]) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'unrelated.txt'), 'Keep this file'); }
    const source = path.join(sandbox, 'synthetic-foreign-executable'), bytes = Buffer.alloc(128);
    if (platform === 'win32') { bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); }
    else { bytes.writeUInt32BE(0x7f454c46); bytes.writeUInt16LE(62, 18); }
    await writeFile(source, bytes);
    await promisify(execFile)(process.execPath, [path.join(sandbox, 'tooling', 'build-daemon.mjs'), '--target', artifactTarget, '--from', source, '--out', path.join(sandbox, 'output')]);
    for (const directory of [staged, output]) { expect(await readFile(path.join(directory, 'unrelated.txt'), 'utf8')).toBe('Keep this file'); expect(await readFile(path.join(directory, binaryName))).toEqual(bytes); }
  });
  it('refuses a release missing its required scanner without imposing that capability on unsupported targets', async () => {
    const f = await fixture(), resources = path.join(f.root, 'empty-resources'); await mkdir(resources);
    const context = { appOutDir: f.root, electronPlatformName: 'darwin', arch: 3, packager: { getResourcesDir: () => resources, config: { extraMetadata: { extaliaMacReleaseMode: 'preview' } } } };
    vi.stubEnv('EXTALIA_REQUIRE_SKILLSPECTOR_TARGETS', 'darwin-arm64');
    await expect(verifyPackagedScanner(context)).rejects.toThrow('required for darwin-arm64');
    await expect(verifyPackagedScanner({ ...context, electronPlatformName: 'linux', arch: 1 })).resolves.toBeUndefined();
  });
  it('refuses an orphan scanner binding even when the scanner is optional', async () => {
    const f = await fixture(), resources = path.join(f.root, 'empty-resources'); await mkdir(path.join(resources, 'daemon'), { recursive: true });
    await writeFile(path.join(resources, 'daemon', SCANNER_BINDING), '{}'); vi.stubEnv('EXTALIA_REQUIRE_SKILLSPECTOR_TARGETS', '');
    const context = { appOutDir: f.root, electronPlatformName: 'darwin', arch: 3, packager: { getResourcesDir: () => resources, config: {} } };
    await expect(verifyPackagedScanner(context)).rejects.toThrow('Incomplete packaged scanner');
  });
});
