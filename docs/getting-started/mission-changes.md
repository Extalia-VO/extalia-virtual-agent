# Mission changes

A task in a mission that can write files works in its own copy of your project,
a Git worktree. It never edits your checkout. The **Changes** panel in
**Missions** shows each of those copies, lets you propose merging its work into
a branch after your test command runs, and applies the merge only after you
confirm it.

## Where the work happens

- Only a task marked as write-capable (`access: "write"`) can edit files. It
  edits only inside its own worktree, under your Extalia data folder, on a
  branch named `extalia/worker/<id>`. The worktree starts at the commit that was
  current when the task was created.
- Read-only tasks, and missions without write-capable tasks, read your checkout
  as before.
- Workers cannot run commands. Agents cannot propose, apply or remove worktrees.
  Only you can.
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

## Propose an integration

When a task has ended and its changes are committed, its entry shows a form:

1. **Target branch** is the branch to merge into. It starts as the worktree's
   base branch.
2. **Test gate command** is the command that tests the merge. It starts as
   `npm test`. Change it to the command your project uses.
3. Click **Propose integration**.

Extalia merges the worker's branch onto the target's current tip in a disposable
integration worktree, then runs your command there. The command runs without a
shell and without credentials. A model cannot choose it. If the gate field is
empty, only the merge is tested, and the proposal cannot be applied.

Each proposal shows one of these results:

| Result | What it means |
| --- | --- |
| Ready to apply | The merge was clean and the test gate passed. |
| Conflict | The test merge stopped on the listed paths. Nothing was resolved automatically, and nothing changed. |
| Test gate failed | The gate failed, so the proposal cannot be applied. The panel shows the exit code and a log excerpt. |
| No test gate | No gate ran, so the proposal cannot be applied. Propose again with a gate command. |
| Nothing to integrate | The target already contains these changes. |
| Applied | The changes are on the target branch. |
| Stale | The target moved after the proposal, so nothing changed. Propose again. |

## Apply

Only a proposal that is **Ready to apply** shows **Apply…**. The confirmation
shows its diff digest. Click **Apply** to send exactly that digest. Extalia
applies the proposal only while the changes still match it.

Applying moves the target branch to the tested merge commit. It is never forced,
and it is never pushed.

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
