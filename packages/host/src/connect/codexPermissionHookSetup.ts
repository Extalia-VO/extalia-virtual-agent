import { randomBytes } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseCodexConfig } from './codex.js';
import { CODEX_PERMISSION_FORWARDER_SOURCE, codexPermissionForwarderPath, codexPermissionTokenFile } from './codexPermissionForwarder.js';
import { commitConfigWrites, type ConfigWrite } from './configTransaction.js';
import { unifiedDiff } from './diff.js';
import { withConnectOperation } from './operationJournal.js';
import { ConnectError, quoteArgument, readTextIfExists, sha256, writableTarget, writeConfigFile } from './util.js';

export const CODEX_PERMISSION_BEGIN_MARKER = '# >>> extalia synchronous permissions (remove with: extalia connect codex-permission --undo) >>>';
export const CODEX_PERMISSION_END_MARKER = '# <<< extalia synchronous permissions <<<';

export interface CodexPermissionHookSetupOptions {
  extaliaHome: string;
  codexHome: string;
  nodePath: string;
  platform: string;
  /** Only this exact native Codex conversation may contact the approval broker. */
  nativeSessionId: string;
}

export type CodexPermissionHookUndoOptions = Omit<CodexPermissionHookSetupOptions, 'nodePath'>;

export interface CodexPermissionHookSetupPreview {
  nativeSessionId: string;
  revision: string;
  changed: boolean;
  configPath: string;
  forwarderPath: string;
  tokenPath: string;
  createsPermissionToken: boolean;
  diff: string;
  /** Trust is deliberately never written by this installer. */
  needsTrust: true;
  undoCommand: string;
  backupDirectory: string;
  files: Array<{ path: string; beforeSha256?: string; afterSha256: string; removed?: true }>;
}

interface Receipt {
  schema: 'extalia.codex-permission-setup.v1';
  configPath: string;
  target: string;
  original?: string;
  originalSha256?: string;
  installed: string;
  nativeSessionId: string;
}

const undoCommand = (options: CodexPermissionHookUndoOptions) => `extalia connect codex-permission --session ${quoteArgument(options.nativeSessionId, options.platform)} --codex-home ${quoteArgument(options.codexHome, options.platform)} --undo`;
const recoverCommand = 'extalia connections --recover';
const directory = (options: CodexPermissionHookUndoOptions) => path.join(options.extaliaHome, 'connect');
const receiptPath = async (options: CodexPermissionHookUndoOptions) => path.join(directory(options), 'codex-permissions', sha256(await writableTarget(options.codexHome)), 'receipt.json');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSessionId(options: CodexPermissionHookUndoOptions): void {
  if (typeof options.nativeSessionId !== 'string' || !SESSION_ID.test(options.nativeSessionId)) {
    throw new ConnectError('Permission hook setup requires the selected native Codex conversation UUID. Nothing was written.');
  }
}

function blockRange(source: string): { start: number; end: number } | undefined {
  const start = source.indexOf(CODEX_PERMISSION_BEGIN_MARKER);
  const end = source.indexOf(CODEX_PERMISSION_END_MARKER);
  if (start === -1 && end === -1) return undefined;
  if (start === -1 || end < start || source.indexOf(CODEX_PERMISSION_BEGIN_MARKER, start + 1) !== -1
    || source.indexOf(CODEX_PERMISSION_END_MARKER, end + 1) !== -1) {
    throw new ConnectError('The Extalia permission hook markers were edited. Repair them before installing or removing the hook. Nothing was written.');
  }
  let boundary = end + CODEX_PERMISSION_END_MARKER.length;
  if (source[boundary] === '\r') boundary++;
  if (source[boundary] === '\n') boundary++;
  return { start, end: boundary };
}

export function codexPermissionHookBlock(command: string): string {
  return [CODEX_PERMISSION_BEGIN_MARKER, '[[hooks.PermissionRequest]]', 'matcher = "*"',
    `hooks = [{ type = "command", command = ${JSON.stringify(command)}, async = false, timeout = 65 }]`,
    CODEX_PERMISSION_END_MARKER, ''].join('\n');
}

