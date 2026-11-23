import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isExecutableFile } from '../executableDiscovery.js';
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
export const FORWARDER_VERSION = 3;

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
  try {
    const overrides = JSON.parse(readFileSync(path.join(home, 'hooks', 'targets.json'), 'utf8'));
    if (Object.hasOwn(overrides, app) && Number.isInteger(overrides[app]) && overrides[app] > 0 && overrides[app] < 65536) port = overrides[app];
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
  if (Buffer.byteLength(payload) > LIMIT) {
    try { payload = JSON.stringify(clip(JSON.parse(payload))); } catch { return done(); }
    if (Buffer.byteLength(payload) > LIMIT) return done();
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
export const forwardLauncherPath = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'forward.sh');
export const nodePathFile = (extaliaHome: string) => path.join(extaliaHome, 'hooks', 'node-path');

export const FORWARD_LAUNCHER_VERSION = 1;

/**
 * Dependency-free POSIX `/bin/sh` launcher installed alongside `forward.mjs`.
 *
 * Resolves a working standalone Node.js binary at runtime so Homebrew Cellar,
 * nvm, or Herd upgrades never fail with `exit status 127` before `forward.mjs`
 * starts, and strictly fails open (`exit 0`, no stderr) so synchronous hooks
 * like Antigravity `PreToolUse` are never blocked.
 */
export const FORWARD_LAUNCHER_SOURCE = `#!/bin/sh
# extalia-hook-launcher v${FORWARD_LAUNCHER_VERSION}
# Installed by \`extalia connect\`. Overwritten on the next connect; edit nothing here.
# Resolves a working standalone Node.js binary at runtime and runs forward.mjs.
# Always fails open (exit 0, no stderr) so a Node upgrade can never block an agent.
exec 2>/dev/null

fail_open() {
  if [ "\${1:-}" = "antigravity" ] && [ "\${2:-}" != "PreToolUse" ]; then
    printf '{}\\n'
  fi
  exit 0
}

case "$0" in
  */*) _dir=\${0%/*}; [ -n "$_dir" ] || _dir=/ ;;
  *) _dir=. ;;
esac
DIR=$(CDPATH= cd -- "$_dir" 2>/dev/null && pwd) || DIR=$_dir
FWD="$DIR/forward.mjs"
NODE=""

check_node() {
  case "$1" in
    /*)
      if [ -f "$1" ] && [ -x "$1" ]; then
        NODE="$1"
        return 0
      fi
      ;;
  esac
  return 1
}

check_env_node() {
  [ -z "$NODE" ] || return 0
  case "$1" in
    /*) check_node "$1$2" || : ;;
  esac
}

find_versioned_node() {
  _root="$1"
  [ -d "$_root" ] || return 1
  _best=""
  _bmaj=-1
  _bmin=-1
  _bpat=-1
  for _ver in "$_root"/v*; do
    [ -d "$_ver" ] || continue
    _name=\${_ver##*/}
    _cand="$_ver/bin/node"
    [ -f "$_cand" ] && [ -x "$_cand" ] || continue
    case "$_name" in
      v[0-9]*.[0-9]*.[0-9]*)
        _rest=\${_name#v}
        _maj=\${_rest%%.*}
        _rest=\${_rest#*.}
        _min=\${_rest%%.*}
        _pat=\${_rest#*.}
        case "$_maj" in ""|*[!0-9]*) continue ;; esac
        case "$_min" in ""|*[!0-9]*) continue ;; esac
        case "$_pat" in ""|*[!0-9]*) continue ;; esac
        if [ "$_maj" -gt "$_bmaj" ] ||
           { [ "$_maj" -eq "$_bmaj" ] && [ "$_min" -gt "$_bmin" ]; } ||
           { [ "$_maj" -eq "$_bmaj" ] && [ "$_min" -eq "$_bmin" ] && [ "$_pat" -gt "$_bpat" ]; }; then
          _bmaj=$_maj
          _bmin=$_min
          _bpat=$_pat
          _best="$_cand"
        fi
        ;;
    esac
  done
  if [ -n "$_best" ]; then
    NODE="$_best"
    return 0
  fi
  return 1
}

# 1. Recorded standalone Node hint
if [ -r "$DIR/node-path" ]; then
  _hint=""
  IFS= read -r _hint < "$DIR/node-path" 2>/dev/null || :
  _hint=\${_hint%"$(printf '\\r')"}
  check_node "$_hint" || :
fi

# 2. node on PATH
if [ -z "$NODE" ] && [ -n "\${PATH:-}" ]; then
  _cand=$(command -v node 2>/dev/null) || _cand=""
  check_node "$_cand" || :
fi

# 3. Standard system and Homebrew locations
if [ -z "$NODE" ] && [ "\${EXTALIA_HOOK_SKIP_SYSTEM_NODE:-}" != "1" ]; then
  for _cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    check_node "$_cand" && break
  done
fi

# 4. Version-manager and user bin locations
check_env_node "\${VOLTA_HOME:-}" "/bin/node"
check_env_node "\${HOME:-}" "/.volta/bin/node"
check_env_node "\${HOME:-}" "/.local/bin/node"
check_env_node "\${FNM_MULTISHELL_PATH:-}" "/bin/node"
check_env_node "\${NVM_BIN:-}" "/node"

# 5. Newest versioned directory under nvm and macOS Herd
if [ -z "$NODE" ]; then
  case "\${NVM_DIR:-}" in
    /*) find_versioned_node "$NVM_DIR/versions/node" || : ;;
  esac
fi
if [ -z "$NODE" ]; then
  case "\${HOME:-}" in
    /*) find_versioned_node "$HOME/.nvm/versions/node" || : ;;
  esac
fi
if [ -z "$NODE" ]; then
  case "\${HOME:-}" in
    /*)
      _os=$(uname -s 2>/dev/null || /usr/bin/uname -s 2>/dev/null || :)
      if [ "$_os" = "Darwin" ]; then
        find_versioned_node "$HOME/Library/Application Support/Herd/config/nvm/versions/node" || :
      fi
      ;;
  esac
fi

if [ -n "$NODE" ] && [ -r "$FWD" ]; then
  "$NODE" "$FWD" "$@" 2>/dev/null && exit 0
fi
fail_open "$@"
`;

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

export async function forwardLauncherStatus(extaliaHome: string): Promise<'current' | 'outdated' | 'missing'> {
  const file = forwardLauncherPath(extaliaHome);
  try {
    const content = await readFile(file, 'utf8');
    if (content !== FORWARD_LAUNCHER_SOURCE) return 'outdated';
    if (process.platform !== 'win32' && !(await isExecutableFile(file, process.platform))) return 'outdated';
    return 'current';
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
}

/** Write the POSIX hook launcher when missing, outdated, or non-executable. Returns whether it wrote. */
export async function installForwardLauncher(extaliaHome: string): Promise<boolean> {
  if ((await forwardLauncherStatus(extaliaHome)) === 'current') return false;
  const file = forwardLauncherPath(extaliaHome);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, FORWARD_LAUNCHER_SOURCE, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(file, 0o755);
  return true;
}

/** Read the recorded standalone Node hint from `EXTALIA_HOME/hooks/node-path`. */
export async function readRecordedNodePath(extaliaHome: string): Promise<string | undefined> {
  try {
    const line = (await readFile(nodePathFile(extaliaHome), 'utf8')).split(/\r?\n/, 1)[0]?.trim() ?? '';
    return line && path.posix.isAbsolute(line) ? line : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Record the verified standalone Node hint at `EXTALIA_HOME/hooks/node-path` (mode 0600). */
export async function writeRecordedNodePath(extaliaHome: string, nodePath: string): Promise<boolean> {
  const file = nodePathFile(extaliaHome);
  const desired = `${nodePath}\n`;
  let current: string | undefined;
  try { current = await readFile(file, 'utf8'); } catch (error) { if (!isNotFound(error)) throw error; }
  if (current === desired) {
    if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => undefined);
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, desired, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600);
  return true;
}
