import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  safeLabel, workspaceRuntime, type RuntimeId, type Workspace, type WorkspaceCrossAccess, type WorkspacePermissions,
} from '@extalia/core';
import {
  isProtectedBranchName, validateProjectFolderName,
  type PermissionMode, type ProjectGitInspection, type ProjectPlannedAction, type ProjectProvisionMode,
  type ProjectProvisionPreview, type ProjectProvisionPreviewInput, type ProjectProvisionWarning, type ProjectScaffoldTemplateId,
} from '@extalia/platform';
import { GIT_SAFETY_CONFIG, gitEnvironment, gitStatus, InspectError } from './inspect.js';
import { errorCode } from './jsonStore.js';
import { isCredentialPath, isWithin, WorkspacePathError } from './workspaceFs.js';

const REVIEW_TTL_MS = 10 * 60_000;
const MAX_REVIEWS = 64;
const GIT_INIT_TIMEOUT_MS = 10_000;
const GIT_INIT_MAX_BUFFER = 256 * 1024;

const POSIX_SYSTEM_ROOTS = [
  '/etc',
  '/private/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/System',
  '/Library',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
] as const;

const WINDOWS_SYSTEM_ROOT_PATTERN = /^[a-z]:\\(?:windows|program files|program files \(x86\))(?=$|\\)/i;

const VALID_SCAFFOLD_TEMPLATES: ReadonlySet<string> = new Set<ProjectScaffoldTemplateId>([
  'none',
  'basic-readme',
  'node-ts-minimal',
]);

/** Safe, user-facing project provisioning refusal or failure. */
export class ProjectProvisionError extends Error {
  override name = 'ProjectProvisionError';
}

export interface ProtectedProjectPathOptions {
  homeDirectory: string;
  dataDirectory: string;
  platform?: NodeJS.Platform;
}

export interface ScaffoldFile {
  relativePath: string;
  content: string;
}

export interface GitInitOptions {
  env?: Readonly<Record<string, string | undefined>>;
  binary?: string;
  timeoutMs?: number;
}

export interface InspectProjectTargetInput {
  mode: ProjectProvisionMode;
  parentPath?: string;
  folderName?: string;
  targetPath?: string;
  templateId?: ProjectScaffoldTemplateId;
  gitInit?: boolean;
  attachSessionId?: string;
  homeDirectory: string;
  dataDirectory: string;
  existingWorkspaces: readonly Workspace[];
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

export interface InspectedProjectTarget {
  mode: ProjectProvisionMode;
  targetPath: string;
  parentPath: string;
  defaultName: string;
  folderExists: boolean;
  templateId: ProjectScaffoldTemplateId;
  gitInit: boolean;
  gitInspection: ProjectGitInspection;
  existingWorkspace?: Workspace;
  warnings: ProjectProvisionWarning[];
  requiresWarningAcknowledgement: boolean;
}

export interface ProjectProvisionReviewSnapshot {
  mode: ProjectProvisionMode;
  targetPath: string;
  parentPath: string;
  folderExists: boolean;
  workspaceName: string;
  runtimeId: RuntimeId;
  connectionId?: string;
  runtimeProfileId?: string;
  runtimeModel?: string;
  permissions: WorkspacePermissions;
  crossWorkspaceAccess: WorkspaceCrossAccess;
  templateId: ProjectScaffoldTemplateId;
  gitInit: boolean;
  existingWorkspace?: Workspace;
  gitInspection: ProjectGitInspection;
  plannedActions: readonly ProjectPlannedAction[];
  warnings: readonly ProjectProvisionWarning[];
  requiresWarningAcknowledgement: boolean;
  workspacesBoundaryKey: string;
  attachSession?: {
    sessionId: string;
    title: string;
    transfersHistory: boolean;
    permissionMode: PermissionMode;
    record: unknown;
    messages: readonly unknown[];
    lastEventId?: string;
    boundary: string;
  };
}

function stripTrailingSeparators(value: string, platform: NodeJS.Platform = process.platform): string {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const normalized = platform === 'win32' ? pathImpl.normalize(value.replace(/\//g, '\\')) : pathImpl.normalize(value);
  const root = pathImpl.parse(normalized).root;
  let current = normalized;
  while (current.length > root.length && (current.endsWith('/') || current.endsWith('\\'))) {
    current = current.slice(0, -1);
  }
  return current;
}

function isSameOrWithinPlatform(parent: string, child: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const normParent = stripTrailingSeparators(parent, 'win32').toLowerCase();
    const normChild = stripTrailingSeparators(child, 'win32').toLowerCase();
    const rel = path.win32.relative(normParent, normChild);
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel));
  }
  if (platform === process.platform) {
    return isWithin(stripTrailingSeparators(parent, platform), stripTrailingSeparators(child, platform));
  }
  const rel = path.posix.relative(stripTrailingSeparators(parent, 'linux'), stripTrailingSeparators(child, 'linux'));
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel));
}

