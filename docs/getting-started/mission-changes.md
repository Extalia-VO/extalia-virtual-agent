# Mission changes

A task explicitly marked write-capable works in its own Git worktree under the
Extalia data folder. It does not edit your checkout. The **Changes** panel in
**Missions** can inspect the worktree and its diff, and can record an integration
proposal. The integration test gate is currently not run by the production
workflow: proposals remain blocked and **Apply** refuses them. Do not treat a
proposal as tested or integrated.

## Where the work happens

- Only a task marked as write-capable (`access: "write"`) can edit files. It
  edits only inside its own worktree, under the Extalia data folder, on a
  branch named `extalia/worker/<id>`. The worktree starts at the commit that was
  current when the task was created.
- Read-only tasks, and missions without write-capable tasks, read your checkout
  as before.
- Workers cannot run commands. Only you can inspect or remove worktrees and
  record a proposal.
- When the task ends, Extalia commits what the worker wrote and marks the
  worktree as released. Until then the panel says
  **Task running: these changes are not final yet.**
- Worker edits appear in the mission journal, Office and timeline as file paths
  only, never as file contents.

## The Changes panel

Open **Missions** and select a mission with write-capable tasks. The panel has
one entry per write-capable task. Each entry shows:

- The branch, and the commit it started from.
- Status chips: commits ahead, commits behind the target, uncommitted changes,
  contained in the target, or integrated.
- A diff summary (files, lines added and removed) and the list of changed
  files. The panel shows the first 50 files. The diff lists at most 2,000.

Click **Refresh changes** to reload the panel.

## Integration proposals are blocked

When a task has ended and its changes are committed, its entry lets you select
a target branch and a test gate command, then record a proposal. The gate
command may be shown in the proposal, but the production integration workflow
does not run it. Host coverage confirms the result is `gate_failed` with
`basis: not_run`; this is not evidence that tests passed.

The proposal can still report merge conflicts, changed files, or a missing
gate. It does not prove the result builds or passes tests.

Each proposal shows one of these results:

| Result | What it means |
| --- | --- |
| Ready to apply | Not currently produced by the production test-gate workflow. |
| Conflict | The test merge stopped on the listed paths. Nothing was resolved automatically, and nothing changed. |
| Test gate failed | The gate did not run (`not_run`), so the proposal cannot be applied. |
| No test gate | No gate was configured; the proposal cannot be applied. |
| Nothing to integrate | The target already contains these changes. |
| Applied | The changes are on the target branch. |
| Stale | The target moved after the proposal, so nothing changed. Propose again. |

## Apply

The UI and host require a **Ready to apply** proposal and matching diff digest.
Current production integration proposals do not pass the test gate, so applying
them is refused. No changes are merged into your target branch.

The implementation's apply checks remain in place for a future supported gate
runner; do not infer that a displayed diff has been integrated.

## Remove a worktree

A released worktree shows **Remove worktree…**.

- If its changes are integrated, or there are none, the worktree folder and its
  branch are removed.
- If it has changes that were not integrated, the confirmation warns that
  removing it discards them. The button then reads **Discard changes**. Extalia
  removes it only while it still matches the fingerprint you were shown. Any
  change after that makes the removal fail.

## Orphaned worktrees

An interrupted host or task can leave worktrees behind. They are listed under
**Orphaned worktrees**, with the reason:

- The task ended without releasing it. You can remove it from the panel.
- Its folder is missing.
- Its folder is not linked to any mission.

Nothing is deleted automatically.

## Git only

Mission changes need a Git repository. Extalia refuses, with a clear message:

- Folders that are not Git repositories.
- Repositories with no commits.
- Submodules.
- Git LFS, and custom filter or merge drivers.

The panel appears only in hosts that support worktrees, such as Desktop and the
local Bridge.

## Where to go next

- [ADR 0028: workspace isolation for write-capable workers](../adr/0028-workspace-isolation-for-write-capable-workers.md)
- [Getting started](README.md)
