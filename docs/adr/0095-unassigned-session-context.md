# ADR 0095: Unassigned session context (zero-grant conversation sessions)

Status: Partially implemented — 2026-11-24 (Slice A1 backend, platform, storage & zero-grant execution guards verified locally; Slice A2 Chat UI pending)

Resolves: `OQ-01` in [PRD-SF-1.0](../product/prd-session-first-coding-discord.md) (`DEC-01`, `DEC-02`, `DEC-03`, `SES-001..012`, `WRK-002`, `PRF-001..005`, `REL-001`, `REL-002`).

## Context

In the `v0.4.353` baseline, `SetupWizard` (`apps/web/src/setup/SetupWizard.tsx`) already lets a user defer workspace creation (`Skip workspace`) and `completeSetup('managed')` (`packages/host/src/service.ts:3889`) succeeds with zero registered workspaces whenever a saved Native model connection or Hermes runtime exists. Yet the managed session pipeline still requires a registered `Workspace` with a local folder at every layer:

- **Persistence (`packages/host/src/sessions.ts`):** `SessionRecord.workspaceId` is a mandatory `string` (line 13). `isRecord()` (line 89) requires `typeof record.workspaceId === 'string'`, and `SessionStore.readIndex()` (line 137) silently drops records that fail `isRecord()`.
- **Platform contract (`packages/platform/src/agentHost.ts`, `sessionMove.ts`):** `SessionSummary.workspaceId` is a non-null `string`, `createSession(workspaceId: string, options?)` and `modelChoices(workspaceId: string, sessionId?)` require a workspace ID, and `SessionMovePreview.source` is a required `SessionMoveWorkspace`.
- **Host execution (`packages/host/src/service.ts`, `workspaceAccess.ts`, `workspaceBoundary.ts`):**
  - `openSession` (line 1904) looks up `config.workspaces.find(...)`, computes `workspaceSessionBoundaryKey(workspace.id, config.workspaces)`, and writes `cwd: workspace.projectLocation ?? ''` in `session.started` (note: `packages/protocol/src/events.ts:93` already defines `cwd?: string` as optional).
  - `sendPrompt` (line 5209) calls `findWorkspace(record.workspaceId)`, throws if `!workspace.projectLocation`, calls `createWorkspaceAccess(...)` (which rightly fails closed when no workspace/root exists), and mounts `createFileTools`, `workspaceFoldersTool`, `createCommandTool`, `createNativeScheduleJobs`, `knowledgeToolsFor`, `MemoryStore`, `workMemory`, `observedMemory`, and workspace-bound `skillRegistry.activeCatalog(workspace.id)`.
  - `modelChoices` (line 4310), `setSessionOptions` (line 4290), `saveSessionTeam` (line 4371), `planTeam` (line 4392), `sessionMoveSnapshot` (line 2288), and `promptQueues` (line 1739) all require `record.workspaceId` to resolve to a registered workspace in `config.workspaces`.
- **Chat UI (`apps/web/src/chat/`):**
  - `ChatPage.tsx` (lines 124–139) returns an empty-state card + `WorkspacesSection` whenever `!workspace`, blocking the composer even after a valid workspace-deferred setup.
  - `selection.ts` (`resolveChat`) filters sessions strictly by `item.workspaceId === workspace?.id`, hiding any session without a workspace.
  - `sessionHandoff.ts` (`createComposerSession`), `Composer.tsx`, `ChatTeamControls.tsx` + `chatTeam.ts`, `NativeSessionTree.tsx`, and `SessionMoveDialog.tsx` all assume a non-null `workspace: Workspace` or `workspaceId: string`.

Users need to start chatting immediately in an Extalia Native session without binding a project folder, with strict fail-closed isolation from the local filesystem, workspace memory, and Knowledge vaults, and with an explicit reviewed path to attach that conversation to a workspace later.

## Options evaluated

### Option A: Transitional host-owned unassigned sentinel (`workspaceId: string` sentinel or synthetic workspace)

Keep `SessionRecord.workspaceId: string` using either a reserved sentinel string (e.g. `'__unassigned__'`) or a hidden synthetic workspace record in host state, then migrate to nullable `workspaceId` in a later release.