function isSamePathPlatform(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normA = stripTrailingSeparators(a, platform);
  const normB = stripTrailingSeparators(b, platform);
  return platform === 'win32' || platform === 'darwin'
    ? normA.toLowerCase() === normB.toLowerCase()
    : normA === normB;
}

function isOsSystemRoot(canonical: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const norm = stripTrailingSeparators(canonical, 'win32');
    return WINDOWS_SYSTEM_ROOT_PATTERN.test(norm);
  }
  const norm = stripTrailingSeparators(canonical, platform);
  const caseInsensitive = platform === 'darwin';
  const compareNorm = caseInsensitive ? norm.toLowerCase() : norm;
  return POSIX_SYSTEM_ROOTS.some(root => {
    const compareRoot = caseInsensitive ? root.toLowerCase() : root;
    return compareNorm === compareRoot || compareNorm.startsWith(`${compareRoot}/`);
  });
}

async function resolveCanonicalOptional(target: string, platform: NodeJS.Platform): Promise<string> {
  if (platform !== process.platform) {
    return stripTrailingSeparators(target, platform);
  }
  try {
    return stripTrailingSeparators(await realpath(target), platform);
  } catch {
    return stripTrailingSeparators(path.resolve(target), platform);
  }
}

async function checkProtectedPath(
  canonicalPath: string,
  options: ProtectedProjectPathOptions,
  allowExactHome: boolean,
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const normalized = stripTrailingSeparators(canonicalPath, platform);
  const parsed = pathImpl.parse(normalized);

  if (parsed.root === normalized) {
    return 'Choose a project folder, not the filesystem root.';
  }

  const realHome = await resolveCanonicalOptional(options.homeDirectory, platform);
  if (!allowExactHome && isSamePathPlatform(normalized, realHome, platform)) {
    return 'Choose a project subfolder instead of your entire home directory.';
  }

  const realData = await resolveCanonicalOptional(options.dataDirectory, platform);
  if (isSameOrWithinPlatform(realData, normalized, platform)) {
    return 'Cannot use Extalia’s data directory as a project folder.';
  }

  if (isCredentialPath(normalized)) {
    return 'Credential folders and files cannot be used as a project folder.';
  }

  if (isOsSystemRoot(normalized, platform)) {
    return 'System directories cannot be used as a project folder.';
  }

  return undefined;
}

/**
 * Check whether a canonical path is forbidden as a project root.
 * Returns a user-safe refusal message when protected, or `undefined` when permitted.
 */
export async function isProtectedProjectPath(
  canonicalPath: string,
  options: ProtectedProjectPathOptions,
): Promise<string | undefined> {
  return checkProtectedPath(canonicalPath, options, false);
}

function expandProjectPath(rawInput: unknown, homeDirectory: string, label: string): string {
  if (typeof rawInput !== 'string') throw new ProjectProvisionError(`Enter ${label}.`);
  const raw = rawInput.trim();
  if (!raw) throw new ProjectProvisionError(`Enter ${label}.`);
  if (raw.includes('\0')) throw new ProjectProvisionError('Folder paths cannot contain null bytes.');
  let expanded: string;
  if (raw === '~') expanded = homeDirectory;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) expanded = path.join(homeDirectory, raw.slice(2));
  else if (raw.startsWith('~')) throw new ProjectProvisionError('Only the current user’s home path may use ~.');
  else expanded = raw;
  if (!path.isAbsolute(expanded)) {
    throw new ProjectProvisionError('Use a full path, for example /Users/<name>/projects/site.');
  }
  return stripTrailingSeparators(expanded);
}

function sanitizeProjectTitle(projectName: string): string {
  const clean = projectName.replace(/[\p{Cc}\p{Cf}\r\n]+/gu, ' ').trim();
  return clean.slice(0, 120) || 'Project';
}

