# ADR 0028: Workspace isolation for write-capable workers

Status: Proposed (2026-10-22). A first TypeScript slice is implemented behind the mission plan
(only tasks marked `access: 'write'` use it); the open questions below need the owner before
the slice becomes a product feature.

## Context

FR-03/FR-05 and PRD stage 6 require write-capable concurrent coding workers in separate Git
worktrees, explicit artifact ownership, an integration queue, diff review, test gates and
conflict handling; "never silently merge to protected branches". AC-03: two coding workers edit
separate worktrees and integration review detects a conflict before merge. The ledger adds: Stage 6
cannot enable write tools before approval, intent and recovery decisions are enforced.

Repository facts (working tree, 2026-10-22):

- The mission kernel (`packages/runtime/src/mission.ts`) admits only `read` tools of kind
  `read`/`search` (`readOnlyTools`) and runs every worker with `fileWrite: 'ask'` and an approval
  callback that always rejects. Workers get `createFileTools(workspace.projectLocation)` filtered
  to reads (`packages/host/src/mission.ts` `prepareMission`).
- File tools resolve every path with `resolveInside(root, …)` (`workspaceFs.ts`): no path outside
  the root, no symbolic link leading outside it, no `.git` writes, no credential files. The root is
  the only binding between a worker and a folder.
- Write-capable *team members* in chat (`memberAccess.ts`) share the lead's checkout and are
  limited by path scopes, not isolation.
- The Git page backend (`inspect.ts`) already runs Git without a shell, with a minimal environment
  (`gitEnvironment`: no `GIT_*`, no credentials, no terminal prompt) and `GIT_SAFETY_CONFIG`
  (hooks, fsmonitor, external diff, pager and credential helper off; filter drivers overridden).
- The mission journal accepts only read/search tool activity, in both stores (host
  `missionCheckpoints.ts`, Rust `extalia-core` mission policy). Approvals are in RAM, one per run,
  without digest or expiry (ADR 0026 describes the target). Evidence is unenforced (ADR 0027).
- With `nativeCore: rust` the daemon owns mission/task state, leases and `permission.check`
  (ADR 0021, 0026); providers and tools stay in the TypeScript host.

## Options considered

| Topic | Options | Trade-offs |
| --- | --- | --- |
| Isolation mechanism | **`git worktree` per worker** · full clone per worker (`clone --shared`/`--reference`) · copy-on-write folder copy · OS sandbox | Worktrees share objects and refs, so merges, conflict detection and branch updates are plain Git; they add an administrative entry under the repository's `.git/worktrees` (metadata only, never the working tree). Clones avoid that entry but need fetch/push between repositories and duplicate refs. Folder copies have no merge base, so conflicts can only be found by ad-hoc three-way diffing. OS sandboxes do not solve integration |
| Location | **Under the data folder** (`<data>/worktrees/<id>`) · next to the repository · inside it (`.extalia/worktrees`) | Inside the repository pollutes the user's tree, `git status`, editors and file watchers, and workers could reach each other's folders. Next to it writes to folders the user did not choose. The data folder is private (0700), already per profile and lock-protected |
| Non-Git workspaces | **Refuse write-capable tasks** · copy-on-write fallback | A fallback has no base commit, no reliable conflict detection and no reviewable diff digest. Refusing keeps one model; read-only missions still run |
| Ownership | **One worker per worktree; no file-level locks** · advisory file claims · scope globs | One owner removes write races entirely. File locks serialise parallel work and still miss semantic conflicts; conflicts are found at integration instead. Plan-level scopes (`memberAccess.ts` patterns) are a cheap later addition |
| Integration | **Serial queue, merge onto the current target tip in a disposable integration worktree, fast-forward or compare-and-swap the target** · rebase worker branches · merge in the user's checkout | Merging in a scratch worktree tests exactly what would land, without touching the checkout; serial order makes every proposal see the previous result. Rebasing rewrites worker history (and needs force). Merging in the checkout risks the user's local changes |
| Approval | **User approval bound to the diff digest, applied without force** · auto-merge when the gate passes | PRD: never silently merge; ADR 0026: digest-bound approvals, no self-approval |

## Recommended decision

1. **What "write-capable" means.** A mission task carries `access: 'write'` (default read). Only
   such a task gets the write file tools (`write_file`, `edit_file`), rooted in its own worktree;
   commands, delegation, memory and meta tools stay unavailable to every worker. Read-only tasks
   are unchanged (they keep reading the checkout). The kernel accepts write tools only for tasks
   marked `writeCapable` and runs them with `fileWrite: 'allow'`: the tool root is the worker's
   private worktree, so the per-call approval moves to integration. Edits are left out of the
   mission journal (it admits read/search only) and are recorded by the worktree diff instead.
