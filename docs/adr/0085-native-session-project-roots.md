# 0085: Registered project folders for saved Native sessions

Status: Accepted

## Decision

Native Chat presents workspace → registered project folder → saved session.
A saved Native session may select one of its workspace's existing primary or
additional project roots through `setSessionProjectRoot`. The optional persisted
`projectLocation` override selects its actual next-turn working directory;
legacy sessions continue using the workspace primary root. Observed and Hermes
sessions retain their existing ownership and do not gain this capability.

Drag-and-drop is confined to folders in the same workspace. It carries a
session/workspace identity, which both the current UI snapshot and the host
validate. Keyboard and touch users have the same folder choice in session
settings. Cross-workspace transfer stays in the existing reviewed move flow:
preview current grants, explicitly confirm, then apply an opaque expiring review.
An actual workspace transfer clears the folder override to the destination
primary root; reviewing the current workspace preserves its chosen root.

## Host boundary and execution

Selection changes only the relative-path base within already registered grants.
The host checks Native saved-session ownership, the expected workspace, exact
registered root membership, folder availability, protected data and idle queue,
run, mission, context and ownership settlement. Configuration changes and stale
record writes are rejected. No arbitrary subfolder, additional grant, file copy,
new session or conversation replay is created by dropping a row.

Execution snapshots reorder only the current workspace's existing roots, making
the selected folder primary for Chat tools, instructions, delegation, missions
and worktrees. They retain the original workspace policy, memory namespace,
Knowledge/vault binding and approved skill scope. A selected root that becomes
unavailable or unregistered causes execution to fail rather than silently use a
different project. Workspace-level skill review remains attached to the
registered primary root; selecting a folder does not approve new skills.

## History and previews

Session IDs, provider connection, team, events and messages remain unchanged.
Historical file-root cutoffs retain each segment's original folder. The browser
allows historical previews only while the corresponding workspace root remains
registered. Relative preview API paths continue using the workspace primary;
secondary-root requests use absolute registered paths. The host retains own-root,
credential, symlink, hardlink, protected-data and preview limits for these reads.

## Verification

Temporary-host/provider tests verify persisted root selection and actual relative
file reads/writes, selected-root instructions, mission and delegated execution,
unchanged history and scope cutoffs, stale/uncertain admission and protected-path
rejection. Browser checks exercise real folder drag/drop, refused cross-workspace
drops, explicit reviewed transfer, restart retention and phone settings controls.