function toPackageSlug(projectName: string): string {
  const slug = sanitizeProjectTitle(projectName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'project';
}

/**
 * Curated, static-only scaffold file generation. Never runs package managers,
 * installers, or arbitrary scripts.
 */
export function buildScaffoldFiles(templateId: ProjectScaffoldTemplateId, projectName: string): ScaffoldFile[] {
  if (!VALID_SCAFFOLD_TEMPLATES.has(templateId)) {
    throw new ProjectProvisionError('Choose a valid project template.');
  }
  if (templateId === 'none') return [];

  const title = sanitizeProjectTitle(projectName);
  const gitignore = [
    'node_modules/',
    'dist/',
    '.env',
    '.env.*',
    '!.env.example',
    '.DS_Store',
    '',
  ].join('\n');

  if (templateId === 'basic-readme') {
    return [
      {
        relativePath: 'README.md',
        content: `# ${title}\n\nCreated with Extalia.\n`,
      },
      {
        relativePath: '.gitignore',
        content: gitignore,
      },
    ];
  }

  const pkg = {
    name: toPackageSlug(title),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      start: 'node src/index.ts',
    },
  };

  return [
    {
      relativePath: 'README.md',
      content: `# ${title}\n\nMinimal Node + TypeScript project scaffold created with Extalia.\n`,
    },
    {
      relativePath: '.gitignore',
      content: gitignore,
    },
    {
      relativePath: 'package.json',
      content: `${JSON.stringify(pkg, null, 2)}\n`,
    },
    {
      relativePath: 'src/index.ts',
      content: `export function main(): string {\n  return ${JSON.stringify(`Hello from ${title}`)};\n}\n`,
    },
  ];
}

/**
 * Initialize a Git repository without a shell, using Extalia's safety config
 * and minimal scrubbed Git environment.
 */
export function runSafeGitInit(cwd: string, options: GitInitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? GIT_INIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.binary ?? 'git',
      ['--no-pager', ...GIT_SAFETY_CONFIG, 'init'],
      {
        cwd,
        env: gitEnvironment(options.env),
        timeout: timeoutMs,
        maxBuffer: GIT_INIT_MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOENT') {
          reject(new ProjectProvisionError('Git is not installed or not on the PATH. Install Git to initialize a repository.'));
          return;
        }
        if (error.killed) {
          reject(new ProjectProvisionError(`Git init did not finish within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds and was stopped.`));
          return;
        }
        const firstLine = stderr.toString('utf8').split('\n').find(line => line.trim())
          ?.replace(/^(?:fatal|error): /, '').trim();
        reject(new ProjectProvisionError(firstLine ? `Git init failed: ${safeLabel(firstLine, 240)}` : 'Git init failed.'));
      },
    );
    child.stdin?.end();
  });
}

async function findWorkspaceByCanonicalPath(
  existingWorkspaces: readonly Workspace[],
  canonicalTarget: string,
  platform: NodeJS.Platform,
): Promise<Workspace | undefined> {
  for (const workspace of existingWorkspaces) {
    if (!workspace.projectLocation) continue;
    const candidate = await resolveCanonicalOptional(workspace.projectLocation, platform);
    if (isSamePathPlatform(candidate, canonicalTarget, platform)) return workspace;
  }
  return undefined;
}

/**
 * Read-only inspection of a project creation or open target before creating any
 * folders, files, Git repositories, or workspaces.
 */
