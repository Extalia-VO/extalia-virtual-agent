# Platform capabilities

Application code asks for capabilities instead of checking which host it runs
in (PRD §7):

```ts
interface PlatformCapabilities {
  filesystem?: FileSystemCapability;
  terminal?: TerminalCapability;
  git?: GitCapability;
  secureStorage?: SecureStorageCapability;
  notifications?: NotificationCapability;
  updater?: UpdateCapability;
}
```

A missing capability is reported, not emulated. `describeCapabilities()` labels
each one `available`, `requires-bridge` (native features a browser can reach
through the local Extalia Bridge) or `unavailable`; the Diagnostics page shows
the result.

## Hosts

| Host | How capabilities are provided |
| --- | --- |
| Desktop | Electron main process through a preload bridge (`window.extaliaDesktop`) with one audited IPC channel per method |
| Web | Browser APIs where available, with authenticated host-folder browsing through the Bridge |

`apps/web/src/platform.ts` is the composition root and the only place that
checks for the Desktop bridge.

Workspace selection uses the native directory dialog on Desktop. Web uses
`AgentHostApi.browseDirectories` on the Bridge computer; browser directory
handles cannot reveal its absolute paths. The read-only listing contains at
most 200 child directories, omits files and symlinks, and exposes home/parent/root
navigation. `checkFolder` and `saveWorkspace` still validate the final selection
and reject selecting a whole filesystem root as a project.

## Folder selection across operating systems

Desktop uses Electron's parented native directory dialog: the macOS folder
panel, Windows folder chooser or the Linux desktop's dialog/portal. Workspace
primary/additional folders, Knowledge vaults, per-profile vault folders, Skills
imports and the Diagnostics chooser share this capability. Localized titles and
an existing starting directory are presentation hints; invalid starting paths
fall back to the OS home folder. A skill import selects an existing directory.
Cancel, a closed owner window or a late result from a previous workspace/profile
never saves a different selection. Selecting a folder does not bypass host-side
validation, skill scanning, consent or a profile's explicit Save action.

The Bridge uses authenticated host-folder browsing directly for workspace,
Knowledge/profile vault and skill-import choices. It does not open a pathless
browser picker first or guess an absolute path from a browser handle's name.
Standalone browser Diagnostics can still demonstrate the browser picker while
honestly omitting its hidden path. Text input remains an optional advanced path
where offered, rather than the only way to select a custom profile vault.
Linux portal versions before 4 can ignore a native starting-directory hint;
Extalia does not force a GTK/KDE backend or change desktop settings.

## Desktop shell security

- `contextIsolation`, `sandbox` and no Node integration in the renderer.
- The UI is served from the `extalia://app` protocol with a strict Content
  Security Policy; paths that escape the web build are refused.
- IPC handlers accept calls only from the app's own pages.
- The window cannot navigate away; external `https` links open in the user's
  browser.
- A development server URL is accepted only on HTTP loopback.

`pnpm test:desktop` builds the UI and runs `electron . --smoke-test`, which
checks that the bridge exists, Node is not exposed and the shell renders. Smoke
runs use a throwaway profile, data directory and in-memory credential store.

### IPC channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| `extalia:host-info`, `extalia:select-directory` | invoke | Host details, folder picker |
| `extalia:agents` | invoke `(method, args)` | One `AgentHostApi` call; only whitelisted methods, array arguments, trusted senders |
| `extalia:agent-event` | main → renderer | Live Extalia Protocol events |
| `extalia:update` | invoke `(action)` | `status`, `check`, `install`, `postpone` |
| `extalia:update-status` | main → renderer | Update status changes |

Failures travel as `{ ok: false, error }` so the renderer shows a short message.

### Updates

Supported packaged builds check GitHub Releases a few seconds after start.
The user approves a download; after it finishes and no agent turn is running,
a postponable 10-second countdown can restart and install it. A normal quit
does not approve or install an update. Free ad-hoc macOS previews require manual
replacement and do not use the automatic update feed. See
[ADR 0006](../adr/0006-updates-and-packaging.md).

