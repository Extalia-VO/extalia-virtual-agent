import { safeLabel, safeText, type Effort, type TeamMember } from '@extalia/core';
import type { HermesModelCatalog, RuntimeInfo } from '@extalia/platform';
import type { EventBody } from '@extalia/protocol';
import { HERMES_PROFILE_PATTERN, HermesAdapter, type HermesResult } from '@extalia/runtime';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Runs Hermes Agent as a managed runtime: one `hermes chat` process per
 * prompt, without a shell, in the workspace folder, with a minimal environment.
 * Discovery reads only the executable location and profile directory names.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Variables Hermes needs to find its home, locale and tools. Extalia's own settings and secrets are never passed on. */
const PASSED_VARIABLES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'HERMES_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
];
export const HERMES_KILL_GRACE_MS = 3_000;
const STDERR_LIMIT = 8_000;
const NOISE_LIMIT = 4_000;
const LINE_LIMIT = 8 * 1024 * 1024;
const ERROR_LIMIT = 2_000;

export function hermesEnvironment(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PASSED_VARIABLES) if (env[name] !== undefined) result[name] = env[name]!;
  // Plain, UTF-8 diagnostics: they become the error message of a failed turn.
  return { ...result, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' };
}

async function isExecutable(file: string): Promise<boolean> {
  try { await access(file, fsConstants.X_OK); return true; } catch { return false; }
}

/**
 * `EXTALIA_HERMES_BIN`, else `hermes` on PATH, else the per-user install folder
 * (`~/.local/bin`), which apps started from the Dock or Start menu usually lack
 * on their PATH. Nothing is executed to find it.
 */
