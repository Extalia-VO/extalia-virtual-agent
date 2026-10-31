<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/extalia-logo-dark.png">
    <img src="docs/brand/extalia-logo-light.png" alt="Extalia Virtual Agent" width="460">
  </picture>
</p>

# Extalia

<p align="center">
  <a href="https://github.com/Extalia-VO/extalia-virtual-agent/releases/tag/v0.4.157"><img src="https://img.shields.io/badge/release-v0.4.157--beta-blue.svg?style=flat-square" alt="Release"></a>
  <a href="https://github.com/Extalia-VO/extalia-virtual-agent/actions"><img src="https://github.com/Extalia-VO/extalia-virtual-agent/actions/workflows/ci.yml/badge.svg" alt="CI Status"></a>
  <a href="https://github.com/Extalia-VO/extalia-virtual-agent/stargazers"><img src="https://img.shields.io/github/stars/Extalia-VO/extalia-virtual-agent?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/Extalia-VO/extalia-virtual-agent/network/members"><img src="https://img.shields.io/github/forks/Extalia-VO/extalia-virtual-agent?style=flat-square&color=blue" alt="Forks"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg?style=flat-square" alt="Node.js">
  <img src="https://img.shields.io/badge/rust-2024%20edition-orange.svg?style=flat-square" alt="Rust">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg?style=flat-square" alt="Platforms">
</p>

> **Next-gen spatial workspace & mission control for autonomous AI agents.**  
> Extalia turns invisible autonomous AI agent workflows into a **living 3D virtual office** while giving engineers conventional views (Chat, Console, Tasks, Files, Git, Terminal, and Memory) for real development.

