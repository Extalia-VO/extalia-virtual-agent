# Extalia

> **Open-Source Spatial AI-Agent Workspace and Orchestration Platform**

Extalia provides a unified workspace where developers can prompt, steer, orchestrate, and observe autonomous AI agents through both conventional engineering views (Chat, Console, Tasks, Files, Git, Terminal, and Logs) and an interactive 3D virtual office.

> **Status: pre-alpha.** Working today: the Extalia Native agent (API key or router), orchestration, native history import, and the Desktop and Web clients. The previews come from the existing Virtual Office. Its 3D integration stays the final product milestone, after the agent workflows, imports, session management and desktop/web foundations are ready.

---

## 📸 Preview

### Spatial 3D Virtual Office & Campus
![Extalia Virtual Office Campus](docs/images/preview-campus.webp)

### Floor Plan & Live Autonomous Workforce
![Floor 1 Workforce & Shared Facilities](docs/images/preview-floor1.png)

### Agent Inspection & Spatial Context
| Avatar & Desk Activity Inspection | Non-3D Agent Console & Execution Timeline |
| :---: | :---: |
| ![Avatar Interaction](docs/images/preview-avatar-inspect.webp) | ![Agent Console](docs/images/preview-console.webp) |

---

## 🌟 Highlights

- **Spatial Agent Observability:** Visualizes agent and subagent execution states in real time within a living 3D virtual office (Three.js / React Three Fiber).
- **Runtime & Provider Agnostic:** Fully decoupled from specific AI runtimes. Supports Hermes Agent, Codex, Claude Code, Gemini / Antigravity, and custom models via runtime adapters.
- **Normalized Event Protocol:** All UI views and spatial scenes communicate strictly through versioned, serializable events via the **Extalia Protocol**.
- **Multi-View Workspace:** Seamlessly switch between 3D Office, Chat, Agent Console, Task DAG, File Inspector, Git Diff, Terminal, and Activity Logs.
- **Historical Session Importer:** Discovers and ingests historical sessions from major agent frameworks into an open, portable session format.
- **Local-First & Zero Credential Leakage:** Credentials, sensitive environment tokens, and private repositories remain strictly local. Credential detection masks secrets during ingestion and export.

---

## 🔌 Two Ways to Work with Agents

| Managed sessions | Observed sessions |
| --- | --- |
| Extalia drives an agent **runtime** such as Hermes Agent. The runtime uses the **provider or router** you choose (OpenAI-compatible endpoints, 9Router, OmniRouter, Ollama, …). You prompt and steer from Extalia. | Agents keep running in **their own apps** (Codex, Claude Code, Gemini CLI, Antigravity). Extalia reads their session logs read-only, receives events from hooks installed once with your approval (`extalia connect`), and visualizes the work. Prompting stays in the agent's app. |

Both modes emit the same Extalia Protocol events, so every view and the office treat them alike. See [Runtimes, providers and observed agents](docs/architecture/runtime-adapters.md).

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

Requires Node.js 22.12+ and pnpm 12 (`corepack enable`). No account, API key, or private file is needed.

```bash
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
- **Desktop** (auto-update from GitHub Releases) and **Web** through `npm i -g extalia-vo` → `extalia` (updates through npm).
- **Extalia Protocol v0** with strict validation, English and Indonesian UI, light, dark (Royal Charcoal) and liquid-glass themes.

More in [Getting started](docs/getting-started/README.md) and the [documentation index](docs/README.md).

---

## 📂 Monorepo Structure

Target layout from the PRD. Packages are added when their phase starts; today the repository contains `apps/web`, `apps/desktop`, `apps/cli`, `packages/protocol`, `packages/core`, and `packages/platform`.

```text
extalia/
├── apps/
│   ├── desktop/            # Desktop application shell (macOS, Windows, Linux)
│   ├── web/                # Standalone Web application
│   └── cli/                # Terminal CLI and local bridge launcher
│
├── packages/
│   ├── core/               # Domain models, state machines, and business logic
│   ├── protocol/           # Normalized event schemas, types, and validators
│   ├── runtime/            # Runtime adapter interfaces and contracts
│   ├── event-bus/          # High-performance pub/sub event bus
│   ├── platform/           # Platform abstraction contracts (filesystem, terminal, git)
│   ├── workspace/          # Workspace management and repository linking
│   ├── sessions/           # Multi-session SQLite store and persistence
│   ├── renderer/           # Three.js / React Three Fiber spatial engine
│   ├── office/             # Room semantics, lighting, and spatial desk allocation
│   ├── avatars/            # Kinematics, avatar animations, and state transitions
│   ├── ui/                 # Design system components and shared UI primitives
│   ├── console/            # Agent Console, tool timeline, and steering controls
│   ├── importer-core/      # Session parsers, fingerprinting, and deduplication
│   └── sdk/                # Public Extension SDK
│
├── docs/                   # Architectural specs, PRD, and ADRs
└── scripts/                # Setup and automation scripts
```

---

## 🗺 Roadmap & Milestones

Development is tracked across iterative public milestones:

- **v0.1.0-alpha: Public Foundation & Vertical Slice**
  Monorepo boundaries, cross-platform CI matrix, Extalia Protocol v0, and a managed runtime adapter.
- **v0.2.0-alpha: Workspaces & Session Hub**
  Profile manager, workspace repository linking, persistent multi-session store, and unified sidebar.
- **v0.3.0-beta: Import Center & Agent Console**
  Historical session importers (Codex, Claude, Hermes), secret redaction scanner, non-3D Agent Console, and terminal/git observability.
- **v0.4.0-beta: Subagents & Project Orchestration**
  Subagent lifecycle, dynamic office seating, declarative skill registry, project DAG planning, and Obsidian knowledge synchronization.
- **Final integration milestone: Virtual Office**
  Bring in the completed Virtual Office scene and connect it to the stable session, runtime and presence contracts.
- **v1.0.0-ga: Extension SDK & Production Release**
  Public Extension SDK, signed cross-platform desktop installers (macOS, Windows, Linux), and community plugin registry after the final office integration.

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