export async function findHermes(env: Env, homeDirectory?: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const override = env.EXTALIA_HERMES_BIN?.trim();
  if (override) return path.isAbsolute(override) && await isExecutable(override) ? override : undefined;
  const names = platform === 'win32' ? ['hermes.exe', 'hermes'] : ['hermes'];
  const directories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(item => path.isAbsolute(item));
  if (homeDirectory && platform !== 'win32') {
    directories.push(path.join(homeDirectory, '.local', 'bin'));
    directories.push(path.join(homeDirectory, '.hermes', 'hermes-agent', 'venv', 'bin'));
  }
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Hermes' root home: `HERMES_HOME` (or its root when it names a profile), else `~/.hermes`. */
export function hermesRoot(env: Env, homeDirectory: string): string {
  const configured = env.HERMES_HOME?.trim();
  if (!configured) return path.join(homeDirectory, '.hermes');
  return path.basename(path.dirname(configured)) === 'profiles' ? path.dirname(path.dirname(configured)) : configured;
}

/** `default` plus the profile directory names; no profile file is opened. */
export async function hermesProfiles(env: Env, homeDirectory: string): Promise<string[]> {
  const names = new Set(['default']);
  try {
    const entries = await readdir(path.join(hermesRoot(env, homeDirectory), 'profiles'), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && HERMES_PROFILE_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch { /* no named profiles */ }
  return [...names];
}

/** The `model:` block of a Hermes `config.yaml`: either `model: <id>` or indented `default`, `provider`, `base_url`, `api_key`. */
export function parseHermesModelBlock(text: string): { default?: string; provider?: string; baseUrl?: string; apiKey?: string } {
  const unquote = (value: string) => value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^model:/.test(line));
  if (start < 0) return {};
  const inline = unquote(lines[start]!.slice('model:'.length));
  if (inline) return { default: inline };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (match && !(match[1]! in fields)) fields[match[1]!] = unquote(match[2]!);
  }
  return {
    ...(fields.default || fields.model ? { default: fields.default || fields.model } : {}),
    ...(fields.provider ? { provider: fields.provider } : {}),
    ...(fields.base_url ? { baseUrl: fields.base_url } : {}),
    ...(fields.api_key ? { apiKey: fields.api_key } : {}),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_MODELS = 500;

interface HermesModelConfig {
  defaultModel?: string;
  provider?: string;
  /** The profile's endpoint, only when it runs on this computer (loopback http/https). */
  local?: { url: URL; apiKey?: string };
}

/** A profile's `model:` block; `undefined` when its config file cannot be read. */
async function readHermesModelConfig(env: Env, homeDirectory: string, profile: string): Promise<HermesModelConfig | undefined> {
  if (profile !== 'default' && !HERMES_PROFILE_PATTERN.test(profile)) throw new Error('Unknown Hermes profile.');
  const root = hermesRoot(env, homeDirectory);
  const profileHome = profile === 'default' ? root : path.join(root, 'profiles', profile);
  let text: string;
  try { text = await readFile(path.join(profileHome, 'config.yaml'), 'utf8'); } catch { return undefined; }
  const block = parseHermesModelBlock(text);
  let url: URL | undefined;
  try { url = block.baseUrl ? new URL(block.baseUrl) : undefined; } catch { url = undefined; }
  const local = url && /^https?:$/.test(url.protocol) && LOOPBACK.has(url.hostname) ? url : undefined;
  // The key is only needed (and only resolved) for an endpoint on this computer.
  const apiKey = local && block.apiKey ? await resolveHermesSecret(block.apiKey, profileHome, env) : undefined;
  return {
    ...(block.default ? { defaultModel: safeLabel(block.default, 200) } : {}),
    ...(block.provider ? { provider: safeLabel(block.provider, 60) } : {}),
    ...(local ? { local: { url: local, ...(apiKey ? { apiKey } : {}) } } : {}),
  };
}

const ENV_REFERENCE = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** One variable from a dotenv file (`NAME=value`, optional `export` and quotes); comments are skipped. */
export function readDotenvValue(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    let value = match[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '').trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * A config value as Hermes reads it: `${VAR}` / `${env:VAR}` comes from the profile's own `.env`
 * (Hermes loads it for that profile), else from the environment; other values are used as written.
 */
async function resolveHermesSecret(raw: string, profileHome: string, env: Env): Promise<string | undefined> {
  const reference = ENV_REFERENCE.exec(raw.trim());
  if (!reference) return raw.includes('${') ? undefined : raw;
  const name = reference[1]!;
  const fromFile = await readFile(path.join(profileHome, '.env'), 'utf8').then(text => readDotenvValue(text, name), () => undefined);
  return fromFile ?? (env[name]?.trim() || undefined);
}

const endpointUrl = (url: URL, route: string) => `${url.href.replace(/\/+$/, '')}/${route}`;
const authorization = (apiKey: string | undefined): Record<string, string> => apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

/**
 * A Hermes profile's default model, plus the models its endpoint offers when that endpoint runs on
 * this computer (9Router, OmniRoute, Ollama, …). Remote providers are never queried, and the API key
 * read from the profile is only sent to that local endpoint and never returned.
 */
export async function hermesModelCatalog(env: Env, homeDirectory: string, profile: string,
  fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<HermesModelCatalog> {
  const config = await readHermesModelConfig(env, homeDirectory, profile);
  if (!config) return { profile, models: [], source: 'none', error: 'config-missing' };
  const { defaultModel } = config;
  const base = { profile, ...(defaultModel ? { defaultModel } : {}), ...(config.provider ? { provider: config.provider } : {}) };
  if (!config.local) return { ...base, models: [], source: defaultModel ? 'config' : 'none' };
  const { url, apiKey } = config.local;
  const endpoint = url.host;
  try {
    const response = await fetchImpl(endpointUrl(url, 'models'), {
      headers: { Accept: 'application/json', ...authorization(apiKey) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ...base, endpoint, models: [], source: 'config', error: `http-${response.status}` };
    const body = await response.json() as { data?: unknown; models?: unknown };
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const ids = list.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name : undefined)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 200)
      .map(id => safeLabel(id, 200));
    const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
    return { ...base, endpoint, models, source: 'endpoint' };
  } catch {
    return { ...base, endpoint, models: [], source: 'config', error: 'unreachable' };
  }
}

export interface HermesCompletionRequest {
  profile: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

/** Why a Hermes profile's endpoint could not answer; the message never contains the key or the reply. */
export class HermesEndpointError extends Error {
  constructor(readonly reason: 'config-missing' | 'remote' | 'http' | 'invalid-reply', message: string) {
    super(message);
    this.name = 'HermesEndpointError';
  }
}

/**
 * One short, tool-free chat completion against a Hermes profile's model endpoint
 * (`POST <base_url>/chat/completions`, OpenAI-compatible), used to plan a team.
 * Only endpoints on this computer are asked: a remote provider throws a `remote`
 * error without any request, and the profile's API key goes to that local endpoint only.
 */
export async function hermesComplete(env: Env, homeDirectory: string, request: HermesCompletionRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const config = await readHermesModelConfig(env, homeDirectory, request.profile);
  if (!config) throw new HermesEndpointError('config-missing', 'the Hermes profile has no readable config.yaml');
  if (!config.local) throw new HermesEndpointError('remote', 'the Hermes profile uses a model endpoint that is not on this computer');
  const { url, apiKey } = config.local;
  const response = await fetchImpl(endpointUrl(url, 'chat/completions'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authorization(apiKey) },
    body: JSON.stringify({
      model: request.model, stream: false, temperature: 0.3, max_tokens: 12_000,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
    }),
    signal: request.signal,
  });
  if (!response.ok) throw new HermesEndpointError('http', `the endpoint answered HTTP ${response.status}`);
  const body = await response.json().catch(() => undefined) as { choices?: { message?: { content?: unknown } }[] } | undefined;
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('')
      : '';
  if (!text.trim()) throw new HermesEndpointError('invalid-reply', 'the endpoint returned no text');
  return text;
}

/** The model a Hermes profile runs by default (from its `config.yaml`), if any. */
export async function hermesDefaultModel(env: Env, homeDirectory: string, profile: string): Promise<string | undefined> {
  return (await readHermesModelConfig(env, homeDirectory, profile).catch(() => undefined))?.defaultModel;
}

export async function discoverRuntimes(env: Env, homeDirectory: string): Promise<RuntimeInfo[]> {
  const executable = await findHermes(env, homeDirectory);
  return [
    { id: 'extalia-native', available: true, profiles: [] },
    { id: 'hermes', available: Boolean(executable), profiles: executable ? await hermesProfiles(env, homeDirectory) : [] },
  ];
}

const reasoningSupport = new Map<string, Promise<boolean>>();

/**
 * Whether this Hermes executable accepts `--reasoning` (read once from `hermes chat --help`,
 * which starts no session). Older versions do not, so their sessions offer no effort choice.
 */
export function hermesSupportsReasoning(executable: string, env: Env, timeoutMs = 5_000): Promise<boolean> {
  let known = reasoningSupport.get(executable);
  if (!known) {
    known = new Promise<boolean>(resolve => {
      let output = '';
      let child: ChildProcess;
      try {
        child = spawn(executable, ['chat', '--help'], { env: hermesEnvironment(env), shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs });
      } catch { resolve(false); return; }
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (output.length < 64_000) output += chunk; });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(/(^|[\s[])--reasoning\b/m.test(output)));
    });
    reasoningSupport.set(executable, known);
    // A failed probe (for example a timeout) is tried again next time.
    void known.then(supported => { if (!supported) setTimeout(() => { if (reasoningSupport.get(executable) === known) reasoningSupport.delete(executable); }, 60_000).unref(); });
  }
  return known;
}

export interface HermesTurnOptions {
  executable: string;
  cwd: string;
  prompt: string;
  profile: string;
  model?: string;
  /** Only for Hermes versions whose `chat --help` lists `--reasoning` (see `hermesSupportsReasoning`). */
  reasoning?: Effort;
  resumeSessionId?: string;
  yolo: boolean;
  env: Env;
  signal: AbortSignal;
  emit: (body: EventBody) => void;
  /** Time between SIGTERM and SIGKILL when the turn is stopped. */
  killGraceMs?: number;
  /** The enabled team's members: Hermes delegations that name one are shown as that subagent. */
  team?: readonly Pick<TeamMember, 'id' | 'name' | 'role'>[];
}

export interface HermesTurnResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Hermes' session id, once Hermes has actually worked on it (safe to resume). */
  sessionId?: string;
}

/** Strip terminal escapes and Hermes' own `session_id:` trailer from diagnostics. */
function cleanDiagnostics(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).filter(line => line.trim() && !/^session_id:/.test(line.trim())).join('\n').trim();
}

const tail = (value: string, limit: number) => value.length > limit ? value.slice(-limit) : value;

function signalProcess(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try { process.kill(group ? -pid : pid, signal); } catch { /* already gone */ }
}

/** Ask Hermes to stop (it interrupts its tools on SIGTERM), then kill its process group. */
function terminate(child: ChildProcess, graceMs: number, exited: () => boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  signalProcess(pid, 'SIGTERM', false);
  setTimeout(() => { if (!exited()) { signalProcess(pid, 'SIGKILL', true); signalProcess(pid, 'SIGKILL', false); } }, graceMs).unref();
}

/**
 * Run one prompt through Hermes and report it as protocol bodies, ending with
 * `turn.completed` or `turn.failed` and `agent.state: idle`.
 */
export async function runHermesTurn(options: HermesTurnOptions): Promise<HermesTurnResult> {
  const { emit, signal } = options;
  const adapter = new HermesAdapter();
  const plan = adapter.plan({
    cwd: options.cwd, prompt: options.prompt, profile: options.profile, yolo: options.yolo,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
  });
  const parse = adapter.createStreamParser(options.team?.length ? { team: options.team } : {});
  const finish = (outcome: HermesTurnResult['outcome'], extra: { error?: string; result?: HermesResult; model?: string } = {}) => {
    if (outcome === 'completed') emit({ type: 'turn.completed', ...(extra.model ? { model: extra.model } : {}), ...(extra.result?.usage ? { usage: extra.result.usage } : {}) });
    else emit({ type: 'turn.failed', error: extra.error ?? 'Stopped by the user.' });
    emit({ type: 'agent.state', state: 'idle' });
  };
  if (signal.aborted) { finish('cancelled'); return { outcome: 'cancelled' }; }

  emit({ type: 'agent.state', state: 'working', summary: 'Hermes Agent' });
  const child = spawn(options.executable, plan.args, {
    cwd: options.cwd,
    env: hermesEnvironment(options.env),
    shell: false,
    // Its own process group, so a stop can reach everything Hermes started.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let sessionId: string | undefined, model: string | undefined, result: HermesResult | undefined;
  let worked = false, stderr = '', noise = '', partial = '';
  const decoder = new StringDecoder('utf8'), errors = new StringDecoder('utf8');
  const line = (raw: string) => {
    const update = parse(raw);
    if (!update) { if (raw.trim()) noise = tail(`${noise}${raw}\n`, NOISE_LIMIT); return; }
    if (update.sessionId) sessionId = update.sessionId;
    if (update.model) model = update.model;
    if (update.result) result = update.result;
    for (const body of update.events) {
      if (body.type !== 'agent.state') worked = true;
      emit(body.type === 'file.written' ? { ...body, path: displayPath(options.cwd, body.path) } : body);
    }
  };
  const read = (text: string) => {
    partial += text;
    let cut: number;
    while ((cut = partial.indexOf('\n')) !== -1) { line(partial.slice(0, cut)); partial = partial.slice(cut + 1); }
    if (partial.length > LINE_LIMIT) partial = '';
  };
  child.stdout?.on('data', (chunk: Buffer) => read(decoder.write(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr + errors.write(chunk), STDERR_LIMIT); });
  child.stdin?.on('error', () => { /* Hermes exited before reading the prompt; its exit explains why. */ });
  child.stdin?.end(plan.stdin);

  let exited = false, cancelled = false;
  const onAbort = () => { cancelled = true; terminate(child, options.killGraceMs ?? HERMES_KILL_GRACE_MS, () => exited); };
  signal.addEventListener('abort', onAbort, { once: true });

  let spawnError: Error | undefined;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    let done = false;
    const settle = (code: number | null, by: NodeJS.Signals | null) => { if (!done) { done = true; resolve({ code, signal: by }); } };
    child.on('error', error => { spawnError = error; settle(null, null); });
    child.on('close', settle);
    // Something Hermes started may keep the pipes open; do not wait for it forever.
    child.on('exit', (code, by) => { exited = true; setTimeout(() => settle(code, by), 1_000).unref(); });
  });
  exited = true;
  signal.removeEventListener('abort', onAbort);
  child.stdout?.destroy();
  child.stderr?.destroy();
  read(decoder.end());
  if (partial) { line(partial); partial = ''; }
  stderr = tail(stderr + errors.end(), STDERR_LIMIT);

  const resumable = sessionId && (worked || result?.exitCode === 0) ? { sessionId } : {};
  if (cancelled) { finish('cancelled'); return { outcome: 'cancelled', ...resumable }; }
  if (spawnError) {
    finish('failed', { error: `Hermes Agent could not be started: ${spawnError.message}` });
    return { outcome: 'failed' };
  }
  // Without the terminal `result` record the run did not finish, whatever the exit code.
  if (result?.exitCode === 0) {
    finish('completed', { result, ...(model ? { model } : {}) });
    return { outcome: 'completed', ...resumable };
  }
  const detail = cleanDiagnostics(stderr) || cleanDiagnostics(noise);
  const reason = result?.error ?? (result ? undefined : exit.signal ? `Hermes Agent was stopped (${exit.signal}).` : `Hermes Agent exited with code ${exit.code ?? 1}.`);
  const message = [reason, detail && tail(detail, ERROR_LIMIT)].filter(Boolean).join('\n') || `Hermes Agent exited with code ${result?.exitCode ?? exit.code ?? 1}.`;
  finish('failed', { error: safeText(message, ERROR_LIMIT + 400) });
  return { outcome: 'failed', ...resumable };
}

/** Paths inside the workspace are shown relative to it, like Extalia Native's. */
function displayPath(root: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
}

/** First Hermes prompt of a continued session: the carried conversation as context, then the request. */
export function continuationPrompt(origin: { source: string; title: string }, history: readonly { role: string; text?: string }[], prompt: string): string {
  const messages = history
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.text?.trim())
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.text!.trim()}`);
  if (!messages.length) return prompt;
  return [
    `This session continues "${origin.title.replace(/["\n]/g, ' ')}", a conversation that started in ${origin.source}. ` +
      'Its earlier messages follow as context; the other agent\'s tool calls and their output are not included.',
    '<earlier-conversation>', messages.join('\n\n'), '</earlier-conversation>',
    '', 'The new request:', prompt,
  ].join('\n');
}
