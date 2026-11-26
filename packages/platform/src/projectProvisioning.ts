import type { RuntimeId, Workspace, WorkspaceCrossAccess, WorkspacePermissions } from '@extalia/core';
import type { HostState, PermissionMode } from './agentHost.js';

export type ProjectProvisionMode = 'create' | 'open';

export type ProjectScaffoldTemplateId = 'none' | 'basic-readme' | 'node-ts-minimal';

export interface ProjectScaffoldTemplateInfo {
  readonly id: ProjectScaffoldTemplateId;
  readonly files: readonly string[];
  readonly executesCommands: false;
}

/** Curated static templates only: creating files never runs package managers or arbitrary scripts. */
export const PROJECT_SCAFFOLD_TEMPLATES: readonly ProjectScaffoldTemplateInfo[] = [
  { id: 'none', files: [], executesCommands: false },
  { id: 'basic-readme', files: ['README.md', '.gitignore'], executesCommands: false },
  { id: 'node-ts-minimal', files: ['README.md', '.gitignore', 'package.json', 'src/index.ts'], executesCommands: false },
] as const;

export type ProjectProvisionWarningCode =
  | 'dirty-repository'
  | 'protected-branch'
  | 'already-registered-workspace'
  | 'existing-empty-directory'
  | 'git-unavailable';

export interface ProjectProvisionWarning {
  code: ProjectProvisionWarningCode;
  detail?: string;
}

export interface ProjectGitInspection {
  isGitRepo: boolean;
  branch?: string;
  dirty: boolean;
  dirtyChangeCount: number;
  protectedBranch: boolean;
  truncated?: boolean;
}

export type ProjectPlannedActionKind =
  | 'create-folder'
  | 'write-file'
  | 'git-init'
  | 'register-workspace'
  | 'attach-session';

export interface ProjectPlannedAction {
  kind: ProjectPlannedActionKind;
  target: string;
  detail?: string;
}

export interface ProjectProvisionPreviewInput {
  mode: ProjectProvisionMode;
  parentPath?: string;
  folderName?: string;
  targetPath?: string;
  workspaceName?: string;
  runtimeId?: RuntimeId;
  connectionId?: string;
  runtimeProfileId?: string;
  runtimeModel?: string;
  permissions?: WorkspacePermissions;
  crossWorkspaceAccess?: WorkspaceCrossAccess;
  templateId?: ProjectScaffoldTemplateId;
  gitInit?: boolean;
  attachSessionId?: string;
}

export interface ProjectProvisionPreview {
  reviewId: string;
  expiresAt: string;
  mode: ProjectProvisionMode;
  targetPath: string;
  parentPath: string;
  workspaceName: string;
  runtimeId: RuntimeId;
  connectionId?: string;
  permissions: WorkspacePermissions;
  crossWorkspaceAccess: WorkspaceCrossAccess;
  templateId: ProjectScaffoldTemplateId;
  gitInit: boolean;
  existingWorkspaceId?: string;
  gitInspection: ProjectGitInspection;
  plannedActions: ProjectPlannedAction[];
  warnings: ProjectProvisionWarning[];
  requiresWarningAcknowledgement: boolean;
  attachSession?: {
    sessionId: string;
    title: string;
    transfersHistory: boolean;
    permissionMode: PermissionMode;
  };
}

export interface ProjectProvisionApplyInput {
  reviewId: string;
  acknowledgeWarnings?: boolean;
}

export interface ProjectProvisionStepReceipt {
  step: ProjectPlannedActionKind;
  status: 'completed' | 'skipped' | 'failed';
  target?: string;
  detail?: string;
}

export interface ProjectProvisionReceipt {
  ok: boolean;
  partial: boolean;
  mode: ProjectProvisionMode;
  targetPath: string;
  workspace?: Workspace;
  attachedSessionId?: string;
  steps: ProjectProvisionStepReceipt[];
  error?: string;
  state?: HostState;
}

export const PROJECT_PROVISIONING_METHODS = ['previewProjectProvision', 'applyProjectProvision'] as const;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validate a single directory name for project creation without touching disk. */
export function validateProjectFolderName(name: string): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return 'Enter a project folder name.';
  if (name.length > 120) return 'Project folder names must be 120 characters or fewer.';
  if (hasControlCharacter(name) || name.includes('/') || name.includes('\\')) {
    return 'Folder names cannot contain path separators or control characters.';
  }
  if (name === '.' || name === '..') return 'Choose a valid project folder name.';
  if (name !== name.trim() || name.startsWith('.') || name.endsWith('.')) {
    return 'Folder names cannot start or end with spaces or dots.';
  }
  if (WINDOWS_RESERVED_NAME.test(name)) return 'That folder name is reserved by the operating system.';
  return undefined;
}

const PROTECTED_EXACT_BRANCHES = new Set(['main', 'master', 'production', 'prod']);

/** Identify default/release branches that merit explicit acknowledgement before attaching a coding workspace. */
export function isProtectedBranchName(branch: string | undefined): boolean {
  if (typeof branch !== 'string') return false;
  const normalized = branch.trim().toLowerCase();
  if (!normalized || normalized === 'head' || normalized === '(detached)' || normalized === 'detached') return false;
  return PROTECTED_EXACT_BRANCHES.has(normalized)
    || normalized.startsWith('release/')
    || normalized.startsWith('hotfix/');
}
