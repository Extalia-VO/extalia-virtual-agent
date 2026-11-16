# Getting started

For page responsibilities and navigation, see
[Settings, Observe and Import](settings-observe-import.md).

For messages and answers in an already open outside-agent conversation, see
[Observed reply channels and source capabilities](observed-replies.md).

## Guides by module

| Module | Guides |
| --- | --- |
| Native Chat and workspaces | [Orchestration](chat-orchestration.md), [teams](native-teams.md), [model guide](model-selection-guide.md), [prompt suggestions](prompt-suggestions.md), [workspace boundaries](workspace-boundaries.md), [session workspaces](native-session-workspaces.md) |
| Missions and recovery | [Missions](missions.md), [changes/integration](mission-changes.md), [Native core](native-core.md) |
| Skills | [Built-ins](builtin-skills.md), [project skills](project-skills.md), [automatic loading](native-skill-loading.md), [security center](skill-security-center.md), [marketplace](skill-marketplace.md) |
| Knowledge and memory | [Knowledge/Obsidian](knowledge.md), [workspace memory](workspace-memory.md), [automatic learning](automatic-learning.md), [meetings](team-meetings.md) |
| Observed apps | [Settings/Observe/Import](settings-observe-import.md), [messaging](observed-agent-messaging.md), [Codex control](observed-codex-control.md), [replies](observed-replies.md), [handover](cross-agent-handover.md) |

For Office, architecture, packaging and feature limits, use the
[module directory](../modules/README.md).

## Use Extalia

Agents need a host that can reach your files and run commands, so Extalia runs
in one of two ways:

- **Desktop app** (macOS, Windows, Linux): download it from GitHub Releases. It
  checks for updates shortly after it starts. If a newer version is available,
  a dialog shows both versions. Choose **Update and restart** to download it,
  or **Later** to keep working. After an approved download, Extalia waits for
  running agents to finish before a postponable 10-second restart. A normal
  quit does not install an update. You can also check and update under
  **Settings → System**. Automatic installation requires a supported packaged
  build; ad-hoc macOS previews continue to use manual replacement.
- **Web client through the `extalia` command**:

  ```bash
  npm i -g extalia-vo
  extalia
  ```

  This starts a local Bridge on `127.0.0.1` and opens the web UI. Update with
  `extalia update` (it runs `npm i -g extalia-vo@latest --prefer-online`) or the
  "Update and restart" button in the app.

  The matching `@extalia/daemon-*` package is installed automatically. Install
  `extalia-vo`, rather than a daemon package by itself. Keep `-g`: this source
  checkout uses pnpm, and local npm installs into its linked dependency tree can
  fail inside npm with `Cannot read properties of null (reading 'matches')`.

