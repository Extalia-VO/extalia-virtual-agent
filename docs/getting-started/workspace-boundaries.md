# Native workspace folders and access

Open **Settings → Workspaces** and create or edit an Extalia Native workspace.
Choose its primary project folder and, optionally, up to fifteen additional
folders. Relative file paths use the primary folder; the agent can discover the
other permitted folders with `workspace_folders` and use their absolute paths.
Folders outside this selected/registered set are unavailable to agent file tools.

Choose **Access between workspaces**:

| Mode | Other workspaces | Access into this workspace |
| --- | --- | --- |
| Isolated | Cannot read or edit them | Other workspaces cannot read or edit it |
| Read only (default) | May read permitted folders, cannot edit them | Others may read, cannot edit |
| Read and edit | May read and edit when the other workspace permits it | Others still need compatible permission |

The stricter setting on either side wins. Cross-workspace edits require both
workspaces to select read and edit, and normal edit approvals still apply.
Older workspaces without an explicit setting use read only. Hermes and observed
agent apps retain their own controls; these settings enforce Extalia Native
file-tool access only.

The selected folders form this workspace's own scope, so normal edit permissions
still apply there. A nested folder registered to an isolated workspace remains
protected even when its parent is selected elsewhere. Conflicting overlapping
registrations can therefore make a folder unavailable; choose distinct folders
if you need independent isolation. Links cannot expand a grant, hard-linked
files are refused, credentials remain unavailable and Extalia's private profile
data is protected. An unavailable registered folder stops admission until fixed.

Native lead agents and subagents inherit the same folder authority. A write
member's narrower scope and forbidden paths also apply to the resolved target.
Mission writers may write only in their owned worktree, even when the source
workspace has cross-write permission. A write mission requires the selected primary
folder to be the repository root with a plain `.git` directory; repositories
containing inaccessible nested workspaces are refused before checkout. Searches and listings omit inaccessible
nested entries rather than exposing their names.

## Commands and test gates

Native terminal commands and integration test gates are **unavailable** until
Extalia has a verified executor that confines files, processes and local control
access. Running a shell in the project folder does not provide that confinement.
The host refuses such commands before launch, including approved commands and
worker commands. Integration proposals with a configured gate remain unready
and record `not_run`; a missing gate still records `gate_missing`.

File reads and edits remain available within the configured grants. The user can
run checks outside the agent separately. This update does not constrain external
applications, the user's own terminal or Hermes processes.

## Context and changes

Permission to read another workspace does not automatically load its chat,
instructions, memory or skills. Automatic instructions come from this project's
primary folder only. External registry skills need a current grant for the exact
workspace before their metadata or body is offered; a profile-wide grant alone
does not supply that scope. Public built-in skills remain shared.

Stop Native work before changing workspace folders, adding/deleting a workspace
or changing cross-workspace access. Settings reserve admission until the change
finishes. Chats with earlier model history require a new session after the
profile's workspace boundaries change, so older context is not replayed under
new grants. Their visible history remains available to the user.

Isolated workspaces use a separate memory area keyed to their selected folders
and isolation setting. Earlier shared memory is retained separately and is not
automatically imported. Isolated planning also omits profile-wide model-guide
text and earlier session-title hints; an isolated chat cannot resume an imported
conversation. Explicit user-provided prompts and attachments are still user
inputs: isolation cannot erase information already copied or sent to a provider.

These are enforced host-tool permissions, not a hostile-process operating-system
sandbox. Final-component no-follow checks and identity checks reduce link races,
but malicious concurrent replacement of parent directories is outside the
current guarantee. Keep project folders under trusted local control.