- **Pros:** Minimal initial TypeScript signature change on `SessionSummary` and `SessionRecord`; `v0.4.353`'s `isRecord()` accepts string values on disk.
- **Cons:**
  1. **Sentinel conflation hazard:** A synthetic workspace or string sentinel forces every consumer (`workspaceAccess.ts`, `workspaceBoundary.ts`, `vaultProfiles`, `FilesPage`, `GitPage`, `MissionsPage`, `SchedulesPage`, `WorkspacesSection`, `OfficePage`) to remember to filter or special-case the sentinel. A single missed branch risks treating the sentinel as a workspace ID, creating bogus folders under `layout.workspaces/<sentinel>`, or falling back to a default Knowledge vault (note that `packages/host/test/vaultProfilesGlobal.test.ts` already exists specifically to guard against sentinel conflation with `GLOBAL_OBSERVE_WORKSPACE_ID`).
  2. **No reduction in actual Slice A engineering work:** Inspecting `service.ts` and `apps/web/src/chat/*` shows that `openSession`, `sendPrompt`, `modelChoices`, `setSessionOptions`, `saveSessionTeam`, `planTeam`, `sessionMoveSnapshot`, `promptQueues`, `ChatPage`, `resolveChat`, `ChatTeamControls`, `NativeSessionTree`, and `SessionMoveDialog` all MUST branch explicitly for zero-grant sessions anyway.
  3. **Second migration debt:** Deferring the true nullable domain model creates a future breaking migration of `sessions/index.json`, `AgentHostApi`, and `SessionMovePreview`.

### Option B: Native nullable `workspaceId: string | null` across schema, host, platform, and UI (Recommended)

Represent unassigned sessions directly as `workspaceId: null` across `SessionRecord`, `SessionSummary`, `AgentHostApi`, `SessionMovePreview`, and React chat state, paired with an explicit zero-grant boundary constant and a one-time pre-migration backup of `sessions/index.json`.

- **Pros:**
  1. **Compiler-enforced fail-closed safety:** Changing `workspaceId` to `string | null` causes `tsc` (`pnpm check`) to flag every host, platform, and UI callsite that previously assumed a registered `Workspace` exists. No callsite can silently pass an unassigned session to `createWorkspaceAccess`, `workspaceSessionBoundaryKey`, `workspaceMemoryDirectory`, `createFileTools`, or `vaultProfiles`.
  2. **Clean domain separation:** `config.workspaces` remains purely user-registered projects; no fake workspace leaks into `Files`, `Git`, `Missions`, `Schedules`, or `WorkspacesSection`.
  3. **Single canonical schema:** Matches PRD-SF-1.0 §8.3 and Appendix A with zero follow-up migration debt.
- **Trade-off (explicitly mitigated):** `v0.4.353`'s `SessionStore.readIndex()` (`packages/host/src/sessions.ts:137`) runs `.filter(isRecord)` where `isRecord` requires `typeof record.workspaceId === 'string'`. If a user creates an unassigned session on Slice A and later downgrades to `v0.4.353` and mutates any session, `v0.4.353` would drop the `null` record on rewrite. Mitigated explicitly in the Migration & Rollback section below via a one-time atomic backup `sessions/index.pre-unassigned.json`.

## Decision

Adopt **Option B** directly for Slice A: make `workspaceId: string | null` the canonical representation of managed sessions, restricted exclusively to **Extalia Native** sessions with explicit zero-grant admission.

### 1. Schema, boundary constant, and runtime honesty

- Update `SessionRecord.workspaceId` (`packages/host/src/sessions.ts`) and `SessionSummary.workspaceId` (`packages/platform/src/agentHost.ts`) to `string | null`.
- Update `isRecord()` in `packages/host/src/sessions.ts` so `workspaceId` must be either `null` or a non-empty `string` (`typeof record.workspaceId === 'string' && record.workspaceId.trim().length > 0`), except observed summaries which keep their own store. Reject `projectLocation` when `workspaceId === null`.
- Define a dedicated boundary constant in `packages/host/src/workspaceBoundary.ts`:
  - `export const UNASSIGNED_SESSION_BOUNDARY = 'unassigned-v1:no-workspace-grants';`
  - It is structurally distinct from `workspace-v1:<sha256>`, legacy global `workspaceBoundaryKey`, and `GLOBAL_OBSERVE_WORKSPACE_ID` (`'global-observe'`).
  - `workspaceSessionBoundaryKey(workspaceId, workspaces)` continues to require a non-null registered `workspaceId: string` and continues to throw `WorkspacePathError` if missing.
- Emit `session.started` without `cwd` when `workspaceId === null` (`packages/protocol/src/events.ts:93` already permits `cwd?: string`).
- **Hermes runtime exclusion (honest capability):** `openSession` refuses creating an unassigned session for `hermes` (`startHermesTurn` at `service.ts:5251` requires a real local `cwd`). Unassigned sessions are Extalia Native only.

### 2. Fail-closed no-filesystem-grant enforcement

