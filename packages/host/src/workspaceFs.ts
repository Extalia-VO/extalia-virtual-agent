import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safeLabel } from '@extalia/core';
import { errorCode } from './jsonStore.js';

export type PathPurpose = 'read' | 'write';

export interface ResolvedPath {
  /** Absolute path inside the workspace. */
  absolute: string;
  /** Path relative to the workspace root with `/` separators; `.` for the root itself. */
  relative: string;
}

/** A path the agent may not use. The message is safe to show to the user and the model. */
export class WorkspacePathError extends Error {
  override name = 'WorkspacePathError';
}

/** Generated, vendored or tool-internal directories that listing and search skip. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', 'target', '.turbo', '.cache',
]);

const CREDENTIAL_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials']);
const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa'];
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample']);

function segments(value: string): string[] {
  // Lowercase: macOS and Windows file systems usually ignore case, so `.ENV` is `.env`.
  return value.toLowerCase().split(/[\\/]+/).filter(part => part && part !== '.');
}

/** True for files that conventionally hold credentials. Agents never read or write them. */
export function isCredentialPath(value: string): boolean {
  const parts = segments(value);
  const name = parts.at(-1) ?? '';
  if (parts.includes('.ssh')) return true;
  if (name === 'credentials' && parts.at(-2) === '.aws') return true;
  if ((name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATES.has(name)) return true;
  if (CREDENTIAL_NAMES.has(name)) return true;
  return KEY_PREFIXES.some(prefix => name.startsWith(prefix)) || KEY_EXTENSIONS.some(extension => name.endsWith(extension));
}

/** True for paths inside a `.git` directory (or the directory itself). */
export function isGitInternalPath(value: string): boolean {
  return segments(value).includes('.git');
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const toPosix = (value: string) => value.split(path.sep).join('/');

function checkAllowed(relative: string, label: string, purpose: PathPurpose): void {
  if (isCredentialPath(relative)) throw new WorkspacePathError(`"${label}" looks like a credential file. Agents may not read or change credential files.`);
  if (purpose === 'write' && isGitInternalPath(relative)) throw new WorkspacePathError(`"${label}" is inside .git. Change the repository with git commands instead.`);
}

/** The real location of a path whose last components may not exist yet. */
async function realTarget(absolute: string, label: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      const code = errorCode(error);
      if (code === 'ELOOP') throw new WorkspacePathError(`"${label}" is a symbolic link loop.`);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WorkspacePathError(`Cannot check "${label}" (${code ?? 'unknown error'}).`);
      // The entry exists but its target does not: writing through it could land anywhere.
      if (await lstat(current).then(info => info.isSymbolicLink(), () => false)) throw new WorkspacePathError(`"${label}" is a broken symbolic link.`);
      const parent = path.dirname(current);
      if (parent === current) throw new WorkspacePathError(`Cannot check "${label}".`);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a model-supplied path inside the workspace. Relative paths resolve
 * against the root; absolute paths are accepted only when inside it. Symbolic
 * links are followed for the check, so a link cannot lead outside the
 * workspace or to a credential file. Throws `WorkspacePathError`.
 */
export async function resolveInside(root: string, requestedPath: string, purpose: PathPurpose): Promise<ResolvedPath> {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) throw new WorkspacePathError('The path must be plain text.');
  const requested = requestedPath.trim() || '.';
  const label = safeLabel(requested, 160);
  const rootAbsolute = path.resolve(root);
  let realRoot: string;
  try { realRoot = await realpath(rootAbsolute); }
  catch { throw new WorkspacePathError('The workspace folder is not available.'); }

  const absolute = path.resolve(rootAbsolute, requested);
  let base = rootAbsolute;
  // Accept absolute paths spelled with the root's real location (for example /private/var for /var on macOS).
  if (!isWithin(base, absolute) && path.isAbsolute(requested) && isWithin(realRoot, absolute)) base = realRoot;
  if (!isWithin(base, absolute)) throw new WorkspacePathError(`"${label}" is outside the workspace. Use a path inside the project folder.`);
  const relative = toPosix(path.relative(base, absolute)) || '.';
  checkAllowed(relative, label, purpose);

  const real = await realTarget(absolute, label);
  if (!isWithin(realRoot, real)) throw new WorkspacePathError(`"${label}" leads outside the workspace through a symbolic link.`);
  checkAllowed(toPosix(path.relative(realRoot, real)) || '.', label, purpose);
  return { absolute, relative };
}
