# ADR 0051: Knowledge independently of the mission backend

- Status: Accepted
- Date: 2026-11-06

## Context

The default TypeScript mission backend omitted Knowledge and vault-setting APIs.
The web shell probed status during startup and removed the menu when unsupported.
Users could not find Knowledge or connect an Obsidian folder without changing an
unrelated preview backend setting.

## Decision

Expose Knowledge, note-editing and vault-setting APIs for both mission backends.
One lazy DaemonSidecar owns Knowledge and recorded Rust recovery. Only new saved
missions and the skill registry follow the native-core preference. Opening the
Knowledge page starts its index service; ordinary navigation discovery does not.
Persisted planning recovery may still need that same process during host startup.
The watcher activates after Knowledge use, rather than merely because recovery
or a mission started the sidecar.

Keep Knowledge visible for agent-capable hosts. Old hosts and unavailable local
index binaries produce actionable page states; refresh rereads status but cannot
repair a missing binary. Updating and restarting the host is the recovery path.
Show the shared vault controls directly on the page as well as in Settings.

A synchronous vault-switch gate excludes new mission/planning admission and
recovery inspections. Running preparation, global persisted unresolved planning
and mission records, and in-flight registry operations refuse the restart.
Configuration changes inside the Knowledge write/sync queue, after earlier writes
drain, with a final lifetime check immediately before persistence. New note writes
are refused during the switch; earlier queued writes retain the previous root.
The UI clears its per-vault reads and editor on a successful folder change and
ignores asynchronous completions after host/page replacement. An open draft or
active sync disables inline switching. Folder-save feedback does not assert that
index rebuilding succeeded.

## Consequences

No new daemon protocol or duplicated process/store is introduced. TypeScript
mission policy and legacy registry mode stay unchanged. Packaged Desktop/Bridge
installations need a working daemon binary for Knowledge; unavailable operation
is explicit rather than simulated. Tests use temporary profiles and synthetic
vaults, including Obsidian markers, never a real home or external app settings.