export async function inspectProjectTarget(input: InspectProjectTargetInput): Promise<InspectedProjectTarget> {
  if (input.mode !== 'create' && input.mode !== 'open') {
    throw new ProjectProvisionError('Choose create or open mode.');
  }
  const templateId: ProjectScaffoldTemplateId = input.templateId ?? 'none';
  if (!VALID_SCAFFOLD_TEMPLATES.has(templateId)) {
    throw new ProjectProvisionError('Choose a valid project template.');
  }
  if (input.mode === 'open' && templateId !== 'none') {
    throw new ProjectProvisionError('Scaffold templates are only available when creating a new project.');
  }
  const gitInit = input.gitInit ?? false;
  if (typeof gitInit !== 'boolean') {
    throw new ProjectProvisionError('gitInit must be a boolean.');
  }

  const platform = input.platform ?? process.platform;
  const protectedOpts: ProtectedProjectPathOptions = {
    homeDirectory: input.homeDirectory,
    dataDirectory: input.dataDirectory,
    platform,
  };
  const warnings: ProjectProvisionWarning[] = [];

  if (input.mode === 'create') {
    const expandedParent = expandProjectPath(input.parentPath, input.homeDirectory, 'the parent folder');
    let parentInfo;
    try {
      parentInfo = await lstat(expandedParent);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') throw new ProjectProvisionError('The parent folder does not exist.');
      if (code === 'ENOTDIR') throw new ProjectProvisionError('The parent path is not a folder.');
      throw new ProjectProvisionError('The parent folder cannot be read.');
    }
    if (parentInfo.isSymbolicLink()) {
      throw new ProjectProvisionError('Symbolic links cannot be used as parent project folders. Choose the real folder path instead.');
    }
    if (!parentInfo.isDirectory()) {
      throw new ProjectProvisionError('The parent path is not a folder.');
    }

    let realParent: string;
    try {
      realParent = stripTrailingSeparators(await realpath(expandedParent), platform);
      if (!(await stat(realParent)).isDirectory()) {
        throw new ProjectProvisionError('The parent path is not a folder.');
      }
    } catch (error) {
      if (error instanceof ProjectProvisionError) throw error;
      throw new ProjectProvisionError('The parent folder does not exist or cannot be read.');
    }

    const parentProtectedError = await checkProtectedPath(realParent, protectedOpts, true);
    if (parentProtectedError) throw new ProjectProvisionError(parentProtectedError);

    const folderName = typeof input.folderName === 'string' ? input.folderName : '';
    const folderError = validateProjectFolderName(folderName);
    if (folderError) throw new ProjectProvisionError(folderError);

    let targetPath = path.join(realParent, folderName);
    if (path.dirname(targetPath) !== realParent) {
      throw new ProjectProvisionError('Choose a valid project folder name.');
    }

    const targetProtectedError = await isProtectedProjectPath(targetPath, protectedOpts);
    if (targetProtectedError) throw new ProjectProvisionError(targetProtectedError);

    let folderExists = false;
    try {
      const targetInfo = await lstat(targetPath);
      if (targetInfo.isSymbolicLink()) {
        throw new ProjectProvisionError('Symlinks cannot be used as project creation targets.');
      }
      if (!targetInfo.isDirectory()) {
        throw new ProjectProvisionError('A file already exists at that path. Choose a different folder name.');
      }
      const realTarget = stripTrailingSeparators(await realpath(targetPath), platform);
      const realProtectedError = await isProtectedProjectPath(realTarget, protectedOpts);
      if (realProtectedError) throw new ProjectProvisionError(realProtectedError);
      const entries = await readdir(realTarget);
      if (entries.length > 0) {
        throw new ProjectProvisionError('That folder already exists and is not empty. Use Open existing project instead.');
      }
      targetPath = realTarget;
      folderExists = true;
      warnings.push({
        code: 'existing-empty-directory',
        detail: 'The target folder already exists and is empty; Extalia will reuse it.',
      });
    } catch (error) {
      if (error instanceof ProjectProvisionError) throw error;
      if (errorCode(error) !== 'ENOENT') {
        throw new ProjectProvisionError('The target project path cannot be inspected.');
      }
    }

    const duplicate = await findWorkspaceByCanonicalPath(input.existingWorkspaces, targetPath, platform);
    if (duplicate) {
      throw new ProjectProvisionError(`A workspace already uses this folder: "${duplicate.name}". Use Open existing project instead.`);
    }

    const gitInspection: ProjectGitInspection = {
      isGitRepo: false,
      dirty: false,
      dirtyChangeCount: 0,
      protectedBranch: false,
    };

    return {
      mode: 'create',
      targetPath,
      parentPath: realParent,
      defaultName: folderName,
      folderExists,
      templateId,
      gitInit,
      gitInspection,
      warnings,
      requiresWarningAcknowledgement: false,
    };
  }

  // mode === 'open'
  const expandedTarget = expandProjectPath(input.targetPath, input.homeDirectory, 'the project folder');
  let targetInfo;
  try {
    targetInfo = await lstat(expandedTarget);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new ProjectProvisionError('That project folder does not exist.');
    if (code === 'ENOTDIR') throw new ProjectProvisionError('That path is not a folder.');
    throw new ProjectProvisionError('That project folder cannot be read.');
  }
  if (targetInfo.isSymbolicLink()) {
    throw new ProjectProvisionError('Symbolic links cannot be attached as project roots. Choose the real folder path instead.');
  }
  if (!targetInfo.isDirectory()) {
    throw new ProjectProvisionError('That path is not a folder.');
  }

  let realTarget: string;
  try {
    realTarget = stripTrailingSeparators(await realpath(expandedTarget), platform);
    if (!(await stat(realTarget)).isDirectory()) {
      throw new ProjectProvisionError('That path is not a folder.');
    }
  } catch (error) {
    if (error instanceof ProjectProvisionError) throw error;
    throw new ProjectProvisionError('That project folder does not exist or cannot be read.');
  }

  const protectedError = await isProtectedProjectPath(realTarget, protectedOpts);
  if (protectedError) throw new ProjectProvisionError(protectedError);

  let gitInspection: ProjectGitInspection = {
    isGitRepo: false,
    dirty: false,
    dirtyChangeCount: 0,
    protectedBranch: false,
  };
  try {
    const status = await gitStatus(realTarget, { env: input.env });
    if (status.repository) {
      if (gitInit) {
        throw new ProjectProvisionError('This folder is already a Git repository.');
      }
      const dirtyChangeCount = status.changes.length;
      const dirty = dirtyChangeCount > 0;
      const protectedBranch = isProtectedBranchName(status.branch);
      gitInspection = {
        isGitRepo: true,
        ...(status.branch ? { branch: status.branch } : {}),
        dirty,
        dirtyChangeCount,
        protectedBranch,
        ...(status.truncated ? { truncated: true } : {}),
      };
      if (dirty) {
        warnings.push({
          code: 'dirty-repository',
          detail: `${dirtyChangeCount} uncommitted change${dirtyChangeCount === 1 ? '' : 's'} detected${status.truncated ? ' (truncated)' : ''}. Existing changes will be preserved.`,
        });
      }
      if (protectedBranch) {
        warnings.push({
          code: 'protected-branch',
          detail: `Repository is currently on protected branch "${status.branch}".`,
        });
      }
    }
  } catch (error) {
    if (error instanceof ProjectProvisionError) throw error;
    if (error instanceof InspectError && /not installed or not on the PATH/i.test(error.message)) {
      gitInspection = { isGitRepo: false, dirty: false, dirtyChangeCount: 0, protectedBranch: false };
      if (gitInit) {
        warnings.push({
          code: 'git-unavailable',
          detail: 'Git is not installed or not on the PATH.',
        });
      }
    } else if (error instanceof InspectError || error instanceof WorkspacePathError) {
      throw new ProjectProvisionError(error.message);
    } else {
      throw error;
    }
  }

  const existingWorkspace = await findWorkspaceByCanonicalPath(input.existingWorkspaces, realTarget, platform);
  if (existingWorkspace) {
    if (!input.attachSessionId) {
      throw new ProjectProvisionError(`A workspace already uses this folder: "${existingWorkspace.name}".`);
    }
    if (existingWorkspace.mode === 'observe' || workspaceRuntime(existingWorkspace) !== 'extalia-native') {
      throw new ProjectProvisionError(
        `Cannot attach an Extalia Native session to "${existingWorkspace.name}" because it is not a managed Extalia Native workspace.`,
      );
    }
    warnings.push({
      code: 'already-registered-workspace',
      detail: `Reusing existing workspace "${existingWorkspace.name}".`,
    });
  }

  const requiresWarningAcknowledgement = warnings.some(
    warning => warning.code === 'dirty-repository' || warning.code === 'protected-branch',
  );

  return {
    mode: 'open',
    targetPath: realTarget,
    parentPath: path.dirname(realTarget),
    defaultName: existingWorkspace?.name ?? path.basename(realTarget),
    folderExists: true,
    templateId: 'none',
    gitInit,
    gitInspection,
    ...(existingWorkspace ? { existingWorkspace } : {}),
    warnings,
    requiresWarningAcknowledgement,
  };
}

