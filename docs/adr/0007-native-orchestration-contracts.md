# ADR 0007: Additive native orchestration contracts

Status: Accepted (2026-10-17)

## Context

The v1 planning pack proposes missions, heterogeneous workers, durable scheduling,
scoped approvals and learning. The working repository already has a TypeScript
native runtime, managed/observed sessions, Electron, and `extalia.v0` events.
Replacing these together would obscure regressions and invalidate existing data.

## Decision

Start with pure, versioned wire contracts in `@extalia/protocol`. Keep runtime
policy, registry ownership, scheduling and state transitions in core/runtime/host
when their stages begin. Wire types are transport data, not an execution engine.
Retain the existing v0 parser and event producers/consumers unchanged. New
contracts must be explicitly adopted by future callers; validation does not imply
that a capability, approval, budget or durable lease is enforced at runtime.

Keep Electron and the TypeScript runtime. Native orchestration has no dependency
on the optional external runtime integration. Introduce neither Rust nor Python
as a prerequisite. Do not introduce persistence migrations in this stage.

## Consequences and open decisions

- Existing UI, observations, session files and Office behavior remain compatible.
- Stage 2 must map current events to the new mission truth explicitly; no second
  competing event stream may silently become authoritative.
- Stage 3 must decide transactional journal ownership, migration/recovery rules,
  canonical monotonic sequence and parameter-digest canonicalization before
  side-effecting execution. These remain unresolved; schemas alone do not solve them.
- Provider certification requires actual provider evidence. No credentials or
  external application configuration changes are needed for contract tests.
- Target hardware and benchmark methodology remain open before performance gates.

See [implementation ledger](../product/native-orchestration-v1-handoff.md).
