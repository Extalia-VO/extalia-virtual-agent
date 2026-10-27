import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound, writeFileAtomic } from '../jsonStore.js';

/**
 * The hook forwarder: a dependency-free Node script installed at the stable path
 * `EXTALIA_HOME/hooks/forward.mjs`. Codex and Claude Code run it as a command
 * hook (`<node> forward.mjs <app>`); it hands the hook JSON on stdin to the
 * local host and nothing else.
 *
 * Rules the script keeps: reads token and endpoint at run time (rotation needs
 * no reconnect), one second overall, prints nothing, always exits 0 (agents read
 * hook stdout as decisions), never throws.
 */
export const FORWARDER_VERSION = 2;

export const FORWARDER_SOURCE = `// extalia-hook-forwarder v${FORWARDER_VERSION}
// Installed by \`extalia connect\`. Overwritten on the next connect; edit nothing here.
// Reads one agent hook payload on stdin and posts it to the local Extalia host.
// It prints nothing (or {} for Antigravity protojson) and always exits 0, so it can never block or steer an agent.
// Antigravity PreToolUse gets no output: its contract requires a decision and reads {} as a deny.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4317;
const LIMIT = 60000;
const app = process.argv[2];
const event = process.argv[3];
let exited = false;
const done = () => {
  if (exited) return;
  exited = true;
  if (app === 'antigravity' && event !== 'PreToolUse') {
    try { process.stdout.write('{}\\n'); } catch {}
  }
  process.exit(0);
};
process.on('uncaughtException', done);
process.on('unhandledRejection', done);
// Hard deadline: a slow host must never hold an agent up.
setTimeout(done, 1000).unref();

function clip(value, depth = 0) {
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + '...' : value;
  if (Array.isArray(value)) return depth > 8 ? [] : value.slice(0, 50).map(item => clip(item, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 8) return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clip(item, depth + 1);
    return out;
  }
  return value;
}

function main(app, body) {
  const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const token = readFileSync(path.join(home, 'hooks', 'token'), 'utf8').trim();
  let port = DEFAULT_PORT;
  try {
    const endpoint = JSON.parse(readFileSync(path.join(home, 'hooks', 'endpoint.json'), 'utf8'));
    if (Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536) port = endpoint.port;
  } catch {}
  if (!token || !body) return done();
  let payload = body;
  if (event) {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.hook_event_name && !parsed.hookEventName) {
        parsed.hook_event_name = event;
        payload = JSON.stringify(parsed);
      }
    } catch {}
  }
  if (payload.length > LIMIT) {
    try { payload = JSON.stringify(clip(JSON.parse(payload))); } catch { return done(); }
    if (payload.length > LIMIT) return done();
  }
  const request = http.request({
    host: '127.0.0.1', port, path: '/api/hooks/' + encodeURIComponent(app), method: 'POST', timeout: 1000,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer ' + token },
  }, response => { response.resume(); response.on('end', done); response.on('error', done); });
  request.on('error', done);
  request.on('timeout', () => { request.destroy(); done(); });
  request.end(payload);
}

try {
  if (!app || process.stdin.isTTY) done();
  else {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('error', done);
    process.stdin.on('end', () => { try { main(app, Buffer.concat(chunks).toString('utf8')); } catch { done(); } });
  }
} catch { done(); }
`;

export const forwarderPath = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'forward.mjs');

export async function forwarderStatus(extaliaHome: string): Promise<'current' | 'outdated' | 'missing'> {
  try { return (await readFile(forwarderPath(extaliaHome), 'utf8')) === FORWARDER_SOURCE ? 'current' : 'outdated'; }
  catch (error) { if (isNotFound(error)) return 'missing'; throw error; }
}

/** Write the forwarder when missing or different. Returns whether it wrote. */
export async function installForwarder(extaliaHome: string): Promise<boolean> {
  if ((await forwarderStatus(extaliaHome)) === 'current') return false;
  const file = forwarderPath(extaliaHome);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, FORWARDER_SOURCE, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(file, 0o755);
  return true;
}