function planConfig(source: string, file: string, command: string): string {
  parseCodexConfig(source, file);
  const range = blockRange(source);
  const outside = range ? source.slice(0, range.start) + source.slice(range.end) : source;
  if (outside.includes('codex-permission.mjs')) throw new ConnectError('An Extalia permission hook exists outside its managed block. Review it before installing another hook. Nothing was written.');
  const block = codexPermissionHookBlock(command);
  const separator = !source || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  const after = range ? source.slice(0, range.start) + block + source.slice(range.end) : source + separator + block;
  parseCodexConfig(after, file);
  return after;
}

async function planned(options: CodexPermissionHookSetupOptions): Promise<{ preview: CodexPermissionHookSetupPreview; writes: ConfigWrite[]; source: string | undefined }> {
  requireSessionId(options);
  if (![options.extaliaHome, options.codexHome, options.nodePath].every(value => path.isAbsolute(value))) {
    throw new ConnectError('Permission hook setup requires absolute data, Codex home and Node paths. Nothing was written.');
  }
  const configPath = path.join(options.codexHome, 'config.toml');
  if (await readTextIfExists(path.join(options.codexHome, 'hooks.json')) !== undefined) {
    throw new ConnectError('Codex hooks.json already exists in this user layer. Move its hooks into config.toml and remove hooks.json before using this installer, or add the synchronous permission handler to hooks.json by hand. Nothing was written.');
  }
  const forwarderPath = codexPermissionForwarderPath(options.extaliaHome);
  const source = await readTextIfExists(configPath);
  const command = `${quoteArgument(options.nodePath, options.platform)} ${quoteArgument(forwarderPath, options.platform)} --session ${quoteArgument(options.nativeSessionId, options.platform)}`;
  const after = planConfig(source ?? '', configPath, command);
  const scriptBefore = await readTextIfExists(forwarderPath);
  if (scriptBefore !== undefined && !scriptBefore.startsWith('// extalia-codex-permission-forwarder v')) {
    throw new ConnectError('The permission forwarder path contains an unrecognized file. Nothing was written.');
  }
  const entries = [{ file: configPath, before: source, after }, { file: forwarderPath, before: scriptBefore, after: CODEX_PERMISSION_FORWARDER_SOURCE }];
  const writes: ConfigWrite[] = [];
  for (const entry of entries) writes.push({ ...entry, target: await writableTarget(entry.file), mode: 0o600 });
  const revision = sha256(JSON.stringify(writes));
  const backupDirectory = path.join(directory(options), 'backups', 'codex-permission', revision);
  const tokenPath = codexPermissionTokenFile(options.extaliaHome);
  const tokenExists = await lstat(tokenPath).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  return { source, writes, preview: {
    nativeSessionId: options.nativeSessionId,
    revision, changed: entries.some(entry => entry.before !== entry.after) || !tokenExists, configPath, forwarderPath, tokenPath, createsPermissionToken: !tokenExists,
    diff: entries.map(entry => unifiedDiff(entry.before ?? '', entry.after, { from: entry.file, to: entry.file, context: 0 })).filter(Boolean).join('\n'),
    needsTrust: true, undoCommand: undoCommand(options), backupDirectory,
    files: writes.map(entry => ({ path: entry.file, ...(entry.before === undefined ? {} : { beforeSha256: sha256(entry.before) }), afterSha256: sha256(entry.after) })),
  } };
}

/** Read-only, including when the data directory does not exist. Never updates hook trust or policy. */
export async function previewCodexPermissionHookSetup(options: CodexPermissionHookSetupOptions): Promise<CodexPermissionHookSetupPreview> {
  return (await planned(options)).preview;
}

