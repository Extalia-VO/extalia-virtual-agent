# Knowledge vault context

The Knowledge page has one active context: a workspace, its bound vault profile
and that profile's effective folder. The folder shown to the user must come
from the current host's confirmed catalog. An index label such as
`vaults/<profile>` is not a replacement for the actual folder path.

## Everyday setup

Keep the workspace, vault name and folder together above search and the graph.
Show folder configuration on demand. Counts, indexing progress and Sync belong
to the index status, without repeating the folder configuration. Manage the
full profile catalog and cross-workspace assignments in Settings.

Several workspaces can share a vault. Folder changes must disclose that shared
scope. A failed catalog request or a different host must not retain a previous
host's path as if it were the active destination. Older hosts without scoped
Knowledge must show their limitation rather than silently use the default
vault for a selected workspace.

## Reads and writes

The host resolves a workspace to a registered profile and effective root. The
renderer supplies expectations about that binding, never filesystem authority.
Scoped operations compare the expected binding under host admission before
entering the existing Knowledge queue. A saved note hash alone is insufficient:
two vaults can contain identical paths and bytes.

An editor keeps its draft when an external folder or profile change is noticed.
Its original binding stays attached to the edit, and saving into the changed
context is refused. The user can keep the text and explicitly reopen the new
context. In-flight work retains the existing queue and vault-switch guarantees
from [ADR 0051](../adr/0051-knowledge-independent-of-mission-backend.md).
Saving temporarily freezes the draft and its discard shortcuts. A global view
without a selected workspace remains readable, but does not offer unbound note
mutations or folder changes. Legacy imports list only workspaces assigned to
the selected profile and require a fresh preview for the chosen source.

Managed Native workers retrieve notes through bounded, workspace-scoped
Knowledge search and read tools. Their note content is untrusted reference
material, not instructions or permission. Workspace memory is a separate store;
its connection feature must not silently redirect Knowledge to another folder.
Read-only workers receive no note-writing authority.

Agent-authored meeting minutes and learning notes keep their existing managed
writers, consent, provenance and root-identity checks. User editing methods
continue to write as the user and are not repurposed for agents. Legacy-memory
imports accept only workspaces belonging to the destination vault profile.
The implementation leaves `.obsidian` configuration untouched.

These capabilities describe Extalia-managed Native workers. Observed agent apps
and external runtimes retain their actual capabilities; this change does not
grant them a new general-purpose vault-writing interface.

## Default profile compatibility

The physical default store remains `vaults/default`. An existing host can have
a different semantic default profile ID, and its managed notes retain that ID
in front matter. The host passes that exact ID through the trusted daemon
startup option `--knowledge-profile-alias`; it is accepted only with canonical
`--profile default`. Knowledge requests and model arguments cannot select an
alias. Other scoped profiles retain their own strict visibility rules.

Derived index schema 2 records the accepted alias. Introducing, changing or
removing it rebuilds cached visibility decisions before reads, including notes
whose file bytes and timestamps did not change. Both canonical `default` and
the one configured alias remain readable; unrelated profiles stay hidden.
This updates the derived index rather than migrating profile identities or
rewriting original notes. An older binary that cannot accept the startup
contract fails explicitly instead of silently dropping the alias.

## Acceptance evidence

Use temporary vaults with different sentinel notes and identical-path/hash
fixtures. Verify the page, Native lead and delegated readers resolve the chosen
workspace's vault. Verify managed minutes and learning writes land there, while
the other vault and `.obsidian` markers remain unchanged. Rebind the workspace
or change its root before a stale edit is submitted and require refusal.

Check the normal and unavailable states in English/light and Indonesian/dark,
including a 390-pixel viewport, long folder names and shared-vault information.
Graph selection, note reading, synchronization and editor drafts remain usable.
