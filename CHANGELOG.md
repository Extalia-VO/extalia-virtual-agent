# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

## [Unreleased]

## [0.0.3] - 2026-10-09

### Changed

- Defer the Virtual Office 3D scene to the final integration milestone, after managed and observed agent workflows, imports, session management and desktop/web foundations.

## [0.0.2] - 2026-10-09

### Added

- Extalia Native runtime (`@extalia/runtime`): a provider-neutral agent loop with tool calling, approvals and cancellation; model providers for OpenAI-compatible endpoints (OpenAI, OpenRouter, 9Router, OmniRoute, Ollama, custom) and the Anthropic Messages API through the official SDK, with reasoning blocks replayed unchanged and server-side refusal fallbacks when talking to Anthropic directly.
- Node agent host (`@extalia/host`): workspace-bounded file and command tools, OS credential storage, persistent sessions, per-workspace memory, skills (built-in, user and project), and a single-host lock. Desktop runs it in the main process; the `extalia` command runs it behind the local Bridge.
- Connections with presets and a per-connection choice of who provides memory and skills (Extalia, the provider where it has its own, or off); OmniRoute is asked not to add its memory when Extalia's is used.
- First-run setup and progressive navigation: only pages that work in the current mode are shown.
- Chat with streaming answers, tool cards, live command output and approvals (once, for the session, or deny).
- Desktop auto-update from GitHub Releases (download in the background, restart after a short countdown when no agent is working) and packaging with electron-builder.
- npm distribution of the Web client as `extalia-vo` (`extalia` command) with update checks and `extalia update`.
- `tooling/mock-provider.mjs`, a scripted OpenAI-compatible endpoint for trying the agent without an API key.
- Orchestration, on by default: the agent can hand read-only research and review to worker agents (`delegate_task`), several at once, on per-connection Complex / Standard / Quick models (suggested: Claude Opus / Sonnet / Haiku for Anthropic, Sol / Sol / Luna for OpenAI), with a per-turn delegation limit; workers appear as `subagent.*` events.
- Nine built-in skills (plan-feature, debug-issue, code-review, write-tests, refactor-safely, security-review, commit-changes, update-docs, explain-codebase); user and project skills override them.
- Native history import (`@extalia/importers`): Codex, Claude Code, Hermes Agent (per profile, read-only SQLite) and Gemini CLI, with scan, preview and import into a local library that keeps renames, archive and trash across re-imports; Antigravity conversations are detected but not readable yet.

### Changed

- The logo mark uses the office's green gradient (#10b9ac → #83cb35 → #f8e719).
- Placeholder session views (Office, Console, Tasks, Terminal, Files, Git) are no longer shown until they are implemented.

## [0.0.1] - 2026-10-08

### Added

- Monorepo foundation: `apps/web`, `apps/desktop`, `apps/cli`, `packages/protocol`, `packages/core`, `packages/platform`.
- Extalia Protocol v0: versioned event envelope with session, agent, task, parent and correlation ids; managed/observed session control; event families for conversation, agents and subagents, tools, commands, files, tasks, approvals, Git and meetings; strict validation and JSON Lines parsing.
- Domain core: profiles, workspaces, portable sessions (`extalia.session.v1`), session library with import preview, deduplication by source key, local organization that survives re-imports, linked-session tombstones, credential masking and export.
- Platform capability contracts, Desktop and Web hosts, and platform user-data directories.
- Web shell with English and Indonesian, light and Royal Charcoal dark themes, an optional liquid-glass surface style for both, compact sidebar, Get started, Event log, Diagnostics and Settings pages, and placeholders for upcoming session views.
- Electron Desktop shell with sandboxed renderer, `extalia://app` protocol with Content Security Policy, folder picker and a smoke test.
- `extalia` CLI with `doctor` and `validate`.
- Repository checks for dependency boundaries, public safety and lockstep versions; CI on macOS, Windows and Linux.
- Architecture documentation, ADRs 0001–0004, migration ledger, contribution, governance and security policies.
