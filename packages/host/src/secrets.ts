import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialSource } from '@extalia/core';
import { safeLabel } from '@extalia/core';
import type { SecretStoreKind } from '@extalia/platform';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { PRIVATE_FILE_MODE } from './paths.js';

/**
 * Credential storage. Secrets live in the operating system's credential store
 * when one is available and in a private file otherwise; they never appear in
 * connections, logs or command lines.
 */
export interface SecretStore {
  readonly kind: SecretStoreKind;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Injected in tests so no real credential store is touched. */
export type CommandRunner = (command: string, args: readonly string[], stdin?: string) => Promise<CommandResult>;

export const DEFAULT_SECRET_SERVICE = 'Extalia';
export const SECRET_STORE_OVERRIDE = 'EXTALIA_SECRET_STORE';
const SECURITY_PATH = '/usr/bin/security';
const KEYCHAIN_NOT_FOUND = 44;
// Generous: the OS may show an unlock prompt the user has to answer.
const COMMAND_TIMEOUT_MS = 120_000;

export const runCommand: CommandRunner = (command, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${path.basename(command)} did not respond in time.`)); }, COMMAND_TIMEOUT_MS);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  // The program may exit before reading stdin; that is reported through its exit code.
  child.stdin.on('error', () => {});
  child.stdin.end(stdin ?? '');
});

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SECRET_LIMIT = 8192;

/** Credential references become keychain account names, so they stay simple identifiers. */
export function checkSecretRef(ref: string): string {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw new Error('Credential references use letters, numbers, ".", "_", ":" and "-" (up to 128 characters).');
  return ref;
}

/**
 * Normalize a secret before storing it: surrounding whitespace (a common paste
 * accident) is removed; whitespace, quotes, backslashes and control characters
 * inside are refused because API keys never contain them and the keychain
 * command line could not carry them safely.
 */
export function checkSecret(secret: string): string {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) throw new Error('The credential is empty.');
  if (value.length > SECRET_LIMIT) throw new Error(`The credential is longer than ${SECRET_LIMIT} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\s"'\\\x00-\x1f\x7f]/.test(value)) throw new Error('The credential contains spaces, quotes, backslashes or control characters. API keys never do; check that only the key was pasted.');
  return value;
}

function checkService(service: string): string {
  if (!SERVICE_PATTERN.test(service)) throw new Error('The credential service name uses letters, numbers, spaces, ".", "_" and "-".');
  return service;
}

/** A short, secret-free description of a failed credential-store command. */
function failure(action: string, result: CommandResult, secret?: string): Error {
  let detail = result.stderr.trim();
  if (secret) detail = detail.split(secret).join('[redacted]');
  return new Error(`${action} failed (exit code ${result.code})${detail ? `: ${safeLabel(detail, 200)}` : '.'}`);
}

export interface CommandStoreOptions {
  /** Keychain service / secret attribute. Defaults to `Extalia`. */
  service?: string;
  run?: CommandRunner;
}

/** macOS Keychain through `/usr/bin/security`. */
export class MacKeychainStore implements SecretStore {
  readonly kind = 'os-keychain' as const;
  private readonly service: string;
  private readonly run: CommandRunner;
  private readonly security: string;

  constructor({ service = DEFAULT_SECRET_SERVICE, run = runCommand, securityPath = SECURITY_PATH }: CommandStoreOptions & { securityPath?: string } = {}) {
    this.service = checkService(service);
    this.run = run;
    this.security = securityPath;
  }

  async get(ref: string): Promise<string | undefined> {
    const result = await this.run(this.security, ['find-generic-password', '-s', this.service, '-a', checkSecretRef(ref), '-w']);
    if (result.code === KEYCHAIN_NOT_FOUND) return undefined;
    if (result.code !== 0) throw failure('Reading the credential from the macOS Keychain', result);
    return result.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(ref: string, secret: string): Promise<void> {
    const value = checkSecret(secret);
    // `security -i` reads the command from stdin, so the secret never shows up in the process list.
    const line = `add-generic-password -U -s "${this.service}" -a "${checkSecretRef(ref)}" -w "${value}"\n`;
    const result = await this.run(this.security, ['-i'], line);
    if (result.code !== 0) throw failure('Saving the credential in the macOS Keychain', result, value);
  }

  async delete(ref: string): Promise<void> {
    const result = await this.run(this.security, ['delete-generic-password', '-s', this.service, '-a', checkSecretRef(ref)]);
    if (result.code !== 0 && result.code !== KEYCHAIN_NOT_FOUND) throw failure('Removing the credential from the macOS Keychain', result);
  }
}

/** Freedesktop Secret Service (GNOME Keyring, KWallet) through `secret-tool`. */
export class SecretServiceStore implements SecretStore {
  readonly kind = 'secret-service' as const;
  private readonly service: string;
  private readonly run: CommandRunner;
  private readonly tool: string;

  constructor({ service = DEFAULT_SECRET_SERVICE, run = runCommand, secretToolPath = 'secret-tool' }: CommandStoreOptions & { secretToolPath?: string } = {}) {
    this.service = checkService(service);
    this.run = run;
    this.tool = secretToolPath;
  }