When `record.workspaceId === null`, host admission in `sendPrompt` (`packages/host/src/service.ts`) enforces strict zero-grant conversation-only execution:

- **Zero filesystem roots:** `createWorkspaceAccess` and `sessionProjectWorkspace` are **never called**. No fallback to `$HOME`, `process.cwd()`, OS temp directories, or `layout.root` is permitted.
- **Tool omission + host-level denial:** The following tool families are **not constructed and not offered** to either the lead or any delegated worker:
  - `createFileTools` (read/edit/write/list/search)
  - `workspaceFoldersTool`
  - `createCommandTool`
  - `createNativeScheduleJobs` (schedules bind to a workspace)
  - `knowledgeToolsFor` (Knowledge vaults are profile/workspace-bound)
  - `MemoryStore` (`workspaceMemoryDirectory`), `workMemory` tools, and `observedMemory` tools
  - `skill_propose` / workspace-scoped `candidateReviewToolsFor` / workspace automatic-learning deferral (`learningSchedule.deferWorkspace`, `yieldLearningForWorkspace`)
- **System prompt & permission posture:**
  - `projectInstructions` is skipped (no project root to inspect).
  - Effective `permissionMode` defaults to `'plan'` (or a conversation-only ceiling where `ask`/`accept-edits`/`workspace` grant zero file/command tools while `workspaceId === null`; stored `permissionMode` preference is preserved only as an intent until reviewed attach).
- **Allowed conversation capabilities:**
  - Multi-turn model completion, streaming deltas, cancellation, prompt attachments (using existing session-scoped private attachment staging without granting disk browsing), and pending prompt queue / steering (`promptQueues` computes its `queueIdentity` with `workspaceId: null` and `UNASSIGNED_SESSION_BOUNDARY` without calling `config.workspaces.some(...)`).
  - Global built-in and verified active user skills (`skillRegistry.activeCatalog(null)`) when the session connection enables `extaliaSkills` and the Rust daemon is healthy (failing closed to built-ins only when daemon is unavailable, never reading project skills or workspace consent).
  - Optional delegation to subagents (when the user explicitly enables a team) with **zero filesystem/memory/knowledge tools** on workers as well (conversation/reasoning/analysis workers only).

### 3. Connection, operating profile, and team resolution when unassigned

- Extend `AgentHostApi.createSession`:
  - `createSession(workspaceId: string | null, options?: SessionOptions): Promise<SessionSummary>`
  - Extend `SessionOptions` (for creation) with optional `connectionId?: string`, `operatingProfileId?: string`, and `clientRequestId?: string`.
- **Connection resolution for `workspaceId === null`:**
  1. Explicit `options.connectionId` (must exist in `config.connections` and be a valid Native connection).
  2. Otherwise, if `options.operatingProfileId` is supplied, resolve the preset from `config/operating-profiles.json` (`ADR 0083`) and use its `defaults.leadConnectionId` if present and valid.
  3. Otherwise, if `config.connections.length === 1`, use that single saved connection; if multiple saved connections exist and none was explicitly passed, use the user's host-persisted default connection preference or fail with an actionable `UserError` asking the user to select a connection (never silently substituting a broken/missing connection).
- **Operating profile & Solo default:**
  - Unassigned sessions default to **Solo** (`team: undefined`) unless the user explicitly selects an `operatingProfileId` with a team or explicitly supplies a reviewed `team` snapshot.
  - `validateTeamConnections(team, { providerProfileId: connection.id })` validates all member connections and approved model grants directly against `config.connections` without needing a `Workspace`.
  - `saveSessionTeam`, `setSessionOptions`, and `planTeam` accept unassigned sessions by resolving a synthetic read-only runtime descriptor `{ providerProfileId: record.connectionId }` strictly for connection/model validation (never passed to filesystem, memory, or workspace stores).
- **`modelChoices` without workspace:**
  - `modelChoices(workspaceId: string | null, sessionId?: string, connectionId?: string): Promise<ModelChoices>`
  - When `workspaceId === null`: resolve `connectionId` from the existing session's `record.connectionId` (when `sessionId` is provided; verifying `record.workspaceId === null`) or from the explicit `connectionId` / default connection rule above. Return `{ runtime: 'extalia-native', defaultModel, models, efforts, defaultEffort, permissionModes: ['plan'] }` (or conversation-only permission indicator).

### 4. Idempotent first-send (`clientRequestId`)