> **Status: beta (v0.4.157).** Native Chat and subagent teams, agent-app observation, shared Desktop/Web UI, a furnished 3D campus, built-in skill guidance, progressive workspace memory and an Obsidian-compatible graph are available. The opt-in Rust core adds durable planning and recovery evidence. Production SkillSpector/Python workers, complete effect-time ACLs and automatic learning activation remain unfinished; see the [PRD tracker](docs/product/prd-app-flow-and-live-agents.md#11-status-tracker).

---

## 💡 Why Extalia?

Most AI coding agents work in a black-box terminal. Extalia combines deep autonomous engineering with real spatial observability:

- 🏢 **Living 3D Virtual Office & Campus**: Watch agents navigate floors, ride glass elevators, collaborate at team pods, and physically visit the Floor 1 Library when learning or curating skills.
- 🤖 **Multi-Engine Freedom**: Drive autonomous teams with Extalia Native and Hermes Agent, or non-intrusively observe your existing CLI tools (Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity).
- 🔀 **Heterogeneous Model Routing**: Assign distinct models per role (e.g. Claude Opus for principal architecture, Sonnet for backend/frontend, GPT-4o/Gemini Flash for QA & linting).
- ⚡ **Rust Control Plane**: A bundled stdio sidecar (`extalia-daemon`) with SQLite WAL checkpointing, leases, heartbeats and retained recovery evidence; unresolved work is not treated as safely finished.
- 🧠 **Skills & Knowledge**: Built-in recall and concise-response guidance, bounded workspace memory and a 3D Obsidian-compatible graph with folder/tag/time filters. Explicit prompt learning creates a quarantined candidate, not an automatically activated skill.
- 🔒 **Local-First Privacy**: Credentials use the configured local secret store; sensitive text is masked during supported ingestion and export paths. Agent actions retain their configured permissions.

---

## 📸 Preview

### Living 3D Virtual Office & Campus Architecture
![Extalia 3D Campus Building Architecture](docs/images/campus-building.png)

### Interactive Floor Workspaces & Autonomous Workforce
![Extalia Interactive Floor Workspaces](docs/images/floor-workspace.png)

### In-Scene Prompt Dock & Agent Steering

Extalia provides dual interaction modes directly inside the 3D office viewport:

#### 1. Managed Mode (Interactive Steering & Team Orchestration)
Direct conversational steering with in-scene composer, runtime switching, model routing, file attachments, and multi-agent team oversight:
![In-Scene Prompt Dock - Managed Mode](docs/images/prompt-native.png)

#### 2. Observed Mode (External Agent Observability & Context Tracking)
Non-intrusive monitoring of outside agents (Claude Code, Codex, Hermes) with real-time transcript streaming, command logs, and live context window tracking:
![In-Scene Agent Inspection - Observed Mode](docs/images/prompt-observe.png)

### Multi-Floor Team Pods & Navigation
![Multi-Floor Workforce and Team Pods](docs/images/teams.png)

### Subagent Team Planning & Delegation
| Subagent Role Orchestration | Delegated Multi-Agent Execution |
| :---: | :---: |
| ![Subagent Planning](docs/images/subagent.png) | ![Delegated Execution](docs/images/deligated.png) |

---

## 🌟 Highlights

- **Spatial Agent Observability:** Visualizes agent and subagent execution states in real time within a living 3D virtual office (Three.js / React Three Fiber).
- **Task-Based Spatial Movement:** Characters navigate the 3D campus and reflect reported work, with desks, shared facilities and knowledge activity shown in the office.
- **Autonomous Multi-Agent Orchestration:** Native DAG task scheduling with bounded concurrency, model routing across heterogeneous providers, and team role delegation.
- **Runtime & Provider Agnostic:** Fully decoupled from specific AI runtimes. Supports Hermes Agent, Codex, Claude Code, Gemini / Antigravity, and custom models via runtime adapters.
- **Consent-Based Agent Connections:** Preview hook changes, approve them and keep backups/undo for supported agent apps; startup does not silently edit another application's configuration.
- **Normalized Event Protocol:** All UI views and spatial scenes communicate strictly through versioned, serializable events via the **Extalia Protocol**.
- **Rust Control Plane Sidecar:** Bundled `extalia-core` SQLite WAL store and `extalia-daemon` stdio sidecar for authoritative mission recovery and task leases.
- **Multi-View Workspace:** Seamlessly switch between 3D Office, Chat, Agent Console, Task DAG, File Inspector, Git Diff, Terminal, and Activity Logs.
- **Historical Session Importer:** Discovers and ingests historical sessions from major agent frameworks into an open, portable session format.
- **Local-First Storage:** Session state stays on this computer. Provider requests use your configured model service; credential masks reduce accidental disclosure in supported histories and exports.

---

## 📥 Downloads (Beta Tester Preview)

You can launch Extalia instantly via npm (Node.js 22.13+ on the 22.x line, or 23.4+ on newer releases):

```bash
npm install -g extalia-vo@latest
extalia
```

Pre-built desktop installers and standalone packages are available on the [Extalia v0.4.157 Release](https://github.com/Extalia-VO/extalia-virtual-agent/releases/tag/v0.4.157):

| Platform | Package | Architecture | Direct Download |
| :--- | :--- | :--- | :--- |
| **macOS** | Disk Image (DMG) | Apple Silicon (arm64) | [Extalia-0.4.157-mac-arm64.dmg](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-mac-arm64.dmg) · [ZIP](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-mac-arm64.zip) |
| **macOS** | Disk Image (DMG) | Intel (x64) | [Extalia-0.4.157-mac-x64.dmg](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-mac-x64.dmg) · [ZIP](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-mac-x64.zip) |
| **Linux** | Universal AppImage | x64 | [Extalia-0.4.157-linux-x86_64.AppImage](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-linux-x86_64.AppImage) |
| **Linux** | Debian / Ubuntu Package | x64 | [Extalia-0.4.157-linux-amd64.deb](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-linux-amd64.deb) |
| **Windows** | Desktop installer | x64 | [Extalia-0.4.157-win-x64-setup.exe](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/Extalia-0.4.157-win-x64-setup.exe) |
| **Web** | Static Web Client | Universal | [extalia-web-0.4.157.zip](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/extalia-web-0.4.157.zip) |
| **CLI** | Local Web Bridge | Universal | [extalia-vo-0.4.157.tgz](https://github.com/Extalia-VO/extalia-virtual-agent/releases/download/v0.4.157/extalia-vo-0.4.157.tgz) |

Free macOS previews use verified ad-hoc signatures and are **not Apple-notarized**.
They may show an unidentified-developer warning. If you trust the official
download, use **System Settings → Privacy & Security → Open Anyway** after the
first launch attempt; previews update by manual download. See
[macOS release modes](docs/release/packaging.md#macos-release-modes).

Check downloaded files against **SHA256SUMS.txt** on the release page. The static
Web ZIP contains the client; running agents still requires the local Bridge or
Desktop host. npm installs the Bridge, client and matching daemon together.

The bundled GLB inventory is about **660 MiB before archive compression**, so
downloads and first-time asset loading can take time. Source code is MIT;
third-party scene assets have their own licenses, including five non-commercial
vehicles. The commercial-assets switch changes runtime selection, not packaged
files. Read the [asset notices](apps/web/public-assets/THIRD_PARTY_NOTICES.md)
before reuse or commercial distribution.

The opt-in Rust store upgrades through schema 12. Older binaries cannot open a
newer schema; retain a backup of your local profile before attempting a downgrade.

---

## 🔌 Two Ways to Work with Agents

| Managed sessions | Observed sessions |
| --- | --- |
| Extalia drives an agent **runtime** such as Hermes Agent. The runtime uses the **provider or router** you choose (OpenAI-compatible endpoints, 9Router, OmniRouter, Ollama, …). You prompt and steer from Extalia. | Agents keep running in **their own apps** (Codex, Claude Code, Gemini CLI, Antigravity). Extalia reads their session logs read-only, receives events from hooks installed once with your approval (`extalia connect`), and visualizes the work. Prompting stays in the agent's app. |

Both modes emit the same Extalia Protocol events, so every view and the office treat them alike. See [Runtimes, providers and observed agents](docs/architecture/runtime-adapters.md).

### Connect Your Outside Agents in One Command

```bash
extalia connect hermes --dry-run
extalia connect claude --dry-run
extalia connect codex --dry-run
extalia connect gemini --dry-run
extalia connect antigravity --dry-run
```

Review the proposed changes, then run the chosen command with `--yes` to apply
them. The connector reports its backup and undo command. See
[connection safety](docs/architecture/agent-app-connections.md).

---

## 🏗 System Architecture

Extalia enforces complete separation between agent runtimes and visualization layers:

```text
AI Runtime / Provider (Hermes, Codex, Claude, Gemini)
                      ↓
               Runtime Adapter
                      ↓
        Extalia Protocol (Normalized Events)
                      ↓
         Session / Task / Agent State Store
                      ↓
  UI Suite (3D Office | Chat | Console | Tasks | Terminal)
```

The 3D office never imports runtime-specific code or vendor dependencies directly.

---

## 🚀 Quick Start

### Install the Web app

Requires Node.js 22.13+ (Node 23 needs 23.4+). Install the application from npm:

```bash
npm install -g extalia-vo@latest
extalia
```

The command opens the Web app at `http://127.0.0.1:4310/`. Its platform daemon
is installed automatically; installing `@extalia/daemon-*` alone does not install
the application. Keep `-g` when installing Extalia; a local npm install into this
pnpm checkout can fail inside npm's dependency resolver.

### Develop from Source

Requires Node.js 22.13+ (Node 23 needs 23.4+) and pnpm 12 (`corepack enable`). No account, API key, or private file is needed.

```bash
git clone https://github.com/Extalia-VO/extalia-virtual-agent.git
cd extalia-virtual-agent
pnpm install
pnpm dev            # Web client at http://127.0.0.1:5180
pnpm dev:desktop    # Desktop shell (Electron)
pnpm check          # lint, boundaries, public-safety scan, typecheck, tests, build
```

What works today:

- **An agent with only an API key or router**: Extalia Native reads, searches and edits your project and runs commands with your approval, through OpenAI, Anthropic, OpenRouter, 9Router, OmniRoute, Ollama or any OpenAI-compatible endpoint.
- **Orchestration** (on by default): the agent hands read-only research to worker agents on Complex / Standard / Quick models you choose.
- **Memory and skills** per connection: Extalia's own, the provider's (OmniRoute), or off; nine built-in skills plus your own.
- **Native history import** from Codex, Claude Code, Hermes Agent and Gemini CLI, read-only, with preview.
- **Continue in Extalia**: when Codex or Claude Code runs out of quota, continue an imported or observed conversation in a new Extalia session; the original request and recent messages are carried over and the source is never changed.
- **History per connection**: turn session history off for a connection and its new sessions stay in memory only.
- **Live agent-app hooks and MCP server**: one-step connection via `extalia connect` (Codex, Claude Code, Gemini CLI, Hermes, and Antigravity) with zero-config auto-connect on startup; loopback stdio JSON-RPC MCP server (`extalia mcp`) for intent and handoff reporting.
- **Desktop** (auto-update from GitHub Releases) and **Web** through `npm i -g extalia-vo` → `extalia` (updates through npm).
- **One profile for Web and Desktop** in `~/.extalia-vo` (`%USERPROFILE%\.extalia-vo` on Windows; `EXTALIA_HOME` overrides it): connections, workspaces, sessions and interface preferences. Data from the folder used up to 0.0.20 is copied there once; the old folder is kept.
- **Extalia Protocol v0** with strict validation, English and Indonesian UI, light, dark (Royal Charcoal) and liquid-glass themes.

More in [Getting started](docs/getting-started/README.md) and the [documentation index](docs/README.md).

---

## 📂 Monorepo Structure

Target layout from the PRD. Today the repository contains 10 workspace packages and a Rust Cargo workspace (`crates/extalia-core`, `crates/extalia-daemon`):

```text
extalia/
├── apps/
│   ├── desktop/            # Desktop application shell (macOS, Windows, Linux)
│   ├── web/                # Standalone Web client and Three.js / R3F office UI
│   └── cli/                # Terminal CLI, local bridge launcher, and MCP server
│
├── packages/
│   ├── core/               # Domain models, state machines, and business logic
│   ├── protocol/           # Normalized event schemas, JSON schemas, types, and validators
│   ├── platform/           # Platform capability contracts (filesystem, terminal, git)
│   ├── host/               # Local agent host, session storage, and hook ingest
│   ├── runtime/            # Runtime adapter interfaces, provider loops, and delegation
│   ├── importers/          # Session discovery, parsers, and secret redaction
│   └── office/             # Spatial room semantics, resource registry, and lighting
│
├── crates/
│   ├── extalia-core/       # Rust control plane, SQLite store, and mission journal
│   └── extalia-daemon/     # Stdio sidecar daemon wire contract v1
│
├── docs/                   # Architectural specs, Master PRD v1.1, and ADRs
└── tooling/                # Verification, code safety, and build scripts
```

---

## 🗺 Roadmap & Milestones

Development is tracked across iterative public milestones aligned with Master PRD v1.1 & v2:

- **✓ v0.1.0-alpha: Public Foundation & Vertical Slice** *(Completed)*
  Monorepo boundaries, cross-platform CI matrix, Extalia Protocol v0, and a managed runtime adapter.
- **✓ v0.2.0-alpha: Workspaces & Session Hub** *(Completed)*
  Profile manager, workspace repository linking, persistent multi-session store, and unified sidebar.
- **✓ v0.3.0-beta: Import Center & Agent Console** *(Completed)*
  Historical session importers (Codex, Claude, Hermes), secret redaction scanner, non-3D Agent Console, and terminal/git observability.
- **🚀 v0.4.0-beta: Subagents & Project Orchestration** *(Active Milestone)*
  Subagent lifecycle manager, dynamic 3D office seating, task-based spatial dispatch, dual-mode prompt dock, and multi-agent coordination.
- **🔮 v0.5.0-beta: Durable Control & Knowledge Vault** *(Under Development)*
  Durable planner/worker ownership, effect-time permissions and knowledge access. Current builds include bounded graph views and fail-closed skill quarantine; production scanner/Python workers and complete ACL enforcement remain open.
- **🔮 v0.6.0-beta: Evolve & Autonomous Learning** *(Under Development)*
  Experience capture, disposable sandbox evaluation in git worktrees, hybrid learning activation, and Evolve Learning Center.
- **🎯 v1.0.0-ga: Extension SDK & Production Release**
  Public Extension SDK, signed cross-platform desktop installers (macOS, Windows, Linux), and community plugin registry.

---

## 🔒 Security & Privacy

1. **Workspace Boundary:** Filesystem read/write operations outside designated project roots are denied by default.
2. **Secret Redaction:** Credential scanning masks API keys and auth tokens before they are stored in session histories or exports.
3. **Declared Capabilities:** Plugins and skills must declare explicit capability manifests before gaining system access.
4. **Consent for Connections:** Connecting an agent app shows a dry run, requires approval, backs up its configuration, and can be undone.

See [Security model](docs/architecture/security.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

---

## 🤝 Contributing

We welcome community contributions! Please review [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) before submitting pull requests.

All commits follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(scope): ...`
- `fix(scope): ...`
- `docs(scope): ...`
- `refactor(scope): ...`
- `test(scope): ...`

---

## 📄 License

Extalia is open-source software licensed under the [MIT License](LICENSE). The Righteous typeface outlines used in the logo are licensed under the [SIL Open Font License 1.1](apps/web/public/fonts/Righteous-OFL.txt).
Bundled 3D assets retain the separate licenses in the [public asset inventory](apps/web/public-assets/README.md); the MIT code license does not relicense them.
