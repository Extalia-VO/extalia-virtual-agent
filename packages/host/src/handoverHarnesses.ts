import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { HandoverHarnessDestination, HandoverHarnessInventory, ObservedControlStatus, SessionSummary } from '@extalia/platform';
import { findOnPath, isExecutable } from './connect/util.js';

const definitions = [
  { id: 'codex', sources: ['codex'], commands: ['codex'], app: 'Codex.app' },
  { id: 'claude', sources: ['claude-code', 'claude'], commands: ['claude'], app: 'Claude.app' },
  { id: 'antigravity', sources: ['antigravity'], commands: ['antigravity'], app: 'Antigravity.app' },
  { id: 'kiro', sources: ['kiro', 'kiro-cli'], commands: ['kiro-cli', 'kiro'], app: 'Kiro.app' },
  { id: 'hermes', sources: ['hermes'], commands: ['hermes'] },
  { id: 'opencode', sources: ['opencode', 'open-code'], commands: ['opencode'], app: 'OpenCode.app' },
  { id: 'gemini', sources: ['gemini-cli', 'gemini'], commands: ['gemini'] },
] as const;
interface Options {
  sourceSessionId: string;
  boundary: string;
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** Already restricted to the source's own workspace by the host. */
  sessions: readonly SessionSummary[];
  nativeReady: boolean;
  antigravityCreateReady: boolean;
  control(id: string): Promise<ObservedControlStatus>;
  applicationRoots?: readonly string[];
}
const directory = async (file: string) => { try { return (await stat(file)).isDirectory(); } catch { return false; } };

/** Filesystem/capability discovery only: never launches a CLI, pairs a runtime or creates a conversation. */
export async function discoverHandoverHarnesses(options: Options): Promise<HandoverHarnessInventory> {
  const harnesses: HandoverHarnessDestination[] = [{ id: 'extalia', sourceIds: ['extalia-native'], evidence: ['builtin'], existing: 'unsupported',
    create: options.nativeReady ? 'ready' : 'unavailable', sessionIds: [], ...(!options.nativeReady ? { reason: 'no-connection' as const } : {}) }];
  const known = new Set<string>();
  for (const definition of definitions) {
    for (const source of definition.sources) known.add(source);
    const sessions = options.sessions.filter(session => session.control === 'observed' && definition.sources.some(source => source === session.observation?.sourceId));
    const evidence: HandoverHarnessDestination['evidence'] = [];
    if (definition.id === 'antigravity' && options.antigravityCreateReady) evidence.push('native-connection');
    const override = options.env[`EXTALIA_${definition.id.toUpperCase()}_BIN`];
    if (override && await isExecutable(override) || (await Promise.all(definition.commands.map(command => findOnPath(command, options.env, options.platform)))).some(Boolean)) evidence.push('executable');
    if ('app' in definition && options.platform === 'darwin') {
      const roots = options.applicationRoots ?? ['/Applications', path.join(options.homeDirectory, 'Applications')];
      if ((await Promise.all(roots.map(root => directory(path.join(root, definition.app))))).some(Boolean)) evidence.push('application');
    }
    if (sessions.length) evidence.push('observed-session');
    if (!evidence.length) continue;
    const controls = await Promise.allSettled(sessions.map(session => options.control(session.id)));
    const ready = controls.some(value => value.status === 'fulfilled' && value.value.routes.some(route => route.capabilities.some(capability => capability.available)));
    const supported = definition.id !== 'kiro' && definition.id !== 'opencode';
    const create = definition.id === 'antigravity' ? options.antigravityCreateReady ? 'ready' : 'unavailable' : 'unsupported';
    const existing = ready ? 'ready' : supported ? 'setup-required' : 'unsupported';
    harnesses.push({ id: definition.id, sourceIds: [...definition.sources], evidence, existing, create, sessionIds: sessions.map(session => session.id),
      ...(!ready && create !== 'ready' ? { reason: supported ? 'setup-required' as const : 'adapter-unavailable' as const } : {}) });
  }
  for (const sourceId of new Set(options.sessions.flatMap(session => session.control === 'observed' && session.observation?.sourceId ? [session.observation.sourceId] : []))) {
    if (known.has(sourceId)) continue;
    const sessions = options.sessions.filter(session => session.observation?.sourceId === sourceId);
    harnesses.push({ id: sourceId, sourceIds: [sourceId], evidence: ['observed-session'], existing: 'setup-required', create: 'unsupported', sessionIds: sessions.map(session => session.id), reason: 'setup-required' });
  }
  return { sourceSessionId: options.sourceSessionId,
    revision: createHash('sha256').update(JSON.stringify([options.sourceSessionId, options.boundary, harnesses])).digest('hex'), harnesses };
}
