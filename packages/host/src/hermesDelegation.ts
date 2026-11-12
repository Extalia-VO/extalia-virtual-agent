import { MAX_HERMES_ONESHOT_TEAM_MEMBERS, MAX_HERMES_TEAM_MEMBERS } from '@extalia/core';
import { isModelId, type HermesDelegationLimits } from '@extalia/platform';
import { HERMES_PROFILE_PATTERN } from '@extalia/runtime';
import * as yaml from 'js-yaml';
import { constants as fsConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { hermesEnvironment, hermesProfile, hermesRoot } from './hermes.js';

type Env = Readonly<Record<string, string | undefined>>;
type Mapping = Record<string, unknown>;
const { load, DEFAULT_SCHEMA, Type } = yaml;
// js-yaml exposes its built-in scalar types, but @types/js-yaml omits this export.
// Keep the missing public surface scoped here; consumer projects need no ambient declaration.
const numericTypes = (yaml as typeof yaml & { types: Record<'int' | 'float', { resolve(value: string | null): boolean }> }).types;
const MAX_CONFIG_BYTES = 1024 * 1024;
const BATCH_ENV = 'DELEGATION_MAX_CONCURRENT_CHILDREN';
const error = (profile: string, reason: string) => new Error(`Cannot read delegation limits for Hermes profile "${profile}": ${reason}. Review its config.yaml and delegation settings.`);
const mapping = (value: unknown): value is Mapping => Boolean(value) && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Hermes uses PyYAML's YAML 1.1 scalar rules. Retain numeric spellings so YAML 1.2
// octal/exponent/leading-zero coercions cannot silently produce a larger budget.
class YamlNumber { constructor(readonly raw: string) {} }
const LIMIT_SCHEMA = DEFAULT_SCHEMA.extend({ implicit: (['int', 'float'] as const).map(kind => new Type(`tag:yaml.org,2002:${kind}`, {
  kind: 'scalar', resolve: (value: string | null) => numericTypes[kind].resolve(value), construct: (value: string) => new YamlNumber(value),
})) });

/** Bounded read through one handle; no external tool, config migration, backups or writes. */
async function readBounded(file: string, profile: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error(profile, 'a configuration file is unreadable');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw error(profile, 'a configuration file is not a regular file within the 1 MiB read limit');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CONFIG_BYTES) throw error(profile, 'a configuration file exceeds the 1 MiB read limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Cannot read delegation limits')) throw cause;
    throw error(profile, 'a configuration file cannot be read as UTF-8');
  } finally { await handle.close(); }
}

async function configAt(directory: string, profile: string): Promise<Mapping> {
  const text = await readBounded(path.join(directory, 'config.yaml'), profile);
  if (text === undefined) return {};
  let value: unknown;
  try { value = load(text, { schema: LIMIT_SCHEMA }); }
  catch { throw error(profile, 'config.yaml is invalid YAML'); }
  if (value === undefined || value === null) return {};
  if (!mapping(value)) throw error(profile, 'config.yaml must contain a mapping');
  return value;
}

function section(config: Mapping, profile: string): Mapping {
  const value = config.delegation;
  if (value === undefined || value === null) return {};
  if (!mapping(value)) throw error(profile, 'delegation must contain a mapping');
  return value;
}

function expand(value: unknown, env: Env): unknown {
  return typeof value === 'string' ? value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (original, name: string) => env[name] ?? original) : value;
}

