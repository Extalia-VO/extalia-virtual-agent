import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { CodexPermissionHookAnswer, CodexPermissionHookStatus, CodexPermissionSetupPlan } from '@extalia/platform';
import { CodexPermissionBroker, type CodexPermissionTarget } from './codexPermissionBroker.js';
import { applyCodexPermissionHookSetup, previewCodexPermissionHookSetup, previewCodexPermissionHookUndo, undoCodexPermissionHookSetup, type CodexPermissionHookSetupOptions } from './connect/codexPermissionHookSetup.js';
import { codexPermissionTokenFile } from './connect/codexPermissionForwarder.js';
import { resolveNodePath } from './connect/nodeRuntime.js';
import { secretMatches } from './hooks/http.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

export interface ObservedCodexPermissionTarget extends CodexPermissionTarget { transcriptPath: string }
interface Options {
  dataDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  target(id: string): ObservedCodexPermissionTarget | undefined;
  resolve(payload: Record<string, unknown>): string | undefined;
}
interface Binding { sessionId: string; threadId: string; codexHome: string; sourceFingerprint: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validText = (value: unknown, max = 4096): value is string => typeof value === 'string' && !!value && value.length <= max && !value.includes('\0');
const absolute = (value: unknown): value is string => validText(value) && path.isAbsolute(value);
const binding = (sessionId: string, target: CodexPermissionTarget): Binding => ({ sessionId, threadId: target.threadId, codexHome: target.codexHome, sourceFingerprint: target.sourceFingerprint });
const same = (left: Binding | undefined, right: Binding | undefined) => !!left && !!right && JSON.stringify(left) === JSON.stringify(right);

/** Read an owned private regular file without following a final symlink or unbounded allocation. */
async function privateText(file: string, limit: number): Promise<string | undefined> {
  let info;
  try { info = await lstat(file); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
  const uid = process.platform !== 'win32' ? process.getuid?.() : undefined;
  if (!info.isFile() || info.size > limit || uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0)) throw new Error('Private permission metadata is unsafe.');
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size > limit
      || uid !== undefined && (current.uid !== uid || (current.mode & 0o077) !== 0)) throw new Error('Private permission metadata changed.');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) { const result = await handle.read(bytes, size, bytes.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > limit) throw new Error('Private permission metadata is too large.');
    return bytes.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}

/** Approved installation and source binding; native trust remains entirely in Codex. */
export class ObservedCodexPermissionService {
  private readonly bindings = new Map<string, Binding>();
  private readonly active = new Set<string>();
  private readonly paused = new Set<string>();
  private readonly broker: CodexPermissionBroker;
  private readonly file: string;
  private closed = false;
  private mutating = false;
  private generation = 0;
  private damaged = false;
  private operations: Promise<void> = Promise.resolve();
  private node?: Promise<string | undefined>;

  private constructor(private readonly options: Options) {
    this.file = path.join(options.dataDirectory, 'state', 'observed-codex-permissions.json');
    this.broker = new CodexPermissionBroker({
      target: id => !this.mutating && this.active.has(id) && !this.paused.has(id) ? this.source(id) : undefined,
      resolve: payload => {
        const id = this.options.resolve(payload), target = id ? this.source(id) : undefined;
        return id && target && target.threadId === payload.session_id && target.transcriptPath === payload.transcript_path && target.cwd === payload.cwd ? id : undefined;
      },
      verifyToken: async given => {
        const token = await this.token();
        if (!token || !secretMatches(token, given)) return false;
        await Promise.all([...this.bindings.keys()].map(id => this.validate(id)));
        return true;
      },
    });
  }

