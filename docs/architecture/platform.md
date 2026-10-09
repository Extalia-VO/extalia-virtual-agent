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
| Web | Browser APIs where they exist (for example the directory picker); native features later through the Bridge |

`apps/web/src/platform.ts` is the composition root and the only place that
checks for the Desktop bridge.

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

Packaged builds check GitHub Releases a few seconds after start, download in
the background and, when no agent turn is running, restart after a 10-second
countdown that can be postponed (the update then installs on quit). See
[ADR 0006](../adr/0006-updates-and-packaging.md).

## Agent host

Desktop runs `@extalia/host` in the main process; the `extalia` command runs the
same host behind the local Bridge (`127.0.0.1`, per-launch token, `Host` and
`Origin` checks, Server-Sent Events for live events). Only one host may use a
data directory at a time.

## User data location

`resolveDataDirectory()` picks the platform location and never hardcodes a
user name:

| OS | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Extalia` |
| Windows | `%APPDATA%\Extalia` |
| Linux | `$XDG_DATA_HOME/extalia` or `~/.local/share/extalia` |

`EXTALIA_HOME` overrides it (useful for tests). Layout: `config` (connections
and workspaces, no secrets), `sessions` (managed sessions as event logs plus
model history), `workspaces` (per-workspace memory), `skills` (user skills),
`state` (imported-session library, update checks, host lock, file-based
credential fallback), `cache`. Packaged Desktop keeps Chromium's own profile in
a separate `Extalia Desktop` folder.
