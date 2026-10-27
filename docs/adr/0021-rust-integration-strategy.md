# ADR 0021: Rust integration strategy

Status: Accepted (2026-10-21; the owner accepted the recommended option).

## Context

Patch v1.1.1 settles PRD §16 item 2: Rust becomes the control plane, introduced behind
contracts without a rewrite. The repository has no Rust today; the TypeScript kernel
(`packages/runtime/src/mission.ts`) and host persistence (`packages/host/src/mission*.ts`)
already implement ADRs 0008–0015 with tests. ADR 0007 said Rust is not a prerequisite;
this ADR supersedes that sentence for the control plane only. Gap-map decision 5 asks
about toolchain pinning and `pnpm check`. See the [audit](../implementation/REPO_AUDIT.md).

## Options considered

| Topic | Options | Trade-offs |
| --- | --- | --- |
| Migration style | **Strangler behind `AgentHostApi`** vs big-bang port | Strangler keeps the UI, Bridge and Desktop untouched and allows a flag-off rollback; big-bang invalidates tested semantics |
| Crate layout | **`extalia-core` (lib) + `extalia-daemon` (bin)** vs one crate vs many crates | Two crates separate domain from process concerns; more crates only when build time/ownership justify it (blueprint §3) |
| Contracts | **Generate JSON Schema from `@extalia/protocol`**, Rust types hand-written or generated, shared fixtures vs a new `packages/contracts` vs Rust-first schemas | `@extalia/protocol` is already the versioned source (ADR 0007), with hand-written validators and no schema library; a second package would duplicate it. Rust codegen from JSON Schema can follow once schemas settle |
| Toolchain | **`rust-toolchain.toml` pinned to an exact stable release** vs floating stable | Reproducible builds and clippy results vs a manual bump. Edition 2024 needs Rust 1.85 or newer |
| `pnpm check` | **Run cargo checks when `crates/` exists** vs CI only | Same gate locally and in CI vs a contributor prerequisite and longer checks |
| Packaging | **Prebuilt per-OS binary in Desktop `extraResources`** vs building at install | Matches the current electron-builder model (no `node_modules` shipped); per-target CI builds needed |

## Recommended decision

1. **Strangler:** the daemon sits behind `AgentHostApi`; the host becomes its client per
   mission behind a flag (default off). Rust ports proven semantics (ADR 0013 checkpoint
   transactions, ADR 0014 event atomicity/idempotency/latch, ADR 0015 accounting,
   `policy.ts` decisions) and proves them with **parity tests**: the same fixtures and host
   test suites run against both backends.
2. **Layout:** root virtual `Cargo.toml` workspace with `crates/extalia-core` and
   `crates/extalia-daemon`; `extalia-core` starts with `domain/{task,event,approval}`,
   `ports/event_store`, `adapters/sqlite`, `security/permissions` only. Domain does not
   import SQLite, IPC or serde-specific transport types. Tokio, serde, thiserror/anyhow and
   tracing as in blueprint §2, each justified in the PR that adds it.
3. **Contracts:** `tooling/generate-schemas.mjs` emits JSON Schema from `@extalia/protocol`
   into `packages/protocol/schemas/`; golden fixtures under `packages/protocol/test/fixtures/`
   are read by Vitest and `cargo test`; a drift check fails `pnpm check`.
4. **Toolchain:** `rust-toolchain.toml` with an exact stable version plus `rustfmt` and
   `clippy`; `tooling/check-rust.mjs` runs `cargo fmt --check`, `cargo clippy -- -D warnings`
   and `cargo test --locked` and is added to `pnpm check` and CI on all three OSes.
   `check-versions`/`bump-version` also cover the crates' versions (lockstep).
5. **Build/packaging:** CI builds `aarch64-apple-darwin` and `x86_64-apple-darwin` (the
   release ships both macOS arches), `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`
   (glibc floor to be stated); the binary goes into `extraResources` and is signed with the
   app on macOS (exact electron-builder configuration to be verified in the packaging PR); a
   packaged smoke test starts it. The CLI (`extalia-vo`) ships the same binary through
   per-platform optional npm packages selected by `os`/`cpu`, so `npm install` brings it with
   no Rust toolchain. Owner requirement (2026-10-21): installers are self-contained — end users
   never install Rust, Python, Node or npm; only contributors need the toolchains.
6. **Benchmark gate:** before the flag becomes default, publish TS-baseline vs daemon
   measurements (commit latency p50/p95, cold start, idle RSS/CPU, restart recovery, binary
   size) with hardware, OS, build SHA and method. Thresholds are set by the owner; nothing is
   claimed without measurement.

## Consequences

- Contributors need a Rust toolchain once crates land (if decision 5 says so); CI time grows.
- Two implementations of the same semantics exist until cutover; parity tests are the cost
  of a safe rollback.
- ADR 0014 needs an amendment for asynchronous acknowledgement (ADR 0020).

## Open questions for the owner

1. Gap-map decision 5: cargo in local `pnpm check` (mandatory) or CI-only with a local skip?
2. Linux glibc floor / musl, and whether Windows arm64 or Linux arm64 are in scope.
3. ~~CLI binary distribution~~ — decided: per-platform optional npm packages.
4. Benchmark thresholds and reference hardware.