- In `apps/web/src/chat/sessionHandoff.ts` (`createComposerSession`) and `Composer.tsx`, each fresh submission from an unsaved composer (`sessionId === null`) generates one stable UUID `clientRequestId` bound to that submission attempt (mirroring the `createRequestId` pattern in `packages/host/src/operatingProfiles.ts` from ADR 0083).
- Persist optional `createRequestId?: string` on `SessionRecord` (validated as UUID, bounded length) for sessions created via `createSession`:
  - Inside `persistence.run(...)` serialized by `SessionStore`, check whether an existing record already carries `createRequestId === options.clientRequestId`.
  - If found and the normalized creation parameters (`workspaceId`, `connectionId`, `operatingProfileId`, `options`, `team`) deeply match, return the existing `SessionSummary` without creating a second session or emitting a duplicate `session.started` event.
  - If found with **different** creation parameters, reject fail-closed with a `UserError` (preventing parameter smuggling or stale-draft replay).
- For the paired first `sendPrompt(sessionId, text, { ..., clientRequestId })`:
  - Track bounded per-session accepted turn request IDs (in memory + last accepted request ID on the session record or event metadata) so a transport-retry of an already-admitted first prompt does not append a second identical user turn or trigger a duplicate provider call, while retaining ADR 0033 / ADR 0056 rules that uncertain provider executions are never automatically replayed.

### 5. Reviewed attach from unassigned → workspace (`SessionMoveReviews` extension)

Upgrading an unassigned session into a registered Extalia Native workspace reuses and extends the existing reviewed-move architecture (`packages/host/src/sessionMove.ts`, `packages/host/src/service.ts:2288,4573-4608`, `packages/platform/src/sessionMove.ts`):

- **Type extension:**
  - `SessionMoveReviews` `Snapshot.source: Workspace | null`
  - `SessionMovePreview.source: SessionMoveWorkspace | null`
  - `SessionMovePreview.kind: 'attach' | 'move'` (derived as `'attach'` when `source === null`, `'move'` when `source !== null`; additive for backward compatibility).
- **Fingerprint binding (`sessionMove.ts`):**
  - When `snapshot.source === null`, include `UNASSIGNED_SESSION_BOUNDARY` instead of `workspaceSessionBoundaryKey(snapshot.source.id, ...)`, together with `snapshot.record`, `null`, `snapshot.destination`, `snapshot.messages`, destination `workspaceSessionBoundaryKey`, destination `access.folders()`, and `snapshot.lastEventId`.
  - Expire reviews after 10 minutes and cap cache at 64 entries as today.
- **Admission guards (`sessionMoveSnapshot`):**
  - Require Native session (`!record.runtime`), not observed, idle (`!runs.has(sessionId)`), no unfinished prompt queue (`!promptQueues?.hasUnfinished(sessionId)`), clear `nativeOwnership`, clear `missions`, stable `knowledgeVault`, and idle learning/context readers.
  - Destination must be an existing managed Extalia Native workspace with a valid `projectLocation` passing `createWorkspaceAccess({ workspaceId, workspaces, protectedRoots: [layout.root] })`.
  - Validate `record.connectionId`, `storedTeam(record)`, and `storedOptions(record)` against the destination workspace's effective configuration.
- **Atomic attach application (`moveSession`):**
  - Preserves `record.id`, `createdAt`, `title`, `agentName`, `agentGender`, `operatingProfile`, `team`, `<id>.events.jsonl`, and `<id>.messages.json` intact.
  - Updates `workspaceId: snapshot.destination.id`, `workspaceBoundary: destinationBoundary`, `reviewedContextBoundary: destinationBoundary`, `projectLocation: undefined` (uses destination primary root), and `workspaceFileRoot: snapshot.destination.projectLocation`.
  - If `snapshot.lastEventId` exists, appends a historical scope cutoff `{ throughEventId: snapshot.lastEventId, workspaceId: '', projectLocation: '' }` to `workspaceFileScopes` so pre-attach transcript turns are explicitly marked as having had zero workspace roots (preventing historical file-preview resolution against the newly attached workspace).
  - Clears `grants.delete(sessionId)`, invalidates `followupSuggestions`, updates `queueWorkspaces`, and consumes `reviewId`.
- **One-way policy in Slice A:** Detaching a workspace-bound session back to `workspaceId: null` is **not** permitted in Slice A (preventing project-file context from lingering in an unassigned session; deferred for Slice B review).

### 6. Chat UI boundary updates