async function readReceipt(options: CodexPermissionHookUndoOptions): Promise<{ text: string; value: Receipt } | undefined> {
  const text = await readTextIfExists(await receiptPath(options));
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Receipt;
    if (value.schema !== 'extalia.codex-permission-setup.v1' || typeof value.configPath !== 'string' || !path.isAbsolute(value.configPath)
      || typeof value.target !== 'string' || typeof value.installed !== 'string'
      || typeof value.nativeSessionId !== 'string' || !SESSION_ID.test(value.nativeSessionId)
      || (value.original !== undefined && (typeof value.original !== 'string' || sha256(value.original) !== value.originalSha256))) throw new Error();
    if (await writableTarget(path.dirname(value.configPath)) !== await writableTarget(options.codexHome)) throw new Error();
    return { text, value };
  } catch { throw new ConnectError('The permission hook setup receipt cannot be read. Inspect the connection backups before continuing. Nothing was written.'); }
}

/** Caller must present this exact preview and obtain the user's approval before calling. */
export async function applyCodexPermissionHookSetup(options: CodexPermissionHookSetupOptions, approvedRevision: string): Promise<CodexPermissionHookSetupPreview> {
  return withConnectOperation(directory(options), { kind: 'connect', app: 'codex' }, { recoverCommand }, async journal => {
    const plan = await planned(options);
    if (!approvedRevision || approvedRevision !== plan.preview.revision) throw new ConnectError('Permission hook setup changed after preview. Review and approve a new preview. Nothing was written.');
    const prior = await readReceipt(options);
    const config = plan.writes[0]!;
    if (prior && prior.value.target !== config.target) throw new ConnectError('The Codex configuration link target changed. Restore it before continuing. Nothing was written.');
    const tokenPath = codexPermissionTokenFile(options.extaliaHome);
    const tokenBefore = await readTextIfExists(tokenPath);
    if (tokenBefore !== undefined) {
      const info = await lstat(tokenPath);
      if (!/^[a-f0-9]{64}$/.test(tokenBefore.trim()) || !info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new ConnectError('The permission token is invalid or has unsafe permissions. Inspect it before retrying. Nothing was written.');
      }
    }
    if (!plan.preview.changed && prior && tokenBefore !== undefined) { await journal.complete(); return plan.preview; }
    const receipt: Receipt = {
      schema: 'extalia.codex-permission-setup.v1', configPath: config.file, target: config.target, nativeSessionId: options.nativeSessionId,
      ...(prior && plan.source !== prior.value.installed ? (() => {
        const range = blockRange(plan.source ?? '');
        const original = range ? plan.source!.slice(0, range.start) + plan.source!.slice(range.end) : plan.source;
        return original === undefined ? {} : { original, originalSha256: sha256(original) };
      })() : prior ? prior.value.original === undefined ? {} : { original: prior.value.original, originalSha256: prior.value.originalSha256 }
        : plan.source === undefined ? {} : { original: plan.source, originalSha256: sha256(plan.source) }),
      installed: config.after,
    };
    const writes = plan.writes.filter(entry => entry.before !== entry.after);
    if (tokenBefore === undefined) writes.push({ file: tokenPath, target: await writableTarget(tokenPath), before: undefined, after: randomBytes(32).toString('hex'), mode: 0o600 });
    for (const [index, entry] of plan.writes.entries()) {
      if (entry.before === undefined) continue;
      const file = path.join(plan.preview.backupDirectory, `${index}.before`);
      writes.unshift({ file, target: await writableTarget(file), before: await readTextIfExists(file), after: entry.before, mode: 0o600 });
    }
    const file = await receiptPath(options);
    writes.push({ file, target: await writableTarget(file), before: prior?.text, after: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 });
    await commitConfigWrites(writes, undefined, journal, ` Review it with \`${recoverCommand}\`.`);
    return plan.preview;
  });
}