/** Only one allowlisted dotenv assignment; preserve empty values and last-assignment precedence. */
function batchFromDotenv(text: string | undefined, baseline: Env, profile: string): string | undefined {
  let value: string | undefined;
  for (const line of text?.split(/\r?\n/) ?? []) {
    const match = /^\s*(?:export\s+)?DELEGATION_MAX_CONCURRENT_CHILDREN\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const quoted = /^(['"])(.*?)\1(?:\s*(?:#.*)?)$/.exec(raw);
    if (/^['"]/.test(raw) && !quoted) throw error(profile, 'the concurrent-child dotenv setting is malformed');
    const clean = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '').trim();
    value = expand(clean, { ...baseline, [BATCH_ENV]: value ?? baseline[BATCH_ENV] }) as string;
  }
  return value;
}

function integer(value: unknown, fallback: number, floor: number, profile: string, field: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = value instanceof YamlNumber ? value.raw : value;
  const number = typeof raw === 'string' && /^(?:0|[1-9]\d*)$/.test(raw.trim()) ? Number(raw) : raw;
  // Fail closed instead of interpreting a typo/negative value as a larger or unlimited budget.
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw error(profile, `${field} must be a non-negative integer in decimal form (0 or digits without leading zeros)`);
  return Math.max(floor, number);
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}

/**
 * Verified against installed Hermes source: profiles.resolve_profile_env,
 * config.load_config_readonly, env_loader._load_user_dotenv and
 * tools/delegate_tool_config.py (_get_oneshot_max_children / _get_max_concurrent_children).
 * Named profiles read their own config, with no default-profile inheritance.
 * Config > selected profile .env > inherited environment > batch default 10.
 * Managed config leaves and its selected dotenv value take precedence when present.
 * Only public limits/model identifiers leave this reader; YAML errors never echo file content.
 */
export async function hermesDelegationLimits(env: Env, homeDirectory: string, profile: string, leadModel?: string): Promise<HermesDelegationLimits> {
  if (!HERMES_PROFILE_PATTERN.test(profile)) throw new Error('Unknown Hermes profile.');
  profile = hermesProfile(env, homeDirectory, profile);
  const root = hermesRoot(env, homeDirectory);
  const directory = profile === 'default' ? root : path.join(root, 'profiles', profile);
  if (profile !== 'default') {
    const identity = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'];
    try {
      if (!(await stat(directory)).isDirectory() || await exists(path.join(root, 'profiles', '.deleted', profile)) || !(await Promise.all(identity.map(name => exists(path.join(directory, name))))).some(Boolean)) {
        throw error(profile, 'the named profile is missing or deleted');
      }
    } catch { throw error(profile, 'the named profile is missing, deleted or unreadable'); }
  }
  const config = await configAt(directory, profile);
  const own = section(config, profile);
  // Read only this allowlisted variable from dotenv; credentials and prompts are never projected.
  const dotenv = await readBounded(path.join(directory, '.env'), profile);
  const processEnv = hermesEnvironment(env);
  const profileBatch = batchFromDotenv(dotenv, processEnv, profile);
  let effectiveEnv: Env = { ...processEnv, ...(profileBatch !== undefined ? { [BATCH_ENV]: profileBatch } : {}) };
  let managed: Mapping = {};
  const managedDirectory = env.HERMES_MANAGED_DIR?.trim() || '/etc/hermes';
  let managedPresent: boolean;
  try { managedPresent = (await stat(managedDirectory)).isDirectory(); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw error(profile, 'the managed configuration directory is unreadable');
    managedPresent = false;
  }
  if (managedPresent) {
    managed = await configAt(managedDirectory, profile);
    const managedDotenv = await readBounded(path.join(managedDirectory, '.env'), profile);
    const managedBatch = batchFromDotenv(managedDotenv, effectiveEnv, profile);
    if (managedBatch !== undefined) effectiveEnv = { ...effectiveEnv, [BATCH_ENV]: managedBatch };
  }
  const pinned = section(managed, profile);
  const selected = (name: string): unknown => expand(Object.hasOwn(pinned, name) ? pinned[name] : own[name], effectiveEnv);
  const oneshotMaxChildren = integer(selected('oneshot_max_children'), MAX_HERMES_ONESHOT_TEAM_MEMBERS, 0, profile, 'delegation.oneshot_max_children');
  const maxConcurrentChildren = integer(selected('max_concurrent_children') ?? effectiveEnv[BATCH_ENV], 10, 1, profile, 'delegation.max_concurrent_children');
  const configuredModel = selected('model');
  if (configuredModel !== undefined && configuredModel !== null && configuredModel !== '' && !isModelId(configuredModel)) throw error(profile, 'delegation.model must be a model identifier');
  const modelValue = (value: unknown): unknown => typeof value === 'string' ? value : mapping(value) ? value.default ?? value.model ?? value.name : undefined;
  const pinnedModel = modelValue(managed.model);
  const profileModel = expand(pinnedModel !== undefined ? pinnedModel : modelValue(config.model), effectiveEnv);
  const backend = selected('backend');
  if (backend !== undefined && backend !== null && typeof backend !== 'string') throw error(profile, 'delegation.backend must be a backend identifier');
  const modelRouting = typeof backend === 'string' && backend.trim() && backend.trim().toLowerCase() !== 'default' ? 'profile-custom' : 'shared';
  const workerModel = modelRouting === 'profile-custom' ? undefined : isModelId(configuredModel) ? configuredModel : isModelId(leadModel) ? leadModel : isModelId(profileModel) ? profileModel : undefined;
  const fields = ['oneshot_max_children', 'max_concurrent_children', 'model', 'backend'];
  const source = fields.some(name => Object.hasOwn(pinned, name)) ? 'managed' : fields.some(name => Object.hasOwn(own, name)) ? 'profile' : effectiveEnv[BATCH_ENV] ? 'environment' : 'defaults';
  return { profile, oneshotMaxChildren, maxConcurrentChildren,
    maxTeamMembers: Math.min(MAX_HERMES_TEAM_MEMBERS, oneshotMaxChildren || MAX_HERMES_TEAM_MEMBERS),
    ...(workerModel ? { workerModel } : {}), workerModelSource: isModelId(configuredModel) ? 'delegation' : 'lead', modelRouting, source };
}
