# ADR 0100: Per-OS command sandbox executor, exact-action approvals, and gate settlement evidence

Status: Implemented — 2026-11-24 (Slice C, WP-06 & WP-08, Issue #150)

Resolves: `COD-005`, `COD-006`, `COD-008`, `AC-25`, `AC-27`, `AC-30`, `V2-05`, `V2-06` in [PRD-SF-1.0](../product/prd-session-first-coding-discord.md).

## Context

Extalia previously enforced a strict fail-closed command boundary (`WORKSPACE_COMMAND_UNAVAILABLE`) for both `run_command` and worktree integration gates (`requireWorkspaceBoundary: true`) because an unsandboxed shell command can write outside the selected project workspace, read sensitive user credentials or Extalia's own data directory, or exfiltrate workspace state over the network.

Enabling real local command and integration-gate execution safely requires solving three coupled problems:

1. **OS-enforced containment without silent fallback:** Command isolation must be enforced by the host operating system (`sandbox-exec` Seatbelt on macOS, `bwrap` bubblewrap namespaces on Linux) and **empirically verified** before advertising availability. If the sandbox binary is missing, disabled, or fails containment checks (or on unsupported platforms such as Windows), the host must remain fail-closed (`supported: false`) with zero unsandboxed fallback.
2. **Exact-action approval binding & effect-time verification (`AC-27`):** Approving a tool call by bare `approvalId` alone does not guard against workspace configuration changes, session cancellations, revocations, TTL expiry, replay of single-use (`once`) grants, or argument/target drift between prompt-time approval and effect-time execution.
3. **Honest command and integration-gate settlement (`COD-008`, `AC-30`):** A command that times out, is cancelled, cannot be reaped, or never started must never be reported as a verified pass or produce a `ready` integration proposal.

## Decision

### 1. Verified per-OS command sandbox (`packages/host/src/tools/commandSandbox.ts`)

Introduce `CommandSandboxExecutor` and `probeCommandSandbox(...)`, backed by `CommandSandboxStatus` in `@extalia/platform`:

- **macOS (`macos-seatbelt`):** `buildSeatbeltProfile(...)` generates a Seatbelt `(version 1)` profile with:
  - `(allow default)` followed by `(deny file-write*)`
  - `(allow file-write* (subpath "<canonicalWorkspaceRoot>") (subpath "<canonicalTempDir>") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`
  - Explicit `(deny file-read* ...)` on Extalia's `dataDirectory` (when outside the workspace) and sensitive home entries (`<home>/.ssh`, `<home>/.aws`, `<home>/.gnupg`, `<home>/.kube`, `<home>/.npmrc`, `<home>/.netrc`, `<home>/.pypirc`, `<home>/.git-credentials`)
  - `(deny network-outbound)` and `(deny network-inbound)`
  - Safe Seatbelt string escaping for backslashes and double quotes, with `realpath` normalization so macOS `/var/folders` vs `/private/var/folders` and `/tmp` vs `/private/tmp` paths match kernel checks cleanly.
- **Linux (`linux-bwrap`):** `buildBwrapArgs(...)` builds `bwrap` arguments with `--unshare-pid`, `--unshare-uts`, `--unshare-ipc`, `--unshare-net`, `--die-with-parent`, `--new-session`, read-only system mounts (`--ro-bind /usr /usr`, `--ro-bind-try` for `/bin`, `/lib`, `/lib64`, `/etc`), `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, read-write `--bind` for only the canonical workspace root and per-command temp directory, and `--chdir` into the workspace root.
- **Fail-closed startup probe (`probeCommandSandbox`):**
  - On `win32` or other unsupported platforms, immediately returns `{ supported: false, kind: 'none', platform, networkAccess: 'denied', reason }`.
  - On `darwin` and `linux`, creates an isolated `mkdtemp` directory containing `workspace/`, `outside/`, and `tmp/` and runs **two real probes**:
    1. Writing `workspace/probe-ok.txt` must exit `0` and create the file.
    2. Attempting to write `outside/probe-escape.txt` must exit non-zero **and** `outside/probe-escape.txt` must not exist.
  - Only when both probes pass does `probeCommandSandbox` return `supported: true` with `verifiedAt` and a `spawn(...)` implementation that launches a detached process group (`detached: true`), allocates a per-command temp directory (`TMPDIR` pointed inside it), and returns a `cleanup()` callback. Any probe failure returns `supported: false` with the exact diagnostic reason.

### 2. Command tool sandbox integration & settlement states (`packages/host/src/tools/command.ts`)

- Extend `CommandToolOptions` with optional `sandbox`, `dataDirectory`, and `homeDirectory`.
- When `filesystemBoundary === 'required'` and `!options.sandbox?.status.supported`, preserve the exact existing fail-closed behavior (`WORKSPACE_COMMAND_UNAVAILABLE`, zero spawns).
- When `filesystemBoundary === 'required'` and `options.sandbox?.status.supported === true`, execute via `options.sandbox.spawn(...)` with scrubbed `commandEnvironment`, process-group termination, bounded redacted output streaming, and `cleanup()` in `finally`.
- Track `reapTimedOut` when the fallback force-finish timer fires and emit explicit `settlement` on `ToolOutcome`:
  - `'unknown'` when reaping timed out
  - `'timed_out'` when stopped by timeout
  - `'cancelled'` when aborted
  - `'passed'` when `exitCode === 0`
  - `'failed'` otherwise

### 3. Exact-action approval ledger & effect-time verification (`packages/host/src/approvalLedger.ts`, `packages/host/src/service.ts`)

- `computeActionDigest(...)` computes a `sha256:` digest over canonical JSON of `{ sessionId, workspaceId, toolName, access, target, argumentsJson, generation }`.
- `ExactApprovalLedger` manages up to 512 approval entries (evicting oldest settled entries first) with configurable `ttlMs` (default 5 minutes) and injectable clock (`now`):
  - `issue(...)` records a pending approval bound to its `actionDigest` and workspace `generation`.
  - `resolve(approvalId, decision)` refuses missing, already settled, revoked, or expired approvals.
  - `revoke(approvalId, reason?)` and `revokeSession(sessionId, reason?)` / `revokeAll(reason?)` invalidate pending and granted approvals.
  - `verifyForEffect(approvalId, expected)` verifies granted state, expiry, non-revocation, and exact match of `sessionId`, `workspaceId`, `actionDigest`, and `generation`, consuming `'once'` grants atomically on success.
- `createAgentHost` accepts optional `commandSandbox?: CommandSandboxExecutor` (default `undefined` so existing fail-closed behavior is preserved unless explicitly verified), exposes `revokeApproval(sessionId, approvalId)` and `commandSandboxStatus()` on `AgentHostApi`, wires `ExactApprovalLedger` into `askUser`, `resolveApproval`, `cancel`, `withWorkspaceChange`, and `runTurn`'s `verifyApprovalEffect` hook.

### 4. Integration gate settlement & executor evidence (`packages/host/src/worktrees/integration.ts`)

- Extend `GateResult` with optional `outcome?: IntegrationGateOutcome` and `executor?: IntegrationGateExecutorInfo`, keeping `validProposal` backward-compatible with legacy registry records.
- Pass `options.sandbox` into `createCommandTool` in `runGate` only when `options.sandbox?.status.supported === true`.
- Set `ok = commandStarted && exitCode === 0 && outcome === 'passed'` so `not_run`, `timed_out`, `cancelled`, `unknown`, and `failed` outcomes can never transition a proposal to `ready`.

## Consequences

- **Positive:** macOS and Linux hosts with a verified OS sandbox can run `run_command` and worktree integration gates with kernel-enforced filesystem containment and network denial, while unsupported or misconfigured hosts stay fail-closed without silent fallback. Exact-action approvals close TOCTOU, replay, stale-workspace, and revocation gaps at effect time.
- **Trade-offs:** Running the two-step sandbox probe adds a small startup cost when explicitly invoked by a host launcher, and Seatbelt/bwrap deny network access inside sandboxed commands by default (commands requiring network access remain outside the local sandbox boundary).

## Verification

Verified in `packages/host/test/commandSandbox.test.ts`, `packages/host/test/approvalLedger.test.ts`, and existing host boundary/worktree/service test suites:

- Seatbelt profile and bwrap argument generation (including path escaping, sensitive home/data read denials, and network denial).
- Live OS sandbox probe on macOS (`sandbox-exec`) verifying allowed workspace writes, blocked out-of-workspace writes, blocked sensitive/data reads, and blocked network access, plus fail-closed probe behavior for `win32`, missing binaries, and broken containment.
- Sandboxed `run_command` execution, `settlement` classification (`passed`, `failed`, `timed_out`, `cancelled`, `unknown`), and `IntegrationQueue` gate `outcome` + `executor` persistence and legacy compatibility.
- `ExactApprovalLedger` digest stability, single-use consumption, TTL expiry, revocation on user revoke/cancel/workspace change, generation mismatch refusal, capacity eviction, and end-to-end host `commandSandboxStatus` / `revokeApproval` / `verifyApprovalEffect` behavior.

## Addendum (2026-11-27): WP-07 Worker Process Leases & Execution Safety Inspection UI

To close the remaining local deliverables for Slice C (`WP-06`–`WP-08`, `AC-12`, `AC-27`, `AC-30`):

- **Browser-safe contracts (`packages/platform/src/executionSafety.ts`):** Added `ExactApprovalView` (intentionally omitting `argumentsJson`), `WorkerLeaseView`, `WorkerLeaseStatus`, `WorkerLeaseSettlement`, `WorkerLeaseReconcileAction`, validators (`normalizeApprovalSessionFilter`, `normalizeWorkerLeaseId`, `normalizeWorkerLeaseReconcileAction`), and optional host RPCs (`listApprovals`, `listWorkerLeases`, `reconcileWorkerLease`) registered in `AGENT_HOST_METHODS`.
- **Durable worker lease fencing (`packages/host/src/workerLease.ts`, `packages/host/src/service.ts`):** Added `WorkerLeaseRegistry` (`state/worker-leases.json`, `0o600`, monotonic `fencingToken`, bounded 256-entry retention preserving unresolved leases). On startup (`open`) or expiry, active leases from prior host instances or expired leases transition to `status: 'quarantined'` with `settlement: 'unknown'` and are never blindly `process.kill`ed (avoiding recycled-PID hazards) or replayed until explicitly acknowledged (`reconcileWorkerLease(leaseId, 'acknowledge')`). `startNativeMission` acquires a fenced lease per write-capable worker worktree, verifies fencing before releasing worktrees, and quarantines uncertain settlements. `createCommandTool` exposes `onChildSpawned` (`pid` / `processGroupId`).
- **Execution Safety UI (`apps/web/src/approvals/ExecutionSafetyPanel.tsx`, `executionSafety.css`):** Surfaced Command Sandbox Posture (`Verified` vs `Fail-closed`, OS sandbox kind, network isolation, fail-closed reason), Exact-Action Approval inspection/revocation (`listApprovals` + `revokeApproval` with SHA-256 digest & generation visibility), and Worker Process Lease quarantine acknowledgement inside `SettingsPage` and `ChatSessionInfo` (EN/ID localized in `apps/web/src/i18n.ts`, `mockHost.ts` included).

Verified in `packages/platform/test/executionSafety.test.ts`, `packages/host/test/workerLease.test.ts`, `packages/host/test/approvalLedger.test.ts`, and `apps/web/test/executionSafetyUi.test.ts`. Linux `bwrap` live runner certification and external real-provider OS acceptance remain open hardware/environment gates.
