# Application storage and profile reset

Current implementation: v0.4.289. Extalia-owned settings, workspace metadata and
saved conversations use **one active profile root** shared by Desktop and the
Web Bridge. User project folders are independent of that profile.

## Root selection

| Platform | Default root |
| --- | --- |
| macOS / Linux | `~/.extalia-vo` |
| Windows | `%USERPROFILE%\.extalia-vo` |

`EXTALIA_HOME` explicitly selects a different root. Host API callers can pass a
`dataDirectory` (tests use temporary directories). The effective absolute folder
is reported by `getState().dataDirectory` and `getState().storage.dataDirectory`;
check the displayed data folder when an installation appears to use different
settings. Desktop's Chromium profile and updater use that same resolved root.
Only one host owns a root at a time.

## Persistence inventory

Paths below are relative to the active root. These are stores, not additional
independent user profiles.

| Data | Location |
| --- | --- |
| Setup, connections, registered workspace paths/defaults and teams | `config/extalia.json` |
| Display name, theme, language, font, surface and sidebar | `config/profile.json` → `preferences` |
| Last workspace, Office lights, approval notification choice and Earlier panel | `config/profile.json` → `clientState` |
| Shared model guide | `config/` |
| Saved managed sessions, model history and event logs | `sessions/` |
| Imported/linked session library | `state/library.json` |
| Observation registry, discovery opt-ins and private transcript snapshots | `state/observations.json`, `state/observer-discovery.json`, `state/observed/` |
| Mission checkpoints and host lock | `state/missions.sqlite`, `state/host.lock` |
| Native daemon control store | `state/core.sqlite` |
| Character appearance, queues, continuity and ownership records | `state/` and profile-scoped stores |
| Workspace memory and local skill consent | `workspaces/` |
| User skill revisions, scanner inputs/reports, learning/index/marketplace state | `skills/`, `profiles/`, `state/` and `cache/` as owned by their service |
| Default Markdown vaults | `vaults/<profile>/` |
| Pending attachments and temporary managed artifacts | `attachments/` and `cache/` |
| Isolated mission worker checkouts | `worktrees/` |
| Desktop Chromium profile, session storage and GPU/browser cache | `desktop-profile/` |
| Desktop logs and crash dumps | `desktop-profile/logs/`, `desktop-profile/crashDumps/` |
| Packaged updater download staging | `cache/updates/` (with updater-specific child directories) |

The Web browser has its own origin storage. `extalia.ui.v1` and the other
`extalia.*` UI keys are disposable display mirrors, not independent settings or
session stores. Once a host is available, `getProfile()` is authoritative;
missing values use defaults, never stale browser values. Supported client state
changes save to `config/profile.json`. A new host instance forces rehydration
on reconnect even if the browser tab keeps the same API object. A temporary
profile-read failure holds writes until a successful retry; it is not treated
as an empty profile. Hostless static
Web retains device-local display settings and cannot run or restore agent sessions.
Resolved solar appearance is a derived first-paint cache, not a saved user grant.

## Project files and explicit outside sources

A registered **project can be anywhere the user chooses**. Source files, builds,
exports selected by the user and project-local instructions/skills stay there.
Only its registered path, permissions, team defaults, session references and
Extalia memory belong in the profile. Removing the profile does not delete those
project files. Unapplied worker changes inside `worktrees/` are profile data.

These additional outside locations have distinct owners:

- Codex/Claude/Gemini/Hermes histories and configuration belong to their source
  apps. Observe/import reads selected histories; connection changes require the
  existing explicit preview, approval, backup and undo flow. Extalia's indexes,
  snapshots, tokens and connection backup records live inside its profile.
- A user-selected external Obsidian/Markdown vault remains at its chosen path.
  Its folder setting and derived index live in Extalia; clearing the profile
  does not erase the user's external notes.
- Provider secrets may use the OS Keychain/Secret Service. Credential references
  live in `config/extalia.json`; the private fallback store, when selected, is
  `state/secrets.json`. Deleting the profile does not erase OS credential items
  or environment variables, and cannot recreate deleted connection references.
- Installed application binaries, user-selected downloads/exports and temporary
  installer/smoke directories are not persistent settings stores. Package-manager
  caches belong to npm/pnpm or the OS, not to Extalia's session library.

## Clean start

1. Quit Desktop and stop the Web Bridge; close/reload clients after restarting.
2. Remove the **active root** (the default above unless explicitly overridden).
3. Start Extalia again. Setup is incomplete, connections/workspaces/saved sessions
   and imported/observed records are empty, and interface choices use defaults.

Startup no longer copies from retired pre-0.0.21 application-data locations.
The migration helper is retained only for explicit compatibility tooling; it is
not called by normal startup. Old Desktop profiles are not copied into a fresh
root. External history may still be listed by a deliberate new source scan; it
is not restored into the session library or watched without fresh opt-in.

Deleting a root while its host is running is not a supported live reset: a process
can still own open files and in-memory work. Always stop it before removing data.
This update does not delete, inspect or relocate an actual user's profile.

## Source and verification

- Root/layout: [dataDirectory.ts](../../packages/platform/src/dataDirectory.ts),
  [paths.ts](../../packages/host/src/paths.ts), [service.ts](../../packages/host/src/service.ts).
- Settings: [profile.ts](../../packages/host/src/profile.ts),
  [profileSync.ts](../../apps/web/src/profileSync.ts),
  [profileClientState.ts](../../apps/web/src/profileClientState.ts).
- Desktop: [profilePaths.ts](../../apps/desktop/src/profilePaths.ts),
  [main.ts](../../apps/desktop/src/main.ts),
  [updaterStorage.ts](../../apps/desktop/src/updaterStorage.ts).
- Temporary-home reset coverage: [profileReset.test.ts](../../packages/host/test/profileReset.test.ts)
  exercises configured Bridge/Desktop hosts, Native chat, imported/observed
  sessions, source opt-ins, root removal and two fresh boots while preserving
  project files and external history. Settings and late-binding cases are in
  [profileClientState.test.ts](../../apps/web/test/profileClientState.test.ts)
  and [profile.test.ts](../../packages/host/test/profile.test.ts).

Local verification (2026-11-12): 88 focused tests, mounted React browser reset /
same-API reconnect / transient-read retry, full `pnpm check` (9,219 TypeScript
passed, 58 prerequisite-dependent skips, 576 Rust passed) and isolated Desktop
smoke all passed. Actual updater/provider/HTTP executor classes were exercised
against a synthetic Electron boundary; payload requests were refused before any
external download. This is local evidence, not published installers or a fresh
Windows/Linux device certification.
