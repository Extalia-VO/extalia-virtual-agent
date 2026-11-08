import path from 'node:path';

export const codexPermissionForwarderPath = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'codex-permission.mjs');
export const codexPermissionTokenFile = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'codex-permission-token');
export const codexPermissionEndpointFile = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'endpoint.json');

/** Standalone installed script: it must not import the current CLI installation. */
export const CODEX_PERMISSION_FORWARDER_SOURCE = `// extalia-codex-permission-forwarder v1
// Explicit synchronous approval forwarding. Every uncertainty returns the native prompt.
import { lstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 65536;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionId = process.argv.length === 4 && process.argv[2] === '--session' && SESSION_ID.test(process.argv[3]) ? process.argv[3] : undefined;
let finished = false;
let request;
const done = (output = {}) => {
  if (finished) return;
  finished = true;
  request?.destroy();
  try { process.stdout.write(JSON.stringify(output) + '\\n', () => process.exit(0)); }
  catch { process.exit(0); }
};
process.on('uncaughtException', () => done());
process.on('unhandledRejection', () => done());
process.on('SIGTERM', () => done());
process.on('SIGINT', () => done());
setTimeout(() => done(), 60000);

function privateText(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
  return readFileSync(file, 'utf8').trim();
}

function main(body) {
  const payload = JSON.parse(body);
  if (!sessionId || !payload || typeof payload !== 'object' || payload.session_id !== sessionId) return done();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.hook_event_name !== 'PermissionRequest'
    || !['session_id', 'turn_id', 'tool_name'].every(key => typeof payload[key] === 'string' && payload[key].length > 0 && payload[key].length <= 1024)
    || !Object.hasOwn(payload, 'tool_input')) return done();
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const token = privateText(path.join(directory, 'codex-permission-token'));
  const endpoint = JSON.parse(privateText(path.join(directory, 'endpoint.json')));
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || !Number.isInteger(endpoint.pid) || endpoint.pid < 1) return done();
  try { process.kill(endpoint.pid, 0); } catch (error) { if (error.code !== 'EPERM') return done(); }
  const requestId = randomUUID();
  const data = JSON.stringify({ requestId, payload });
  if (Buffer.byteLength(data) > LIMIT) return done();
  request = http.request({
    host: '127.0.0.1', port: endpoint.port, path: '/api/permissions/codex', method: 'POST', timeout: 59000,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: 'Bearer ' + token },
  }, response => {
    if (response.statusCode !== 200) { response.resume(); return done(); }
    let length = 0;
    const chunks = [];
    response.on('data', chunk => {
      length += chunk.length;
      if (length > 8192) return done();
      chunks.push(chunk);
    });
    response.on('error', () => done());
    response.on('aborted', () => done());
    response.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value.confirmed !== true || value.requestId !== requestId || value.nativeSessionId !== payload.session_id
          || value.turnId !== payload.turn_id || value.toolName !== payload.tool_name
          || (value.decision !== 'allow' && value.decision !== 'deny')) return done();
        done({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: value.decision } } });
      } catch { done(); }
    });
  });
  request.on('error', () => done());
  request.on('timeout', () => done());
  request.end(data);
}

try {
  if (!sessionId || process.stdin.isTTY) done();
  else {
    let length = 0;
    const chunks = [];
    process.stdin.on('data', chunk => {
      length += chunk.length;
      if (length > LIMIT) return done();
      chunks.push(chunk);
    });
    process.stdin.on('error', () => done());
    process.stdin.on('end', () => { try { main(Buffer.concat(chunks).toString('utf8')); } catch { done(); } });
  }
} catch { done(); }
`;
