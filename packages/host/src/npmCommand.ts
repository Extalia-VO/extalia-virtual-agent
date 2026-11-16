import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { findExecutable, isExecutableFile, type ExecutableEnvironment } from './executableDiscovery.js';

export interface ExecutableLaunchPlan { command: string; args: string[] }
export interface ExecutableLaunchOptions {
  platform?: string;
  env?: ExecutableEnvironment;
  homeDirectory?: string;
  /** Resolve standalone Node; never substitute the Electron executable. */
  resolveNode?(): Promise<string | undefined>;
  /** Filesystem-only seams for platform-specific fixture tests. */
  readShim?(file: string): Promise<string>;
  checkExecutable?(file: string): Promise<boolean>;
  checkScript?(file: string): Promise<boolean>;
}
const MAX_SHIM_BYTES = 32_768;
const unsupported = () => new Error('This Windows command wrapper is not a supported npm Node shim. Choose its native executable or reinstall the CLI with a standard npm launcher.');

/** Recognize only the no-extra-arguments npm Node shim, never interpret batch commands. */
export function npmNodeShimTarget(text: string): string | undefined {
  if (Buffer.byteLength(text) > MAX_SHIM_BYTES || /\0/.test(text)) return undefined;
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim().split('\n').map(line => line.trim()).filter(Boolean);
  const modern = [
    /^@echo off$/i, /^goto start$/i, /^:find_dp0$/i, /^set dp0=%~dp0$/i, /^exit \/b$/i, /^:start$/i,
    /^setlocal$/i, /^call :find_dp0$/i, /^if exist "%dp0%\\node\.exe" \($/i,
    /^set "_prog=%dp0%\\node\.exe"$/i, /^\) else \($/i, /^set "_prog=node"$/i, /^\)$/,
  ];
  let target: string | undefined;
  if (lines.length === modern.length + 1 && modern.every((pattern, index) => pattern.test(lines[index]!))) {
    target = /^endlocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;\.JS;=;% & "%_prog%"\s+"%dp0%\\([^"\r\n]+)" %\*$/i.exec(lines.at(-1)!)?.[1];
  } else if (lines.length === modern.length + 2 && modern.slice(0, -1).every((pattern, index) => pattern.test(lines[index]!))
    && /^set PATHEXT=%PATHEXT:;\.JS;=;%$/i.test(lines[modern.length - 1]!) && lines[modern.length] === ')') {
    target = /^endlocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"%dp0%\\([^"\r\n]+)" %\*$/i.exec(lines.at(-1)!)?.[1];
  } else if (lines.length === 7 && /^@?if exist "%~dp0\\node\.exe" \($/i.test(lines[0]!)
    && /^\) else \($/i.test(lines[2]!) && /^@?setlocal$/i.test(lines[3]!)
    && /^@?set PATHEXT=%PATHEXT:;\.JS;=;%$/i.test(lines[4]!) && lines[6] === ')') {
    const first = /^"%~dp0\\node\.exe"\s+"%~dp0\\([^"\r\n]+)" %\*$/i.exec(lines[1]!)?.[1];
    const second = /^node\s+"%~dp0\\([^"\r\n]+)" %\*$/i.exec(lines[5]!)?.[1];
    if (first === second) target = first;
  }
  if (!target || target.length > 4096 || /[\p{Cc}%!"&|<>^]/u.test(target) || path.win32.isAbsolute(target)
    || /^[A-Za-z]:/.test(target) || !/\.(?:c?js|mjs)$/i.test(target)) return undefined;
  return target;
}

async function readShim(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SHIM_BYTES) throw unsupported();
    const buffer = Buffer.alloc(MAX_SHIM_BYTES + 1); let bytes = 0;
    while (bytes < buffer.length) { const next = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!next.bytesRead) break; bytes += next.bytesRead; }
    if (bytes > MAX_SHIM_BYTES) throw unsupported();
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { await handle.close(); }
}
const readableScript = async (file: string) => {
  try { if (!(await stat(file)).isFile()) return false; await access(file, constants.R_OK); return true; } catch { return false; }
};

/** Return an argv plan; no cmd.exe, shell quoting, interpolation or child execution occurs here. */
export async function executableLaunchPlan(executable: string, args: readonly string[], options: ExecutableLaunchOptions = {}): Promise<ExecutableLaunchPlan> {
  const platform = options.platform ?? process.platform;
  if (typeof executable !== 'string' || !executable || /\0/.test(executable) || args.some(argument => typeof argument !== 'string' || /\0/.test(argument))) throw new Error('Invalid executable launch arguments.');
  if (platform !== 'win32') return { command: executable, args: [...args] };
  const extension = path.win32.extname(executable).toLowerCase();
  if (['', '.exe', '.com'].includes(extension)) return { command: executable, args: [...args] };
  if (!['.cmd', '.bat'].includes(extension) || !path.win32.isAbsolute(executable)) throw unsupported();
  const target = npmNodeShimTarget(await (options.readShim ?? readShim)(executable));
  if (!target) throw unsupported();
  const script = path.win32.resolve(path.win32.dirname(executable), target);
  if (!await (options.checkScript ?? readableScript)(script)) throw new Error('The npm command points to an unavailable JavaScript entry point. Reinstall that CLI.');
  const check = options.checkExecutable ?? (file => isExecutableFile(file, platform));
  const usableNode = async (candidate: string): Promise<boolean> => {
    if (!path.win32.isAbsolute(candidate) || !/\.exe$/i.test(candidate) || !await check(candidate)) return false;
    if (!process.versions.electron) return true;
    const resolved = await realpath(candidate).catch(() => path.win32.resolve(candidate));
    const electron = await realpath(process.execPath).catch(() => path.win32.resolve(process.execPath));
    return resolved.toLowerCase() !== electron.toLowerCase();
  };
  let node = path.win32.join(path.win32.dirname(executable), 'node.exe');
  if (!await usableNode(node)) node = await (options.resolveNode?.() ?? findExecutable('node', {
    env: options.env ?? process.env, platform, homeDirectory: options.homeDirectory, nativeOnly: true, check: usableNode,
  })) ?? '';
  if (!node || !await usableNode(node))
    throw new Error('This npm command requires a standalone Node.js executable. Install Node.js and refresh the connection.');
  return { command: node, args: [script, ...args] };
}
