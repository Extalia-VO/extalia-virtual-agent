import { SESSION_PERMISSION_MODES, type SessionPermissionMode, type WorkspacePermissions } from '@extalia/core';
import {
  DAEMON_PERMISSION_MODES, DAEMON_SCHEMA_VERSION, DAEMON_TOOL_ACCESS, parseDaemonFrame,
  type DaemonOperations, type DaemonPermissionMode, type DaemonToolAccess, type DaemonWorkspacePermissions,
} from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import type { PolicyDecision } from '../src/policy.js';
import type { ToolAccess } from '../src/tools.js';
import committed from './fixtures/permission/decide-matrix.json' with { type: 'json' };
import { buildDecideMatrix, MATRIX_MODES, MATRIX_TOOL_ACCESS, type DecideMatrix } from './permissionMatrix.js';

// Compile-time: @extalia/protocol duplicates the permission enums because it cannot import
// the runtime (tooling/check-boundaries.mjs); `pnpm typecheck` fails when they diverge.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const _wireMatchesRuntime: [
  Equal<DaemonToolAccess, ToolAccess>,
  Equal<DaemonPermissionMode, SessionPermissionMode>,
  Equal<DaemonWorkspacePermissions, WorkspacePermissions>,
  Equal<DaemonOperations['permission.check']['result']['decision'], PolicyDecision>,
] = [true, true, true, true];

const matrix = committed as unknown as DecideMatrix;
const requestId = '00000000-0000-4000-8000-000000000100';

describe('decide() parity matrix', () => {
  it('equals live decide() output (regenerate with node tooling/generate-permission-matrix.mjs)', () => {
    expect(matrix).toEqual(buildDecideMatrix());
  });

  it('covers mode x access x workspace policy x every unique grant set', () => {
    expect(matrix.cases).toHaveLength(MATRIX_MODES.length * MATRIX_TOOL_ACCESS.length * 2 * 2 * 2 ** MATRIX_TOOL_ACCESS.length);
    expect(new Set(matrix.cases.map(row => JSON.stringify(row.slice(0, 5)))).size).toBe(matrix.cases.length);
  });

  it('lists the same values as the wire contract, in the same order', () => {
    expect([...DAEMON_TOOL_ACCESS]).toEqual([...MATRIX_TOOL_ACCESS]);
    expect([...DAEMON_PERMISSION_MODES]).toEqual([...MATRIX_MODES]);
    expect([...SESSION_PERMISSION_MODES]).toEqual([...MATRIX_MODES]);
  });

  it('is expressible as permission.check requests and responses', () => {
    for (const [mode, access, fileWrite, commands, sessionGrants, decision] of matrix.cases) {
      const base = { schemaVersion: DAEMON_SCHEMA_VERSION, requestId, op: 'permission.check' } as const;
      const request = parseDaemonFrame({ ...base, kind: 'request', params: { access, mode, workspacePermissions: { fileWrite, commands }, sessionGrants } });
      const response = parseDaemonFrame({ ...base, kind: 'response', result: { decision } });
      expect(request.ok && response.ok, JSON.stringify([mode, access, fileWrite, commands, sessionGrants])).toBe(true);
    }
  });
});