  static async create(options: Options): Promise<ObservedCodexPermissionService> {
    const service = new ObservedCodexPermissionService(options);
    try {
      const text = await privateText(service.file, 128 * 1024);
      if (text === undefined) return service;
      const raw: unknown = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const data = raw as { version?: unknown; bindings?: unknown };
      if (Object.keys(data).length !== 2 || data.version !== 1 || !Array.isArray(data.bindings) || data.bindings.length > 128) throw new Error();
      for (const item of data.bindings) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
        const row = item as Binding;
        if (Object.keys(row).length !== 4 || !validText(row.sessionId, 200) || !UUID.test(row.threadId)
          || !absolute(row.codexHome) || !/^[0-9a-f]{64}$/.test(row.sourceFingerprint) || service.bindings.has(row.sessionId)) throw new Error();
        service.bindings.set(row.sessionId, row);
      }
      await Promise.all([...service.bindings.keys()].map(id => service.validate(id)));
    } catch { service.damaged = true; service.active.clear(); }
    return service;
  }

  private source(id: string): ObservedCodexPermissionTarget | undefined {
    if (this.closed || this.damaged || !validText(id, 200)) return undefined;
    try {
      const target = this.options.target(id);
      return target && UUID.test(target.threadId) && absolute(target.codexHome) && absolute(target.cwd)
        && absolute(target.transcriptPath) && /^[0-9a-f]{64}$/.test(target.sourceFingerprint) ? target : undefined;
    } catch { return undefined; }
  }

  private async setup(target: Pick<CodexPermissionTarget, 'codexHome' | 'threadId'>, undo = false): Promise<CodexPermissionHookSetupOptions> {
    // Removal never executes or installs this path and must work without standalone Node.
    const nodePath = undo ? process.execPath : await (this.node ??= resolveNodePath({ execPath: process.execPath, electron: !!process.versions.electron, env: this.options.env, platform: process.platform }));
    if (!nodePath) { this.node = undefined; throw new Error('Permission hooks require a standalone Node.js installation.'); }
    return { extaliaHome: this.options.dataDirectory, codexHome: target.codexHome, nativeSessionId: target.threadId, nodePath, platform: process.platform };
  }

  private async token(): Promise<string | undefined> {
    try { const value = (await privateText(codexPermissionTokenFile(this.options.dataDirectory), 256))?.trim(); return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined; }
    catch { return undefined; }
  }

  private async validate(id: string): Promise<boolean> {
    if (this.mutating) return false;
    const generation = this.generation;
    const target = this.source(id), saved = this.bindings.get(id);
    let valid = !!target && same(saved, binding(id, target));
    if (valid) {
      try { valid = !(await previewCodexPermissionHookSetup(await this.setup(target!))).changed && !!await this.token(); }
      catch { valid = false; }
    }
    // Recheck source after async file inspection before making it eligible.
    const current = this.source(id);
    if (this.closed || this.mutating || generation !== this.generation || saved !== this.bindings.get(id)) return false;
    valid = valid && !!current && same(saved, binding(id, current));
    if (valid) { this.active.add(id); if (!this.paused.has(id)) this.broker.resume(id); }
    else if (this.active.delete(id)) this.broker.drop(id);
    return valid;
  }

  async status(id: string): Promise<CodexPermissionHookStatus> {
    const installed = await this.validate(id);
    return { ...this.broker.status(id), installed, ...(this.damaged ? { problem: 'Saved permission setup is damaged. Inspect the local metadata before changing it.' } : {}) };
  }

  private async plan(id: string, undo: boolean) {
    const target = this.source(id);
    const saved = this.bindings.get(id);
    if (!target && !(undo && saved)) throw new Error('Choose the original observed Codex source before setting up permission hooks.');
    // Removal stays bound to the approved original profile even after observation drift.
    const source = undo && saved ? saved : target ? binding(id, target) : saved!;
    const setup = await this.setup(source, undo);
    const raw = undo ? await previewCodexPermissionHookUndo(setup) : await previewCodexPermissionHookSetup(setup);
    const localChanged = undo ? !!saved : !same(saved, source);
    const metadata = localChanged ? `Extalia local metadata: ${undo ? 'remove' : 'enable'} permission forwarding for this exact observed source.\n` : '';
    return { source, setup, rawRevision: raw.revision, preview: {
      ...raw, changed: raw.changed || localChanged,
      diff: [raw.diff, metadata].filter(Boolean).join('\n'), revision: sha([undo, source, saved ?? null, raw.revision]),
    } satisfies CodexPermissionSetupPlan };
  }

  async preview(id: string, undo = false): Promise<CodexPermissionSetupPlan> {
    if (this.closed || this.damaged) throw new Error('Permission setup is unavailable.');
    return (await this.plan(id, undo)).preview;
  }

  apply(id: string, revision: string, undo = false): Promise<CodexPermissionHookStatus> {
    const operation = this.operations.then(async () => {
      if (this.closed || this.damaged) throw new Error('Permission setup is unavailable.');
      this.mutating = true; this.generation++;
      try {
      const plan = await this.plan(id, undo);
      if (!revision || revision !== plan.preview.revision) throw new Error('The permission setup or observed source changed. Review a new preview.');
      if (!undo && this.bindings.size >= 128 && !this.bindings.has(id)) throw new Error('The permission setup limit has been reached.');
      // Existing waiters never survive an installation/removal operation.
      for (const [other, saved] of this.bindings) if (saved.codexHome === plan.source.codexHome) this.broker.drop(other);
      if (undo) await undoCodexPermissionHookSetup(plan.setup, plan.rawRevision);
      else await applyCodexPermissionHookSetup(plan.setup, plan.rawRevision);
      const current = this.source(id);
      if (!undo && (!current || !same(plan.source, binding(id, current)))) throw new Error('The observed source changed during setup. Permission forwarding remains disabled.');
      if (undo) {
        for (const [other, saved] of this.bindings) if (saved.codexHome === plan.source.codexHome) { this.bindings.delete(other); this.active.delete(other); }
      } else {
        for (const [other, saved] of this.bindings) if (saved.codexHome === plan.source.codexHome) { this.bindings.delete(other); this.active.delete(other); }
        this.bindings.set(id, plan.source);
      }
      try { await writeJsonAtomic(this.file, { version: 1, bindings: [...this.bindings.values()] }, { mode: 0o600 }); }
      catch { this.damaged = true; this.active.clear(); this.broker.close(); throw new Error('Could not save the approved permission binding. Forwarding is disabled.'); }
      this.mutating = false; this.generation++;
      return await this.status(id);
      } finally { this.mutating = false; this.generation++; }
    });
    this.operations = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> { await this.broker.handle(request, response); }
  async answer(id: string, input: CodexPermissionHookAnswer): Promise<CodexPermissionHookStatus> {
    const installed = await this.validate(id);
    return { ...this.broker.answer(id, input), installed };
  }
  drop(id: string): void { this.generation++; this.paused.add(id); this.broker.drop(id); }
  resume(id: string): void { this.generation++; this.paused.delete(id); if (!this.closed) this.broker.resume(id); }
  async close(): Promise<void> { this.closed = true; this.generation++; this.broker.close(); await this.operations; this.active.clear(); }
}
