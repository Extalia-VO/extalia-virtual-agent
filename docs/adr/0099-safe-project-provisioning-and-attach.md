# ADR 0099: Safe project provisioning and atomic session attach

Status: Implemented — 2026-11-24 (Slice B, WP-05, Issue #149)

Resolves: `COD-001`, `COD-002`, `COD-010`, `UJ-02` (steps 2–6), `AC-04..06`, `AC-26..28` in [PRD-SF-1.0](../product/prd-session-first-coding-discord.md).

## Context

[ADR 0095](0095-unassigned-session-context.md) and [ADR 0096](0096-session-first-chat-landing.md) allow users to start Extalia Native conversations with `workspaceId: null` under strict zero-grant isolation before any project folder is registered. However, turning an unassigned conversation (or a fresh coding intent) into a real local project still requires switching away to Settings, manually creating a folder outside Extalia, registering a workspace with `saveWorkspace`, and then separately invoking the reviewed session move flow.

Creating or opening a local project directory from Chat introduces concrete security and durability hazards:

1. **Protected & credential root exposure:** Accepting arbitrary folder paths risks mounting filesystem roots (`/`), the user's entire home directory (`/Users/<name>`), Extalia's own data directory (`~/.extalia-vo`), OS system directories (`/etc`, `/System`, `C:\Windows`, …), or credential locations (`~/.ssh`, `.env`, `.aws/credentials`) as a workspace root.
2. **Symlink & traversal abuse:** A symlinked target or parent folder, a path traversal folder name (`..`, embedded separators, Windows reserved names), or a TOCTOU race between preview and execution can redirect writes or workspace grants outside the intended directory.
3. **Dirty repository & protected branch hazards:** Attaching an agent workspace directly to an existing dirty Git working tree or a protected branch (`main`, `master`, `production`, `release/*`, `hotfix/*`) without explicit user acknowledgement risks unintended edits to uncommitted work or release lines.
4. **Silent partial failures:** Provisioning spans multiple side effects (`mkdir`, static scaffold file creation, `git init`, workspace registration, and session attachment). If an intermediate step fails (for example, `git` is missing on `PATH` after `mkdir` and scaffold writes succeeded), reporting a generic failure hides what was actually created on disk, while replaying the same review token could overwrite or duplicate state.
5. **Capability honesty while unassigned:** Before a folder is provisioned and attached, the unassigned Native lead must still propose a clear project plan without pretending local files were read or commands ran.

## Decision

Introduce a two-phase, host-enforced project provisioning API (`previewProjectProvision` and `applyProjectProvision`) on `AgentHostApi`, backed by `packages/host/src/projectProvisioning.ts` and shared contracts in `packages/platform/src/projectProvisioning.ts`, paired with updated unassigned lead guidance in `packages/runtime/src/prompt.ts`.

### 1. Two-phase reviewed provisioning (`previewProjectProvision` → `applyProjectProvision`)

- **Preview (`previewProjectProvision`):** Executes inside `withWorkspaceChange(..., false)` (serialized with workspace mutations without invalidating pending learning). Performs strictly read-only inspection of the target filesystem path, Git status, existing workspaces, runtime/connection configuration, and optional unassigned session state. Never creates directories, writes files, runs `git init`, or mutates workspaces or sessions.
- **Ephemeral single-use review tokens (`ProjectProvisionReviews`):**
  - Bounded to 64 active entries with a 10-minute TTL (`REVIEW_TTL_MS = 10 * 60_000`).
  - Binds each `reviewId` to a SHA-256 fingerprint covering: mode, canonical `targetPath` and `parentPath`, `folderExists`, workspace name/runtime/connection/permissions/cross-workspace access, `templateId`, `gitInit`, matched existing workspace snapshot, `gitInspection`, `plannedActions`, `warnings`, `requiresWarningAcknowledgement`, `workspaceBoundaryKey(config.workspaces)`, and (when attaching) the full unassigned session record, message history, `lastEventId`, `permissionMode`, and `UNASSIGNED_SESSION_BOUNDARY`.
  - `applyProjectProvision` re-runs the exact same read-only inspection and verifies the fresh fingerprint before execution. Any intervening filesystem, Git, workspace, or session mutation invalidates the review and fails closed.
  - Once pre-execution validation passes, `consume(reviewId)` is called **before** step 1 begins so partial failures can never replay an already-consumed token.

### 2. Path safety, symlink rejection, and static scaffolding

- **Protected path gate (`isProtectedProjectPath`):**
  - Rejects filesystem roots (`path.parse(canonical).root === canonical`).
  - Rejects exact `realpath(homeDirectory)` (`Choose a project subfolder instead of your entire home directory.`) while permitting subfolders inside home (e.g. `~/projects/site`). In `create` mode, `homeDirectory` itself is permitted as `parentPath` when creating a validated child folder.
  - Rejects `realpath(dataDirectory)` and any nested path (`isWithin(realData, canonical)`).
  - Rejects credential paths via `isCredentialPath(canonical)` from `packages/host/src/workspaceFs.ts`.
  - Rejects OS system roots and their subpaths: POSIX `/etc`, `/private/etc`, `/bin`, `/sbin`, `/usr`, `/System`, `/Library`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`; Windows `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)` (case-insensitive). Explicitly preserves macOS/POSIX temporary directories (`/var/folders`, `/private/var/folders`, `/tmp`, `/private/tmp`).
- **Symlink & folder-name checks:**
  - Trailing path separators are stripped before `lstat` so POSIX `lstat` never silently dereferences symlinked directories.
  - `create` mode rejects symlinked `parentPath` and symlinked `targetPath`, validates `folderName` with `validateProjectFolderName` (no separators, control characters, `.`/`..`, leading/trailing dots/spaces, Windows reserved names, or >120 chars), rejects existing regular files and non-empty directories (`Use Open existing project instead`), and warns (`existing-empty-directory`) when reusing an existing empty directory.
  - `open` mode rejects symlinked targets (`Symbolic links cannot be attached as project roots. Choose the real folder path instead.`) and resolves canonical `realpath`.
- **Static-only templates (`buildScaffoldFiles`):**
  - Supports only curated templates: `'none'`, `'basic-readme'` (`README.md`, `.gitignore`), and `'node-ts-minimal'` (`README.md`, `.gitignore`, `package.json`, `src/index.ts`).
  - Never executes package managers, scripts, or shell commands (`executesCommands: false`).
  - Files are written exclusively with `{ flag: 'wx' }` (atomic fail-if-exists) inside the validated `targetPath`, creating `src/` only for `'node-ts-minimal'`.

### 3. Safe Git inspection, warning gates, and safe `git init`

- **Read-only inspection (`open` mode):** Uses `gitStatus(realTarget, { env })` from `packages/host/src/inspect.ts` (no shell, `GIT_SAFETY_CONFIG`, scrubbed `gitEnvironment`, filter-driver overrides).
  - Populates `ProjectGitInspection` (`isGitRepo`, `branch`, `dirty`, `dirtyChangeCount`, `protectedBranch`, `truncated`).
  - Emits `dirty-repository` when uncommitted changes exist and `protected-branch` when `isProtectedBranchName(branch)` matches (`main`, `master`, `production`, `prod`, `release/*`, `hotfix/*`).
  - Refuses `gitInit: true` on an existing Git repository (`This folder is already a Git repository.`).
  - If `git` is unavailable on `PATH`, records `isGitRepo: false` and emits `git-unavailable` when `gitInit` was requested.
- **Explicit acknowledgement gate:** `requiresWarningAcknowledgement` is `true` whenever `dirty-repository` or `protected-branch` is present; `applyProjectProvision` refuses execution unless `acknowledgeWarnings: true` is passed.
- **Safe `git init` (`runSafeGitInit`):** Uses `execFile` directly (no shell, `windowsHide: true`) with `--no-pager`, `GIT_SAFETY_CONFIG`, and `gitEnvironment(env)`.

### 4. Sequential execution and itemized partial-failure receipts

`applyProjectProvision` executes up to five explicit steps in order, appending a `ProjectProvisionStepReceipt` (`completed` | `skipped` | `failed`) for each step:

1. `create-folder`: non-recursive `mkdir(targetPath)` (skipped for `'open'` or `'existing-empty-directory'`).
2. `write-file`: per-file atomic `writeFile(..., { flag: 'wx' })` (skipped when no scaffold files are planned).
3. `git-init`: `runSafeGitInit(targetPath, { env })` (skipped when `gitInit` is false).
4. `register-workspace`: `decodeWorkspace` + `assertWorkspaceBoundaryEditable()` + `assignWorkspaceVaultProfile(...)` (for `'isolated'`) + `save()`, or skipped when reusing an already-registered managed Extalia Native workspace during `open` + `attachSessionId`.
5. `attach-session`: when `attachSessionId` is set, attaches the idle unassigned saved Extalia Native session using the exact same reviewed-attach semantics as `moveSession`.

If any step fails after `reviewId` has been consumed, execution stops immediately and returns a structured `ProjectProvisionReceipt`:

```ts
{
  ok: false,
  partial: steps.some(step => step.status === 'completed'),
  mode,
  targetPath,
  workspace?,          // present if step 4 completed before step 5 failed
  steps,               // itemized completed / skipped / failed receipts
  error,
}
```

Extalia never masks a partial failure as success and never silently deletes user-visible files on disk; the caller sees every completed and failed step explicitly.

### 5. Atomic session attach semantics & duplicate workspace handling

- **Duplicate folder protection:** If an existing workspace already uses the canonical `targetPath`:
  - Without `attachSessionId`, both `create` and `open` refuse registration (`A workspace already uses this folder: "..."`).
  - With `attachSessionId` in `open` mode, Extalia verifies the existing workspace is a managed `extalia-native` workspace (refusing observe-only and Hermes workspaces), emits `already-registered-workspace`, sets `existingWorkspaceId`, omits `register-workspace` from `plannedActions`, and skips step 4 during apply.
- **Session eligibility:** `attachSessionId` must name a saved (non-transient, non-observed) Extalia Native session with `workspaceId === null`, idle and clear of `runs`, `nativeOwnership`, `missions`, `promptQueues`, `knowledgeVault` transitions, and active context/learning work, targeting an `extalia-native` workspace (never `hermes`).
- **History & provenance preservation:** Attaching updates `workspaceId`, sets `workspaceBoundary` and `reviewedContextBoundary` to `workspaceSessionBoundaryKey(workspace.id, config.workspaces)`, sets `workspaceFileRoot`, appends the empty-root cutoff `{ throughEventId: lastEventId, workspaceId: '', projectLocation: '' }` to `workspaceFileScopes`, clears transient `grants`, invalidates follow-up suggestions, and updates `queueWorkspaces` inside `promptQueues.withIdleSession(...)`. Conversation messages, events, title, agent identity, operating profile, and team remain intact.

### 6. Unassigned lead guidance (`COD-001` / `UJ-02` step 2)

`buildSystemPrompt` in `packages/runtime/src/prompt.ts` instructs the unassigned Native lead (`!context.workspace`) to:

- Propose a concise project plan covering goal, stack, folder structure, and verification plan when the user wants to build or modify a project before attaching a workspace, asking only essential decisions.
- Direct the user to **Create project** or **Open existing project** in Chat to attach the session to a workspace first.
- Never claim local project files were read, edited, or had commands run while unassigned.

## Consequences

- **Positive:** Users can safely go from an unassigned planning conversation to a freshly scaffolded (or existing) project workspace and attached session in one reviewed flow, with fail-closed protection against system/credential paths, symlinks, stale reviews, dirty/protected Git repos, and silent partial failures.
- **Trade-offs:** Re-inspecting on apply adds one fast local `lstat`/`realpath`/`git status` pass, which is acceptable for a user-initiated provisioning action and closes TOCTOU windows. Partial failures intentionally leave completed folders/files on disk with itemized receipts rather than attempting destructive automatic `rm -rf` rollbacks.

## Verification

Verified in `packages/host/test/projectProvisioning.test.ts` and `packages/runtime/test/operatingProfilePrompt.test.ts` using isolated temporary directories (`mkdtemp`, isolated `dataDirectory`/`homeDirectory`, and scrubbed `PATH`):

- Preview performs zero filesystem, workspace, or session mutations.
- Create mode with `'none'`, `'basic-readme'`, `'node-ts-minimal'`, and `gitInit: true`, plus existing empty directory reuse.
- Open mode with clean/dirty/protected-branch Git repos, refusal of `gitInit` on existing Git repos, duplicate workspace refusal without `attachSessionId`, and workspace reuse with `attachSessionId`.
- Atomic attach preserving conversation history, `workspaceFileScopes` empty-root cutoff, and unlocking workspace tools on the next turn.
- Security refusals for filesystem root, home directory, Extalia data directory, credential paths, POSIX/Windows system roots, symlinks (parent and target), non-empty target directories, and folder-name traversal.
- Warning acknowledgement gates, stale review invalidation, expiry, single-use consumption preventing replay, and itemized partial-failure receipts via isolated `PATH` without `git`.
