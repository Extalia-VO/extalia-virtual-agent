/**
 * The `decide()` parity matrix (audit PR 7, ADR 0026): every input combination the
 * `permission.check` wire contract accepts, with the decision `decide()` returns. The
 * committed copy in `fixtures/permission/decide-matrix.json` is the oracle for the Rust
 * port (`extalia_core::security::permissions`), which `cargo test` runs in full.
 *
 * Regenerate with `node tooling/generate-permission-matrix.mjs`; `permissionMatrix.test.ts`
 * fails when the committed matrix differs from live `decide()` output.
 *
 * The lists are spelled out here (not imported from `@extalia/core`) so the generator can
 * load this file with Node's type stripping; the compile-time checks keep them exhaustive.
 */
import type { PermissionMode, SessionPermissionMode } from '@extalia/core';
import { decide, type PolicyDecision } from '../src/policy.js';
import type { ToolAccess } from '../src/tools.js';

export const MATRIX_TOOL_ACCESS = ['read', 'write', 'execute', 'memory', 'meta'] as const satisfies readonly ToolAccess[];
export const MATRIX_MODES = ['workspace', 'ask', 'accept-edits', 'plan'] as const satisfies readonly SessionPermissionMode[];
export const MATRIX_POLICIES = ['ask', 'allow'] as const satisfies readonly PermissionMode[];
// Compile-time checks that every access level, session mode and workspace policy is listed.
const _everyAccess: readonly (typeof MATRIX_TOOL_ACCESS)[number][] = [] as ToolAccess[];
const _everyMode: readonly (typeof MATRIX_MODES)[number][] = [] as SessionPermissionMode[];
const _everyPolicy: readonly (typeof MATRIX_POLICIES)[number][] = [] as PermissionMode[];

export const MATRIX_COLUMNS = ['mode', 'access', 'fileWrite', 'commands', 'sessionGrants', 'decision'] as const;
export type MatrixCase = [SessionPermissionMode, ToolAccess, PermissionMode, PermissionMode, ToolAccess[], PolicyDecision];

export interface DecideMatrix {
  contract: 'permission.check';
  source: string;
  regenerate: string;
  columns: typeof MATRIX_COLUMNS;
  cases: MatrixCase[];
}

/** Every subset of the access levels, in list order: the unique `sessionGrants` the wire accepts. */
function grantSets(): ToolAccess[][] {
  return Array.from({ length: 1 << MATRIX_TOOL_ACCESS.length }, (_, mask) => MATRIX_TOOL_ACCESS.filter((_, bit) => mask & (1 << bit)));
}

export function buildDecideMatrix(): DecideMatrix {
  const cases: MatrixCase[] = [];
  for (const mode of MATRIX_MODES) for (const access of MATRIX_TOOL_ACCESS) {
    for (const fileWrite of MATRIX_POLICIES) for (const commands of MATRIX_POLICIES) {
      for (const grants of grantSets()) {
        cases.push([mode, access, fileWrite, commands, grants, decide(access, { fileWrite, commands }, new Set(grants), mode)]);
      }
    }
  }
  return {
    contract: 'permission.check',
    source: 'decide() in packages/runtime/src/policy.ts',
    regenerate: 'node tooling/generate-permission-matrix.mjs',
    columns: MATRIX_COLUMNS,
    cases,
  };
}

/** The committed file: header fields indented, one case per line. */
export function serializeDecideMatrix(matrix: DecideMatrix): string {
  const { cases, ...header } = matrix;
  const head = JSON.stringify(header, null, 2).slice(0, -2);
  return `${head},\n  "cases": [\n${cases.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}