  private attributes(ref: string): string[] {
    return ['service', this.service, 'account', checkSecretRef(ref)];
  }

  async get(ref: string): Promise<string | undefined> {
    const result = await this.run(this.tool, ['lookup', ...this.attributes(ref)]);
    // `secret-tool lookup` exits with 1 and prints nothing when no item matches.
    if (result.code !== 0) {
      if (!result.stderr.trim()) return undefined;
      throw failure('Reading the credential from the Secret Service', result);
    }
    return result.stdout.replace(/\r?\n$/, '') || undefined;
  }

  async set(ref: string, secret: string): Promise<void> {
    const value = checkSecret(secret);
    const result = await this.run(this.tool, ['store', '--label=Extalia credential', ...this.attributes(ref)], value);
    if (result.code !== 0) throw failure('Saving the credential in the Secret Service', result, value);
  }

  async delete(ref: string): Promise<void> {
    const result = await this.run(this.tool, ['clear', ...this.attributes(ref)]);
    if (result.code !== 0 && result.stderr.trim()) throw failure('Removing the credential from the Secret Service', result);
  }
}

/** Fallback when no OS credential store exists: a JSON map readable only by the current user. */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  async get(ref: string): Promise<string | undefined> {
    checkSecretRef(ref);
    await this.queue;
    return (await this.read()).get(ref);
  }

  set(ref: string, secret: string): Promise<void> {
    checkSecretRef(ref);
    const value = checkSecret(secret);
    return this.mutate(secrets => secrets.set(ref, value));
  }

  delete(ref: string): Promise<void> {
    checkSecretRef(ref);
    return this.mutate(secrets => secrets.delete(ref));
  }

  private async read(): Promise<Map<string, string>> {
    const data = await readJson<unknown>(this.file, {});
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(value => typeof value !== 'string')) {
      throw new Error(`${this.file} is not a credential file written by Extalia. Extalia left it unchanged.`);
    }
    return new Map(Object.entries(data as Record<string, string>));
  }

  // Serialized so concurrent saves never lose each other's changes.
  private mutate(change: (secrets: Map<string, string>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const secrets = await this.read();
      change(secrets);
      await writeJsonAtomic(this.file, Object.fromEntries(secrets), { mode: PRIVATE_FILE_MODE });
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** In-memory store for tests and explicitly ephemeral setups. */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  private readonly secrets = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(checkSecretRef(ref));
  }

  async set(ref: string, secret: string): Promise<void> {
    this.secrets.set(checkSecretRef(ref), checkSecret(secret));
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(checkSecretRef(ref));
  }
}

export interface SecretStoreOptions {
  stateDirectory: string;
  /** Node's `process.platform` value. */
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  serviceName?: string;
  run?: CommandRunner;
  /** Location of the macOS `security` tool; tests point it at a temporary file. */
  securityPath?: string;
}

async function isExecutable(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return true; } catch { return false; }
}

async function findOnPath(name: string, env: Readonly<Record<string, string | undefined>>, platform: string): Promise<string | undefined> {
  const directories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Pick the credential store: `EXTALIA_SECRET_STORE` (`file`, `memory`,
 * `keychain`, `secret-service`) forces one; otherwise the macOS Keychain, then
 * the Secret Service on Linux, then `<state>/secrets.json`.
 */
export async function createSecretStore(options: SecretStoreOptions): Promise<SecretStore> {
  const { stateDirectory, platform, env, serviceName: service = DEFAULT_SECRET_SERVICE, run = runCommand, securityPath = SECURITY_PATH } = options;
  const file = () => new FileSecretStore(path.join(stateDirectory, 'secrets.json'));
  const forced = env[SECRET_STORE_OVERRIDE]?.trim().toLowerCase();
  if (forced) {
    switch (forced) {
      case 'file': return file();
      case 'memory': return new MemorySecretStore();
      case 'keychain': case 'os-keychain': return new MacKeychainStore({ service, run, securityPath });
      case 'secret-service': return new SecretServiceStore({ service, run, secretToolPath: (await findOnPath('secret-tool', env, platform)) ?? 'secret-tool' });
      default: throw new Error(`${SECRET_STORE_OVERRIDE} must be one of file, memory, keychain, secret-service.`);
    }
  }
  if (platform === 'darwin' && await isExecutable(securityPath)) return new MacKeychainStore({ service, run, securityPath });
  if (platform === 'linux') {
    const secretTool = await findOnPath('secret-tool', env, platform);
    if (secretTool) return new SecretServiceStore({ service, run, secretToolPath: secretTool });
  }
  return file();
}

/** The secret a connection needs right now, or undefined when it has none or it is missing. */
export async function resolveCredential(source: CredentialSource, store: SecretStore, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  switch (source.kind) {
    case 'none': return undefined;
    case 'env': return env[source.variable]?.trim() || undefined;
    case 'stored': return store.get(source.ref);
  }
}
