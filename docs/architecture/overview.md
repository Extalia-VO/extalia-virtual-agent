# Architecture overview

Extalia is a spatial agent workspace: users prompt, supervise and observe AI
agents through conventional views (Chat, Console, Tasks, Terminal, Files, Git,
Logs) and through a 3D office. Every view reads the same session state.

```text
Runtime / agent app
      ↓
Runtime adapter (managed) · Observer (transcript, hook, MCP)
      ↓
Extalia Protocol events (@extalia/protocol)
      ↓
Session, task and agent state (@extalia/core)
      ↓
Views: Chat · Console · Tasks · Terminal · Files · Git · Logs · Office
```

Two rules protect this structure (PRD §47):

- **The Office must keep working if any runtime disappears.** Renderer and UI
  code never import a runtime, provider or adapter; they consume protocol
  events and core state only.
- **Personal setups are configuration, not code.** Names, rosters, rooms and
  integrations are user data. Core never special-cases them.

## Repository layout

```text
apps/
  web/        React client; also the renderer UI loaded by Desktop
  desktop/    Electron shell: secure window, app protocol, preload bridge
  cli/        `extalia` command: local Bridge, updates, diagnostics and validation
packages/
  protocol/   Extalia Protocol v0: event types and validation (no dependencies)
  core/       Domain model: profiles, workspaces, session library, portable
              sessions, privacy rules
  platform/   Platform capability contracts and data-directory resolution
  runtime/    Extalia Native agent loop, delegation, provider adapters and the Hermes Agent stream mapping
  host/       Node host: files, commands, credentials, Hermes Agent processes, imports and selected transcript observation
  importers/  Pure native-history parsers
  office/     Pure spatial presence contracts; the shared Web/Desktop scene lives in apps/web/src/office
tooling/      Repository checks: boundaries, public safety, versions
docs/         Architecture, ADRs, migration ledger, release notes
```

More packages from the PRD's proposed monorepo (renderer, avatars,
adapters, knowledge, …) are added
when their phase starts, each with a boundary rule in
`tooling/check-boundaries.mjs`.

Setup, Settings, Chat and Office run in the same application shell. The Office
renderer is loaded on demand from the same web build served by the Bridge and
packaged by Desktop. It receives host session summaries and protocol events;
it never launches a separate agent host or connects directly to a provider.
The campus geometry is adapted from the existing Virtual Office. Detailed
interiors and advanced avatar navigation remain later scene milestones.

## Dependency direction

```text
protocol ← core ← platform ← apps (web, desktop, cli)
```

- `protocol`, `core` and `platform` contain no UI framework, renderer, Electron
  or Node built-ins; they run anywhere.
- Packages never depend on apps.
- Apps reach native features only through platform capabilities
  ([platform.md](platform.md)); only the composition root decides which host
  it runs in.

`pnpm lint` enforces these rules.

## Further reading

- [Protocol](protocol.md)
- [Runtimes, providers and observed agents](runtime-adapters.md)
- [Sessions and the session library](sessions.md)
- [Platform capabilities](platform.md)
- [Security model](security.md)
- [Architecture decision records](../adr/README.md)