2. **Location and naming.** `<data>/worktrees/<id>`, `id = w-<12 hex>`; branch
   `extalia/worker/<id>` (refused if it exists; nothing is overwritten). The registry is
   `<data>/state/worktrees.json` (private, atomic writes). Refused when the data folder is inside
   the repository or the repository inside the data folder, and from inside another worktree. A
   workspace that is a subfolder of the repository roots the tools in the same subfolder.
3. **Base pinning.** The base (`HEAD`, a local branch or a commit) is resolved to a commit once
   at creation and recorded; the worktree starts exactly there. The base branch, when there is
   one, is the default integration target.
4. **Ownership.** One worker per worktree, recorded as `{ missionId, taskId, agentId }`. While the
   owning mission runs, the worktree cannot be removed. When the task ends the host commits what
   the worker wrote (fixed identity, hooks and signing off) and marks it `released`. A task whose
   execution is `unknown` keeps an active worktree.
5. **Integration queue.** One proposal or apply at a time (separate from worktree creation, so a
   long gate never delays a mission start). A proposal requires a released worker, merges its
   branch with `--no-ff` onto the current target tip in a disposable worktree
   `<data>/worktrees/i-<12 hex>`, and records the merge commit under
   `refs/extalia/integration/<id>`. Results: `ready`, `conflict` (with the conflicting paths; the
   merge is aborted, nothing is resolved automatically), `gate_failed`, `gate_missing`, `empty`,
   later `applied` or `stale`. A conflict becomes a review task for the lead/user (next slice).
6. **Test gate.** The workspace's configured command runs in the integration worktree through the
   existing command runner (no shell injection from models, credential-free environment, process
   group killed on timeout, bounded and redacted output). Evidence per ADR 0027: command, exit code,
   duration, log (≤ 16,000 characters) and its SHA-256, `basis: verified_by_extalia`. Without a
   configured gate a proposal is `gate_missing` and cannot be applied.
7. **Applying.** Only a `ready` proposal, only with the user's approval carrying the exact
   `diffDigest` (SHA-256 over `extalia.diff.v1`, both commits and the full binary diff
   `target → merge`). Before moving anything the host re-checks that the target is still at the
   proposal's base (otherwise `stale`, nothing changes), that the merge commit is the recorded one,
   and recomputes the digest. A target checked out somewhere is fast-forwarded there with
   `merge --ff-only` (Git refuses to overwrite local changes; the error is reported, nothing
   changes); otherwise the ref is compare-and-swapped with `update-ref <new> <old>`. No force,
   no reset, no rebase, no push.
8. **Cleanup and recovery.** Startup marks every worktree a previous process left `active` as an
   orphan; `orphans()` also reports registered worktrees whose folder is missing and unknown folders
   under `<data>/worktrees`. Nothing is deleted automatically. Removal of a worktree with
   uncommitted changes or commits its target does not contain requires the `fingerprint` from
   `status()` (head + porcelain status + tracked diff); any change since the review invalidates it.
   Branch deletion is a compare-and-delete on the reviewed head. Integration worktrees are removed
   after each proposal (their merge commit survives through its ref).
9. **Git safety.** The `git` CLI only (no new dependency), via `execFile` without a shell, with
   per-call timeouts and output limits, `gitEnvironment()` (no credentials, no `GIT_*`) and
   `GIT_SAFETY_CONFIG`; configured filter drivers are switched off. Refused with a clear message:
   no repository or no commit, bare repositories, submodules (`.gitmodules` at the base),
   attribute-selected filters including Git LFS, custom merge drivers (attributes or config).
