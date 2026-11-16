import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AntigravityHandoverEndpoint } from './antigravityHandoverService.js';
interface Options { homeDirectory: string; env: Readonly<Record<string, string | undefined>>; alive?(pid: number): boolean }
/** Select one live native daemon. Callers pin it and never retry effects against another endpoint. */
export async function discoverAntigravityHandoverEndpoint(options: Options): Promise<AntigravityHandoverEndpoint | undefined> {
  if (options.env.ANTIGRAVITY_LS_ADDRESS?.trim() && options.env.ANTIGRAVITY_CSRF_TOKEN?.trim()) return {
    address: options.env.ANTIGRAVITY_LS_ADDRESS.trim(), csrfToken: options.env.ANTIGRAVITY_CSRF_TOKEN.trim(), identity: 'explicit-native-endpoint',
  };
  const root = options.env.ANTIGRAVITY_HOME?.trim() || path.join(options.homeDirectory, '.gemini', 'antigravity');
  const folder = path.join(root, 'daemon');
  let canonical: string, files: string[];
  try { canonical = await realpath(folder); files = (await readdir(canonical)).filter(file => file.endsWith('.json')).sort().slice(0, 64); } catch { return undefined; }
  const candidates: Array<AntigravityHandoverEndpoint & { time: number }> = [];
  for (const file of files) {
    try {
      const location = path.join(canonical, file), info = await lstat(location);
      if (!info.isFile() || info.size > 16 * 1024 || await realpath(location) !== location) continue;
      const value = JSON.parse(await readFile(location, 'utf8')) as Record<string, unknown>, after = await stat(location);
      if (info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs) continue;
      if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.httpPort !== 'number' || !Number.isInteger(value.httpPort) || value.httpPort <= 0 || value.httpPort > 65535 || typeof value.csrfToken !== 'string' || !value.csrfToken.trim() || value.csrfToken.length > 4096 || /[\0\r\n]/.test(value.csrfToken)) continue;
      let alive = false;
      try { if (options.alive) alive = options.alive(value.pid); else { process.kill(value.pid, 0); alive = true; } } catch { /* A stale daemon is not a live attachment. */ }
      if (!alive) continue;
      candidates.push({ address: `127.0.0.1:${value.httpPort}`, csrfToken: value.csrfToken, time: info.mtimeMs,
        identity: createHash('sha256').update(JSON.stringify([location, info.dev, info.ino, info.size, info.mtimeMs, value.pid, value.lsVersion])).digest('hex') });
    } catch { /* Unreadable/malformed candidates grant no capability. */ }
  }
  candidates.sort((a, b) => b.time - a.time || a.identity.localeCompare(b.identity));
  const selected = candidates[0];
  return selected ? { address: selected.address, csrfToken: selected.csrfToken, identity: selected.identity } : undefined;
}