function fingerprint(snapshot: ProjectProvisionReviewSnapshot): string {
  return createHash('sha256').update(JSON.stringify([
    snapshot.mode,
    snapshot.targetPath,
    snapshot.parentPath,
    snapshot.folderExists,
    snapshot.workspaceName,
    snapshot.runtimeId,
    snapshot.connectionId ?? null,
    snapshot.runtimeProfileId ?? null,
    snapshot.runtimeModel ?? null,
    snapshot.permissions,
    snapshot.crossWorkspaceAccess,
    snapshot.templateId,
    snapshot.gitInit,
    snapshot.existingWorkspace ?? null,
    snapshot.gitInspection,
    snapshot.plannedActions,
    snapshot.warnings,
    snapshot.requiresWarningAcknowledgement,
    snapshot.workspacesBoundaryKey,
    snapshot.attachSession
      ? [
        snapshot.attachSession.sessionId,
        snapshot.attachSession.record,
        snapshot.attachSession.messages,
        snapshot.attachSession.lastEventId ?? null,
        snapshot.attachSession.permissionMode,
        snapshot.attachSession.boundary,
      ]
      : null,
  ])).digest('hex');
}

interface StoredReview {
  digest: string;
  expires: number;
  input: ProjectProvisionPreviewInput;
  requiresWarningAcknowledgement: boolean;
}

