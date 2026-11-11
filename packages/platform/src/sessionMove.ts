import type { WorkspaceCrossAccess, WorkspacePermissions } from '@extalia/core';
import type { PermissionMode } from './agentHost.js';

export interface SessionMoveWorkspace {
  id: string;
  name: string;
  folders: string[];
  crossWorkspaceAccess: WorkspaceCrossAccess;
  permissions: WorkspacePermissions;
}

/** Host-issued review of an existing Native conversation's destination and grants. */
export interface SessionMovePreview {
  sessionId: string;
  reviewId: string;
  expiresAt: string;
  source: SessionMoveWorkspace;
  destination: SessionMoveWorkspace;
  accessibleFolders: { workspaceId: string; path: string; access: 'read-only' | 'read-write' }[];
  transfersHistory: boolean;
  /** Retained session override takes precedence over destination workspace defaults. */
  permissionMode: PermissionMode;
}

export interface SessionMoveRequest {
  workspaceId: string;
  reviewId: string;
}

/** Native events through this ID keep the project root they originally referenced. */
export interface SessionWorkspaceFileScope {
  throughEventId: string;
  workspaceId: string;
  projectLocation: string;
}