async function inspectUndo(options: CodexPermissionHookUndoOptions) {
  requireSessionId(options);
  if (![options.extaliaHome, options.codexHome].every(value => path.isAbsolute(value))) throw new ConnectError('Permission hook removal requires absolute data and Codex home paths. Nothing was written.');
    const receipt = await readReceipt(options);
    if (receipt && receipt.value.nativeSessionId !== options.nativeSessionId) throw new ConnectError('The installed permission hook targets a different native conversation. Select that conversation before removing it. Nothing was written.');
    const file = path.join(options.codexHome, 'config.toml');
    const target = await writableTarget(file);
    if (receipt && receipt.value.target !== target) throw new ConnectError('The Codex configuration link target changed. Nothing was written.');
    const before = await readTextIfExists(file);
    const range = blockRange(before ?? '');
    if (range && !receipt) throw new ConnectError('The permission hook setup receipt for this profile is missing. Use the original EXTALIA_HOME or restore its receipt before removing the selected conversation hook; otherwise review and remove the block by hand. Nothing was written.');
    let after: string | undefined = before;
    if (range && before !== undefined) {
      after = receipt && before === receipt.value.installed ? receipt.value.original : before.slice(0, range.start) + before.slice(range.end);
      parseCodexConfig(after ?? '', file);
    }
    return { receipt, file, target, before, after, result: { changed: before !== after, diff: unifiedDiff(before ?? '', after ?? '', { from: file, to: file, context: 0 }), revision: sha256(JSON.stringify([options.nativeSessionId, target, before, after, receipt?.text])) } };
}

/** Removal metadata needs neither a Node installation nor readable hook scripts/secrets. */
export async function previewCodexPermissionHookUndo(options: CodexPermissionHookUndoOptions): Promise<CodexPermissionHookSetupPreview> {
  const plan = await inspectUndo(options);
  return {
    ...plan.result, nativeSessionId: options.nativeSessionId, configPath: plan.file,
    forwarderPath: codexPermissionForwarderPath(options.extaliaHome), tokenPath: codexPermissionTokenFile(options.extaliaHome),
    createsPermissionToken: false, needsTrust: true, undoCommand: undoCommand(options),
    backupDirectory: path.join(directory(options), 'backups', 'codex-permission', plan.result.revision),
    files: !plan.result.changed ? [] : [{
      path: plan.file, ...(plan.before === undefined ? {} : { beforeSha256: sha256(plan.before) }),
      // A removed file has no postimage; the empty digest accompanies the explicit removed flag.
      afterSha256: sha256(plan.after ?? ''), ...(plan.after === undefined ? { removed: true as const } : {}),
    }],
  };
}

/** Removes the synchronous handler only; notification hooks and user changes survive. */
export async function undoCodexPermissionHookSetup(options: CodexPermissionHookUndoOptions, approvedRevision?: string): Promise<{ changed: boolean; diff: string; revision: string }> {
  if (approvedRevision === undefined) return (await inspectUndo(options)).result;
  return withConnectOperation(directory(options), { kind: 'disconnect', app: 'codex' }, { recoverCommand }, async journal => {
    const plan = await inspectUndo(options);
    if (!approvedRevision || plan.result.revision !== approvedRevision) throw new ConnectError('Permission hook removal changed after preview. Review and approve a new preview. Nothing was written.');
    if (plan.result.changed) {
      const backup = path.join(directory(options), 'backups', 'codex-permission', plan.result.revision, '0.before');
      const backupBefore = await readTextIfExists(backup);
      await journal.record(await writableTarget(backup), backupBefore, plan.before);
      await writeConfigFile(backup, plan.before!);
      await journal.record(plan.target, plan.before, plan.after);
      if (await writableTarget(plan.file) !== plan.target || await readTextIfExists(plan.target) !== plan.before) throw new ConnectError('The Codex configuration changed. Review removal again. Nothing was written.');
      if (plan.after === undefined) await rm(plan.target);
      else await writeConfigFile(plan.target, plan.after);
    }
    if (plan.receipt) {
      const file = await receiptPath(options);
      await journal.record(await writableTarget(file), plan.receipt.text, undefined);
      await rm(file);
    }
    await journal.complete();
    return plan.result;
  });
}