- **`apps/web/src/chat/selection.ts`:** Update `ChatSelection` to distinguish `workspaceId?: string | null` (`null` = explicit unassigned context; `undefined` = default/unselected) so `resolveChat` returns `{ workspace: undefined, unassigned: true, sessions, session }` without requiring a workspace.
- **`apps/web/src/chat/ChatPage.tsx`:** Remove the `if (!workspace)` composer block whenever at least one Native connection exists (show a lightweight connection-setup prompt only if `state.connections.length === 0` and Hermes is absent). Render a clear context pill (`Unassigned · Chat only`) with a one-click **Attach to workspace** action opening `SessionMoveDialog` in `'workspace'` (attach) mode. Hide `ProjectSkillsNotice` and `MemoryContextPanel` cleanly when `workspace === undefined`.
- **`apps/web/src/chat/NativeSessionTree.tsx`:** Render a dedicated collapsible **Unassigned / General** section above workspace groups for sessions with `workspaceId === null`. Disable drag-and-drop on unassigned rows (`nativeSessionDrop` refuses drops onto workspace folders); workspace attachment must always go through the reviewed dialog.
- **`apps/web/src/chat/ChatTeamControls.tsx` & `chatTeam.ts`:** Make `workspace?: Workspace` optional; when unassigned and `!sessionId`, maintain draft team/profile state for the upcoming `createSession(null, ...)` call rather than calling `saveWorkspaceTeam`.
- **Localization:** Add all new labels, badges, attach preview descriptions, and error messages in both English and Indonesian in `apps/web/src/i18n.ts`.

## Migration, backward compatibility, and rollback

- **Zero-touch upgrade for existing data:** Existing workspace-bound `SessionRecord` entries in `sessions/index.json` remain unmodified. No workspace or profile migration is triggered on upgrade.
- **Pre-unassigned atomic backup (`REL-001`):** Because `v0.4.353`'s `SessionStore.readIndex()` (`packages/host/src/sessions.ts:137`) filters out entries where `typeof record.workspaceId !== 'string'`, Slice A `SessionStore` writes a one-time atomic backup `sessions/index.pre-unassigned.json` (mode `0o600`) immediately before persisting the first record with `workspaceId: null` (if that backup file does not already exist).
- **Rollback guidance:** If a user rolls back the binary to `v0.4.353`, they should either attach unassigned sessions to a workspace before downgrading or retain `sessions/index.pre-unassigned.json` so older builds do not strip `null` records during subsequent index rewrites.

## Verification requirements

Implementation of this ADR (WP-01, WP-02, WP-03, WP-13) requires the following automated verification before acceptance:

1. **Zero-grant & fail-closed security (`AC-26`, `SES-003`):** Host integration tests with a temporary `EXTALIA_HOME` and deterministic mock Native provider proving that an unassigned session exposes zero file tools, zero `workspace_folders`, zero command tools, zero schedule tools, zero workspace memory, and zero Knowledge tools; explicitly assert that relative paths (`.`, `..`), `$HOME`, `process.cwd()`, and `EXTALIA_HOME` cannot be accessed and that Hermes refuses unassigned creation.
2. **Creation, model choices, and operating profiles (`AC-01`, `AC-03`, `AC-07`, `AC-08`, `PRF-001..005`):** Host + UI tests verifying `createSession(null, ...)`, `modelChoices(null, ...)`, default Solo behavior, explicit Operating Profile / Team snapshot resolution (without mutating presets), and missing-connection refusal.
3. **Idempotent first-send (`SES-002`, `SES-007`, `NFR-03`, `AC-01`, `AC-03`):** Concurrency and retry tests calling `createSession(null, { clientRequestId })` twice concurrently and sequentially with identical payloads (yielding 1 session) and with altered payloads (rejected fail-closed), plus retry deduplication on `sendPrompt`.
4. **Reviewed attach (`AC-04`, `AC-06`, `SES-005`):** Integration tests covering `previewSessionMove` → expired/stale digest rejection → confirmed `moveSession` from `null` to a Native workspace, verifying identical `sessionId`, preserved transcript/messages/agentName, recorded empty-root cutoff in `workspaceFileScopes`, cleared transient grants, and subsequent turn gaining destination file tools. UI tests verifying unassigned rows cannot be drag-dropped onto workspace folders.
5. **Restart & backup durability (`AC-25`, `REL-001`, `REL-002`):** Host restart tests verifying both unassigned and workspace-bound sessions survive restart intact, `sessions/index.pre-unassigned.json` is written once before the first `null` record, and existing `v0.4.353` fixtures load cleanly.
6. **Bilingual & responsive UI (`REL-008`, `NFR-09`, `NFR-10`):** Playwright checks with temporary host data in EN/light desktop (1280px) and ID/dark mobile (390px) covering zero-workspace Chat rendering, New Session send, `Unassigned` tree group, and reviewed attach flow.
