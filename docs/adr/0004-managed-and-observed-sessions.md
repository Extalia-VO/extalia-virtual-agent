# ADR 0004: Managed and observed sessions share one protocol

Status: Accepted

## Context

Users want two things from Extalia:

1. Run agents from Extalia: Extalia drives a runtime such as Hermes Agent,
   which uses a provider or router (for example 9Router or OmniRouter).
2. Watch agents that run in their own apps (Codex, Claude Code, Gemini CLI,
   Antigravity) and see that work in the office, without changing how those
   apps are used.

The prototypes supported both, through different code paths.

## Decision

- Both modes emit Extalia Protocol events. `session.started.control` is
  `managed` or `observed`; `source.channel` records how each event arrived.
- Managed sessions come from runtime adapters (`stream`). Providers and
  routers are configured inside the runtime, not treated as runtimes.
- Observed sessions combine read-only transcript reading (`transcript`),
  hooks installed once by `extalia connect` with consent and backups (`hook`),
  and optional MCP reporting by the agent (`mcp`). Instructions to the agent
  are a supplement, never the only source.
- Observed sessions are read-only in Extalia. Continuing them from Extalia
  means a new managed session seeded with context, or an explicit, supported
  resume mechanism.

## Consequences

- The office and every view handle both modes with the same code.
- The UI must disable prompting and steering for observed sessions.
- Each observer and adapter declares the native versions it was verified with.

Details: [runtime-adapters.md](../architecture/runtime-adapters.md).