/**
 * Bounded, ephemeral single-use review tokens binding a reviewed project
 * provisioning preview to the exact filesystem, Git, workspace, and session
 * state verified before execution.
 */
export class ProjectProvisionReviews {
  private readonly reviews = new Map<string, StoredReview>();

  preview(input: ProjectProvisionPreviewInput, snapshot: ProjectProvisionReviewSnapshot): ProjectProvisionPreview {
    const now = Date.now();
    for (const [id, entry] of this.reviews) {
      if (entry.expires <= now) this.reviews.delete(id);
    }
    while (this.reviews.size >= MAX_REVIEWS) {
      this.reviews.delete(this.reviews.keys().next().value!);
    }
    const reviewId = randomUUID();
    const expires = now + REVIEW_TTL_MS;
    this.reviews.set(reviewId, {
      digest: fingerprint(snapshot),
      expires,
      input: structuredClone(input),
      requiresWarningAcknowledgement: snapshot.requiresWarningAcknowledgement,
    });
    return {
      reviewId,
      expiresAt: new Date(expires).toISOString(),
      mode: snapshot.mode,
      targetPath: snapshot.targetPath,
      parentPath: snapshot.parentPath,
      workspaceName: snapshot.workspaceName,
      runtimeId: snapshot.runtimeId,
      ...(snapshot.connectionId ? { connectionId: snapshot.connectionId } : {}),
      permissions: { ...snapshot.permissions },
      crossWorkspaceAccess: snapshot.crossWorkspaceAccess,
      templateId: snapshot.templateId,
      gitInit: snapshot.gitInit,
      ...(snapshot.existingWorkspace ? { existingWorkspaceId: snapshot.existingWorkspace.id } : {}),
      gitInspection: { ...snapshot.gitInspection },
      plannedActions: snapshot.plannedActions.map(action => ({ ...action })),
      warnings: snapshot.warnings.map(warning => ({ ...warning })),
      requiresWarningAcknowledgement: snapshot.requiresWarningAcknowledgement,
      ...(snapshot.attachSession
        ? {
          attachSession: {
            sessionId: snapshot.attachSession.sessionId,
            title: snapshot.attachSession.title,
            transfersHistory: snapshot.attachSession.transfersHistory,
            permissionMode: snapshot.attachSession.permissionMode,
          },
        }
        : {}),
    };
  }

  get(reviewId: unknown): { input: ProjectProvisionPreviewInput; requiresWarningAcknowledgement: boolean } {
    const entry = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!entry) {
      throw new ProjectProvisionError('The project review expired or is invalid. Review the project details again.');
    }
    if (entry.expires <= Date.now()) {
      this.reviews.delete(reviewId as string);
      throw new ProjectProvisionError('The project review expired or is invalid. Review the project details again.');
    }
    return {
      input: structuredClone(entry.input),
      requiresWarningAcknowledgement: entry.requiresWarningAcknowledgement,
    };
  }

  verify(reviewId: unknown, snapshot: ProjectProvisionReviewSnapshot): void {
    const entry = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!entry || entry.expires <= Date.now() || entry.digest !== fingerprint(snapshot)) {
      if (entry && entry.expires <= Date.now()) this.reviews.delete(reviewId as string);
      throw new ProjectProvisionError('Project folder, repository, or session state changed since review, or the review expired. Review the project details again.');
    }
  }

  consume(reviewId: string): void {
    this.reviews.delete(reviewId);
  }
}
