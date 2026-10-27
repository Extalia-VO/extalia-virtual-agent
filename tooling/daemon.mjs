/**
 * Shared facts about the packaged `extalia-daemon` binary (ADR 0021, owner decision 9):
 * release targets, where each artifact is staged, how a binary is recognised, a minimal
 * `hello` round trip and the "clean machine" environment. Used by build-daemon, the
 * electron-builder hooks, the packaged smoke test and the npm platform packages.
 *
 * Runtime lookup (implemented by the host, not here):
 * - packaged Desktop: `<process.resourcesPath>/daemon/extalia-daemon[.exe]`;
 * - CLI: the optional npm package `@extalia/daemon-<platform>-<arch>`, whose main module
 *   exports the absolute binary path;
 * - development: `<repo>/target/{debug,release}/extalia-daemon`, or `EXTALIA_DAEMON_PATH`.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './workspace.mjs';

/**
 * Every target a release builds. `platform`/`arch` follow Node (`process.platform`,
 * `process.arch`) and name the npm package; `builderOs` is electron-builder's `${os}`
 * macro, so the Desktop staging folder is `<builderOs>-<arch>` (`${os}-${arch}`).
 * `desktop: false`: built for the CLI only (Extalia Desktop ships no Linux arm64 build).
 */
export const DAEMON_TARGETS = [
  { triple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64', builderOs: 'mac', desktop: true },
  { triple: 'x86_64-apple-darwin', platform: 'darwin', arch: 'x64', builderOs: 'mac', desktop: true },
  { triple: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64', builderOs: 'win', desktop: true },
  { triple: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64', builderOs: 'linux', desktop: true },
  { triple: 'aarch64-unknown-linux-gnu', platform: 'linux', arch: 'arm64', builderOs: 'linux', desktop: false },
];

/** Staged binaries for electron-builder (git-ignored); `extraResources` copies one into `daemon/`. */
export const DESKTOP_STAGING = path.join(ROOT, 'apps', 'desktop', 'build-resources', 'daemon');

export const daemonBinaryName = platform => (platform === 'win32' ? 'extalia-daemon.exe' : 'extalia-daemon');
export const npmPackageName = target => `@extalia/daemon-${target.platform}-${target.arch}`;
export const stagedBinary = target => path.join(DESKTOP_STAGING, `${target.builderOs}-${target.arch}`, daemonBinaryName(target.platform));

export function findTarget(query) {
  return DAEMON_TARGETS.find(target => target.triple === query || `${target.platform}-${target.arch}` === query);
}

const MACHO_CPU = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']]);
const ELF_MACHINE = new Map([[62, 'x64'], [183, 'arm64']]);
const PE_MACHINE = new Map([[0x8664, 'x64'], [0xaa64, 'arm64']]);

/** Format and architecture of an executable's first bytes (at least 4 KiB for PE), or undefined. */
export function executableKind(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && view.getUint32(0, true) === 0xfeedfacf) return { platform: 'darwin', arch: MACHO_CPU.get(view.getUint32(4, true)) };
  if (bytes.length >= 8 && view.getUint32(0) === 0xcafebabe) return { platform: 'darwin', arch: 'universal' };
  if (bytes.length >= 20 && view.getUint32(0) === 0x7f454c46) return { platform: 'linux', arch: ELF_MACHINE.get(view.getUint16(18, true)) };
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = view.getUint32(0x3c, true);
    if (pe + 6 <= bytes.length && view.getUint32(pe) === 0x50450000) return { platform: 'win32', arch: PE_MACHINE.get(view.getUint16(pe + 4, true)) };
  }
  return undefined;
}

export async function readExecutableKind(file) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    return executableKind(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * A process environment with no developer toolchain: PATH holds only an empty folder
 * (plus the Windows system folders), HOME is a fresh folder (so ~/.cargo, ~/.rustup and
 * user Python installs are invisible) and toolchain variables are dropped. Display and
 * temp variables survive so a GUI app can start under xvfb.
 */
export async function cleanMachineEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'extalia-clean-home-'));
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), 'extalia-clean-path-'));
  const keep = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'] : [];
  env.PATH = [emptyBin, ...system].join(path.delimiter);
  env.HOME = home;
  if (process.platform === 'win32') { env.USERPROFILE = home; env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local'); }
  return { env, cleanup: () => Promise.all([rm(home, { recursive: true, force: true }), rm(emptyBin, { recursive: true, force: true })]) };
}

/** Developer tools that must not resolve in the clean environment (`node` too for Desktop). */
export const TOOLCHAIN_COMMANDS = ['cargo', 'rustc', 'rustup', 'python', 'python3', 'pip', 'pip3', 'uv', 'node', 'npm', 'npx', 'pnpm'];

/** Toolchain commands that still resolve on the environment's PATH (should be none). */
export function resolvableCommands(env, commands = TOOLCHAIN_COMMANDS) {
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
  return commands.flatMap(command => dirs.flatMap(dir => extensions.map(extension => path.join(dir, command + extension))).find(isFile) ?? []);
}

const HELLO_ID = '00000000-0000-4000-8000-0000000000e1';

/**
 * Spawn the daemon with a throwaway `--data-dir`, send `hello`, check the response and
 * close stdin; the daemon must then exit 0. Minimal inline framing (u32 big-endian length
 * + UTF-8 JSON), the same wire contract as `@extalia/protocol`'s daemon frame helpers.
 */
export async function daemonHello(binary, { env = process.env, timeoutMs = 15_000 } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'extalia-daemon-smoke-'));
  try {
    const child = spawn(binary, ['--data-dir', dataDir], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'request', requestId: HELLO_ID, op: 'hello', params: { clientVersion: '0.0.0-smoke', capabilities: ['hello', 'health'] } }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    child.stdin.write(Buffer.concat([header, payload]));
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`daemon did not answer hello within ${timeoutMs} ms`)); }, timeoutMs); });
    const response = await Promise.race([readFrame(child.stdout), timeout, exited.then(({ code, signal }) => { throw new Error(`daemon exited before answering (code ${code}, signal ${signal}): ${stderr.trim()}`); })]);
    child.stdin.end();
    const { code, signal } = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (response?.kind !== 'response' || response.op !== 'hello' || response.requestId !== HELLO_ID) throw new Error(`unexpected hello reply: ${JSON.stringify(response).slice(0, 500)}`);
    if (code !== 0) throw new Error(`daemon exited with code ${code} (signal ${signal}) after stdin closed: ${stderr.trim()}`);
    return response.result;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function readFrame(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > 1024 * 1024) { cleanup(); reject(new Error(`frame of ${length} bytes exceeds the 1 MiB limit`)); return; }
      if (buffer.length < 4 + length) return;
      cleanup();
      try { resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))); } catch (error) { reject(error); }
    };
    const onEnd = () => { cleanup(); reject(new Error('daemon closed stdout before a full frame')); };
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}