Use the current [GitHub release](https://github.com/Extalia-VO/extalia-virtual-agent/releases)
for Desktop downloads. The old v0.4.109 macOS DMG had an invalid ad-hoc signature;
it is historical and should not be reused. The v0.4.288 free macOS preview has
verified ad-hoc signatures, remains unnotarized and may require manual opening
approval through **System Settings → Privacy & Security → Open Anyway**.
These previews use manual replacement updates. See [macOS release modes](../release/packaging.md#macos-release-modes).

Desktop and the Web Bridge share one profile and only one may own it at a time.
If Desktop reports `Extalia is already running (Bridge, process ...)`, stop the
`extalia` command in its terminal with Ctrl+C before opening Desktop. The recovery
panel's **Try again** retries host startup once the other process has closed.
For a separate development profile, set `EXTALIA_HOME` to a new temporary folder
before `pnpm dev:desktop`; it will have its own setup and sessions.

On first start a short setup asks for:

1. **A model connection**: choose **Extalia Native** for the primary API/local
   setup path, then select OpenAI, Anthropic, OpenRouter, 9Router, OmniRoute,
   Ollama or any OpenAI-compatible endpoint, with its API key (kept in your OS
   credential store) or an environment variable. Choose who provides memory and
   skills: Extalia, the provider where it has its own (OmniRoute), or off.
2. **A workspace** (optional during setup): select the project folder with
   **Choose folder**, or skip and add it from the first Chat or Settings later.
   Desktop uses a native folder dialog; Web browses folders on the Bridge
   computer. File edits require approval by default; Native commands remain
   unavailable until a verified isolated executor exists.

For a local connection, select the matching preset and check its API base URL.
Ollama defaults to `http://localhost:11434/v1` and needs no key; 9Router and
OmniRoute allow an optional key. Use **Custom** for another OpenAI-compatible
router or an authenticated Ollama proxy. Use the service's actual API base path;
Extalia preserves it rather than adding `/v1` automatically. The existing named
preset is **OmniRoute**; an OmniRouter service can use Custom with its own URL.
Run **Test connection**, then choose or enter the intended model. Catalog success
checks discovery, not whether every listed model can run tools or process images.
Hermes Agent is an optional runtime with its own configuration.

After setup, you land in the **3D Office** in the same application, and every later
launch opens there too, after a short start screen (the last-used workspace is kept).
**Chat** (with your sessions), Files, Git, History and Settings are one click away in
the sidebar; while the Office is open, its floor tabs (Campus, F1–F3, All floors) and
lights (Auto, On, Off) sit in the top bar. The campus and furnished F1, F2 and F3
views use the same sessions as Chat. Selecting a character opens its conversation
inside Office; managed primary characters accept prompts there, and workers show
their reported activity in the parent session. Observed
sessions show observation status, without claiming their native agent is running.
**Appearance** in a character's panel changes its hair, clothing, accessories and
walking style, with feminine, masculine and neutral presets. Walking, doors,
chairs and cross-floor transit are implemented; sustained crowd/performance
acceptance remains scoped in the [Office module](../modules/office.md).

Open Chat and describe the task. The agent reads and searches the project,
asks before edits when required, and reports every step. Native terminal commands
are currently unavailable until a workspace-isolated executor is verified. When the
connection uses Extalia memory, [workspace recall](workspace-memory.md) starts
with a small catalog and searches/reads selected notes on demand.

[Native teams](native-teams.md) can run independent workers with different saved
connections and ordered model fallbacks, then return their results to the lead.
[Chat orchestration](chat-orchestration.md) adds persistent setup and active/inactive
controls beside the composer, with relevant skill/memory previews before Native turns.
An optional shared [Model selection guide](model-selection-guide.md) informs future
team and automatic mission plans; without one, the lead uses its own knowledge.

### Projects, sessions and Diagnostics

Register a project through Setup, the first Chat, or **Settings → Workspaces**.
Desktop offers a native folder picker; Web offers authenticated host-folder
browsing and also accepts a path checked by the Bridge. In Chat,
select a workspace to see only that project's sessions. Saved sessions persist across
host restarts; sessions marked **Not saved** are intentionally kept in memory only.

Native workspaces support multiple selected folders and [workspace boundaries](workspace-boundaries.md):
isolated, read-only sharing (default), or read/write sharing when both workspaces permit it.
Native terminal commands and integration test gates remain unavailable until an isolated executor is verified.

To change Hermes/Extalia Native or the model connection, edit the workspace in
**Settings → Workspaces** and save it. This changes the default for new sessions.
An existing conversation keeps its runtime, Hermes profile or Native connection
and its history. Chat explains a differing default and offers **Start session
with workspace default**; that action prepares a new conversation while keeping
your typed prompt. Merely adding/editing a connection does not reassign other
workspaces, and skipping the workspace step in setup leaves a saved workspace
unchanged. Existing session model/permission controls follow that session's own
target, including when opened from Office.

The Diagnostics folder picker is a temporary access check and does not register a
workspace. A browser picker returns a display name, not the full host path. Opening
only `pnpm dev` runs the static web UI and reports **Needs Extalia Bridge** for agent
features. Use Desktop or the Bridge command below to access projects and sessions.
Commands, Git inspection and credential management may be provided **Through agent
host** rather than through separate renderer APIs. Update checks also depend on the
installation type and release configuration; development Desktop builds cannot install
release updates.

Git can inspect repositories inside a registered workspace. Open **Git**, choose
the workspace, then choose a **Repository** when several are found. Paths in the
changed-file list and diffs are relative to that repository. **Refresh** rescans
for newly added repositories. Discovery searches at most six directory levels,
2,000 folders or 100 repositories, with a five-second budget; generated folders
and symbolic links are skipped. If discovery reaches a limit, register a folder
closer to the repository as another workspace. Git inspection stays read-only.

### Is Python required?

Ordinary Native Chat, the local Bridge and the Desktop shell do not require a
user-installed Python interpreter. Node/Electron hosts the app; a bundled Rust
daemon supplies scoped Native services. Supported macOS 14+ ARM64 packages
include a pinned Python/SkillSpector bundle for supervised skill inspection.
That specific worker is not a general Python coding executor, and unsupported
scanner platforms remain unavailable. See [Skills](../modules/skills.md) and
[platform limits](../modules/platform-release.md). Native history imports use
the Node parsers; Hermes SQLite history needs Node.js 22.13 or newer.

If a workspace uses Hermes Agent, follow Hermes' installation requirements separately.
Extalia launches the installed `hermes` executable. Likewise, project
commands that run Python use the interpreter selected by that project. Installing Python
for project commands is an optional runtime/project concern; it does not replace
the pinned scanner environment.

### Try it without an API key

`tooling/mock-provider.mjs` is a scripted OpenAI-compatible endpoint that plays
a tiny agent (it creates `hello.txt` and shows it):

```bash
node tooling/mock-provider.mjs --port 4319
```

In setup choose **Custom endpoint**, base URL `http://127.0.0.1:4319/v1`, model
`mock-agent`, no key.

## Develop Extalia

Requirements: Node.js 22.13 or newer (Node 23 needs 23.4+) (`.node-version` pins 26), pnpm 12
(`corepack enable` picks the version from `package.json`), Git. No account, API
key or private file is needed.

```bash
git clone https://github.com/Extalia-VO/extalia-virtual-agent.git
cd extalia-virtual-agent
pnpm install
pnpm dev            # Web UI only, at http://127.0.0.1:5180 (no agent host)
pnpm dev:desktop    # Desktop shell with the agent host
pnpm build && node apps/cli/dist/extalia.mjs start   # Web UI through the Bridge
```

The first Desktop start downloads the Electron binary once (Electron fetches it
on first run rather than during install). Extalia keeps its data in
`~/.extalia-vo` (`%USERPROFILE%\.extalia-vo` on Windows), shared by the Web
client and Desktop. Use `EXTALIA_HOME=/tmp/extalia-dev` to keep development
data apart from your own; `EXTALIA_SECRET_STORE=file` avoids the OS keychain
while testing.

## Checks

```bash
pnpm check          # lint, boundaries, public safety, typecheck, tests, build, versions
pnpm test           # unit and integration tests
pnpm test:desktop   # Electron smoke test (needs a display; use xvfb-run on Linux)
```

## Where to go next

- [Guides by module and current feature limits](../modules/README.md)
- [Requirements: implemented and remaining work](../product/README.md)

- [Architecture overview](../architecture/overview.md)
- [Runtimes, providers and observed agents](../architecture/runtime-adapters.md)
- [Contributing](../../CONTRIBUTING.md)
- [Roadmap](../wiki/Roadmap-and-Phases.md)

## Reset Extalia without deleting projects

Quit Desktop and stop the Bridge first. Removing the active `~/.extalia-vo`
folder resets setup, settings, saved chats, workspace registrations and
import/observation records on the next start. `EXTALIA_HOME` selects another
active folder when set. Project files stay wherever you saved them; clearing
Extalia's profile does not delete them or the source histories of other agents.
Browser UI caches cannot refill a new profile. See
[storage locations and exceptions](../architecture/storage.md).

## Files and folders

Open **Files** to browse the selected workspace in a grid or list. A single click
selects a file or folder and opens its information panel on the right. File
contents and image thumbnails are never loaded by this page.

Double-click a folder to enter it. You can also focus the folder and press Enter,
or select it and use **Open folder** in the details panel on a touch screen.
Breadcrumbs and the parent-folder button navigate back. Navigation clears the
previous selection; Refresh reloads the directory metadata.

Details include the name, type, workspace-relative location, regular-file size
when available, and credential, generated-item or symbolic-link markers. Folder
sizes are not calculated. Unavailable links remain inspectable but cannot be
opened, and credential folders cannot be entered.