10. **Rust core.** With `nativeCore: rust`, task state, leases, the journal and
    `permission.check` stay in the daemon (it allows worktree writes because the request carries
    the worker's `fileWrite: 'allow'`); Git operations stay host-side. Next: worktree ownership as a
    lease-bound resource row and integration approvals as `approvals` rows in `core.sqlite`
    (ADR 0026: digest, actor, expiry, consumed once), and the daemon's event policy admitting edit
    activity for `write-worker` tasks.
11. **Permissions.** Writes only inside the worker's worktree (tool root plus `resolveInside`);
    `.git` and credential files stay refused. Integration into a user branch requires the user's
    approval bound to the digest (ADR 0026 rule 5: no worker, tool, model or hook can decide it;
    the worktree API is not offered to agents). Removing unmerged work requires the user's
    fingerprint confirmation.

## Consequences

- Write-capable workers exist only for Git repositories with at least one commit; history-off
  (transient) sessions cannot use them because worktrees live on disk.
- The repository's `.git` gains administrative entries (`.git/worktrees/*`) and branches under
  `extalia/worker/*` plus transient refs under `refs/extalia/integration/*`; the working tree and
  the user's branches change only through an approved apply.
- Disk use grows with one checkout per write task; nothing is reclaimed automatically.
- Worker edits do not appear in the Office/mission timeline until the journal schemas (host and
  Rust) admit edit activity for write workers.
- Hooks do not run for Extalia's commits, merges or fast-forwards (including `post-merge` in the
  user's checkout).

## Open questions for the owner

1. Gate configuration: a per-workspace setting (proposed: `integrationGate.command`, edited only
   in Settings), and may a workspace explicitly opt into ungated integration (proposed: no)?
2. Default integration target: the base branch (implemented) or an Extalia integration branch
   the user merges by hand? Should protected branches (for example `main`) need a second
   confirmation?
3. Retention: how long released, integrated worktrees and branches are kept before the UI offers
   cleanup (proposed: remove clean integrated worktrees on mission archive, keep branches).
4. Should a conflict spawn a resolver worker (write-capable, on an integration branch) or always go
   to the user?
5. Support for submodules and Git LFS (needs network/credential policy for LFS smudge).
6. Plan-level path scopes for write workers (reuse `memberAccess.ts` patterns) as a cheap guard
   against out-of-scope edits?

See the [gap map](../product/prd-v1.1-gap-map.md) (W4) and the
[orchestration ledger](../product/native-orchestration-v1-handoff.md) (stage 6).

## Note (2026-10-23): edits in the journal, worktree API and integration UI

- **Journal admission.** Decision 1's "edits are left out of the mission journal" is superseded. A
  task with `access: 'write'` (new optional `Task.access` contract field; also on `HostMissionTask`)
  may journal `agent.state` with activity `edit` and `tool.started`/`tool.completed` of kind `edit`
  for `write_file`/`edit_file` only, with an optional `target`: an ASCII path relative to the
  worker's worktree (≤ 240 characters, ≤ 32 segments, no empty, `.`, `..` or absolute parts). No
  content, edit text, output or raw label. Read-only tasks keep refusing edit activity. The rule is
  one table in `@extalia/protocol` (`missionJournal.ts`, `missionJournalRole`), generated to
  `packages/protocol/schemas/journal-admission.json` and embedded by the Rust store policy; the
  shared fixture `packages/protocol/test/fixtures/journal/admission.json` is checked by vitest
  (protocol and host store) and `cargo test` (policy and store). The runtime write wrapper derives the
  target with `journalEditTarget` and the kernel requires the plan's `access` to match `writeCapable`.
  The host announces write workers with role `write-worker`; the Office and the Missions timeline
  show their edits (ADR 0016 projection unchanged otherwise).
- **API.** `AgentHostApi` gains optional `listWorktrees`, `worktreeStatus`, `worktreeDiff`,
  `worktreeOrphans`, `removeWorktree` (fingerprint), `proposeIntegration` (target + gate),
  `integrationProposals` and `applyIntegration` (diff digest), forwarded by Desktop IPC and the Bridge
  through `AGENT_HOST_METHODS` and validated by `@extalia/platform` (`worktrees.ts`) before the host
  sees them. They are never agent tools. A transport answers a missing optional method with "This host
  does not support this action."
- **UI.** The Missions monitor shows a Changes panel for missions with write tasks (hidden when the host
  lacks the methods). No workspace gate setting exists yet (open question 1), so the panel asks for the
  gate command (default `npm test`, with a note); an empty gate yields `gate_missing`.

## Note (2026-10-23): per-workspace integration test gate (open question 1)

Recommended answer to open question 1, implemented as a TypeScript slice:

- **Where the gate is configured.** On the workspace: optional `Workspace.integrationGate =
  { command, timeoutSeconds? }` (`@extalia/core`; `decodeIntegrationGate`, limits
  `INTEGRATION_GATE_LIMITS`: command ≤ 4,000 characters, trimmed, no NUL; timeout 1–1800 s, default
  600 s). It is stored with the workspace in the host config (`config/extalia.json`); absent means not
  configured, so older files load unchanged, and a damaged stored gate is dropped (never the
  workspace). `WorkspaceInput.integrationGate` is validated by `@extalia/platform`
  `normalizeIntegrationGate` (the same rules as a proposal's gate); omission keeps the stored value and
  `null` removes it. It is edited only by the user in Settings → Workspaces (the setup wizard leaves it
  out), with a suggestion button derived from the project's files (`package.json` `test` script →
  `pnpm`/`yarn`/`npm test` by lockfile, else `Cargo.toml` → `cargo test`) that is never applied
  automatically. No agent tool can change it.
- **Resolution.** `proposeIntegration` uses the request's gate when given (`gateSource: 'request'`),
  otherwise the gate of the workspace whose mission owns the worktree (`gateSource: 'workspace'`,
  recorded on the proposal). The Changes panel pre-fills the gate field from the workspace setting,
  says where it comes from, sends a gate only when the user typed a different command, and links to
  the workspace editor in Settings. The previous `npm test` default is gone.
- **Ungated integration is not allowed.** There is no opt-out: with no gate in the request or the
  workspace the proposal is `gate_missing` and cannot be applied (decision 6 unchanged). A workspace
  without tests can configure an explicit trivial command, which keeps that choice visible and
  recorded in the gate evidence instead of being a silent mode.