## Agent host

Desktop runs `@extalia/host` in the main process; the `extalia` command runs the
same host behind the local Bridge (`127.0.0.1`, per-launch token, `Host` and
`Origin` checks, Server-Sent Events for live events). Only one host may use a
data directory at a time.

## User data location

`resolveDataDirectory()` returns one profile folder in the user's home and
never hardcodes a user name. Web (through the Bridge) and Desktop share it:

| OS | Location |
| --- | --- |
| macOS, Linux | `~/.extalia-vo` |
| Windows | `%USERPROFILE%\.extalia-vo` |

`EXTALIA_HOME` overrides it (useful for tests). Layout: `config` (connections
and workspaces, no secrets; `profile.json` with the display name and interface
preferences), `sessions` (managed sessions as event logs plus model history),
`workspaces` (per-workspace memory), `skills` (user skills), `state`
(imported-session library, update checks, host lock, file-based credential
fallback), `hooks` and `connect` (agent-app hooks), `cache`. Desktop keeps
Chromium's own profile (cache and local storage) in `desktop-profile/` inside
the same active root. Logs/crash dumps and updater staging also stay under that
root. See the [complete storage inventory and reset rules](storage.md).

### Profile API

`getProfile()` / `saveProfile(patch)` read and merge `config/profile.json`
(`extalia.profile.v1`: `displayName`, `preferences` with `language`, `theme`,
`material`, `font`, `sidebar`). The host validates every field, refuses unknown
ones, re-reads the file before each save and writes it atomically with mode
0600. With a host, the Web client loads the profile at start, applies it and
saves preference changes back (debounced); localStorage only mirrors it so
`boot-appearance.js` can paint the first frame without a theme flash. The
static Web build without a host keeps preferences in localStorage.

`HostState.setupComplete` is true only once the current welcome setup
(`SETUP_VERSION`, now 2) was completed (`completeSetup()` or choosing the
observe workflow writes `setupVersion`). Configurations from older setups run
the welcome setup once more; their connections, workspaces and sessions stay.

### Moving data from 0.0.20 and older

Earlier versions used the application-data folder (macOS
`~/Library/Application Support/Extalia`, Windows `%APPDATA%\Extalia`, Linux
`$XDG_DATA_HOME/extalia` or `~/.local/share/extalia`). When a host starts (or
`extalia connect` runs) with the default folder, no `config/extalia.json` there
and an old folder present, it copies the old folder once:

- Only Extalia's folders are copied (`config`, `profiles`, `workspaces`,
  `sessions`, `state`, `skills`, `hooks`, `connect`); `cache`, the host lock,
  the hook endpoint file, temporary files and symbolic links are skipped. Modes
  (0600/0700) and modification times are kept and no file in the new folder is
  overwritten. `config/extalia.json` is copied last with an atomic rename, so an
  interrupted copy is completed on the next start.
- A lock file in the new folder makes a Bridge and a Desktop that start
  together migrate only once.
- `state/migrated-from.json` (`{ from, at }`) records the copy; nothing in the
  old folder is moved or deleted. A `MIGRATED_TO_EXTALIA_VO.txt` note is left
  there, and its `hooks/forward.mjs` becomes a small shim that runs the
  forwarder in the new folder, so hooks connected earlier keep reporting.
  Connected apps show a hint to run `extalia connect <app>`, which points the
  hooks to the new folder. Backup paths in the copied connect manifest are
  rewritten to the new folder, so `extalia disconnect` keeps working.
- An explicit `EXTALIA_HOME` is never migrated into. `extalia doctor` shows the
  old folder and whether it was copied.

## Native mission API

Native sessions can run bounded, read-only task graphs through the shared host
API. Workspace connection authorization, per-connection credentials, cancellation
and retained results stay host-owned. See [native missions](native-missions.md)
and [ADR 0009](../adr/0009-native-missions-in-session-host.md).
