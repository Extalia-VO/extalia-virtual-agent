# Repository audit for PRD patch v1.1.1 (phase 0, read only)

| | |
| --- | --- |
| Status | Drafted 2026-10-21, awaiting owner acceptance. No production code, tests, manifests or configs were changed by this audit |
| Repository | Version 0.0.76 (root `package.json`), working tree on top of HEAD `5c67478` with ~550 uncommitted paths from earlier work (facts below describe the working tree, not HEAD) |
| Mandate | [v1.1.1 handoff](../product/master-prd-v1.1/implementation-handoff-v1.1.1.md), [technical blueprint](../product/master-prd-v1.1/technical-blueprint-v1.1.1.md), [gap map §4–§5](../product/prd-v1.1-gap-map.md#5-patch-v111-technical-implementation) |
| Decisions drafted | [ADR 0019](../adr/0019-sqlite-driver-and-database-ownership.md) SQLite · [0020](../adr/0020-daemon-ipc-transport.md) IPC · [0021](../adr/0021-rust-integration-strategy.md) Rust · [0022](../adr/0022-python-worker-distribution.md) Python · [0023](../adr/0023-skill-scanner-adapter-pinning.md) scanner (all Proposed) |

**Inspected:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`,
`.node-version`, `.github/workflows/{ci,release}.yml`, `tooling/*.mjs`; every workspace manifest;
`apps/desktop/{src/main,preload,ipc,agentsIpc,security}.ts`, `build.mjs`, `electron-builder.yml`;
`apps/cli/src/{start,bridge/server}.ts`; `apps/web/src/*` folder inventory; `packages/protocol/src/*`;
`packages/platform/src/agentHost.ts`; `packages/runtime/src/{mission,policy,providers/index}.ts`;
`packages/host/src/{service,mission,missionCheckpoints,nativeImport,lock,paths,secrets,skills,hooks/http}.ts`;
ADRs 0005, 0007, 0013–0015, 0018; the [orchestration ledger](../product/native-orchestration-v1-handoff.md).
Commands: read-only file inspection, `node -e` probe of `node:sqlite` (local Node 26.12.0 opens a
database without an experimental warning, SQLite 3.54.0). No `pnpm check` was run for this audit
(documentation only; another change is in progress in `packages/host`).

## 1. Repository facts

| Area | Fact (source) |
| --- | --- |
| Toolchain | pnpm 12.7.0 workspace `apps/*`, `packages/*`; Node `^22.13.0 \|\| >=23.4.0` (root and `apps/cli` `engines`); CI uses `.node-version` = 26; TypeScript ~6.0, Vitest 5, ESLint 10. No Rust, no `Cargo.toml`, no Python project (only Blender asset scripts in `tooling/`) |
| Packages (src lines, rough) | `protocol` ~1.0k · `core` ~2.3k · `platform` ~1.8k · `runtime` ~2.6k · `host` ~12.2k · `importers` ~1.0k · `office` ~0.6k · `apps/cli` ~1.5k · `apps/desktop` ~1.0k · `apps/web` ~49.6k (of which `office/` ~35k). `packages/renderer` is two empty folders without a `package.json` (not a workspace package) |
| Dependency direction | Enforced by `tooling/check-boundaries.mjs`: `protocol ← core ← platform`; `runtime` (protocol, core); `host` (all packages, no UI/Electron); `web` (no Electron, no `node:`); every workspace package must have a rule |
| Contracts | `@extalia/protocol`: `extalia.v0` events (`events.ts`, `validate.ts`) and additive orchestration v1 types with hand-written strict validators (`orchestration.ts`, `orchestrationValidate.ts`, `ORCHESTRATION_SCHEMA_VERSION = 1`). No JSON Schema files and no schema library dependency |
| Host API | `AgentHostApi` + `AGENT_HOST_METHODS` (62 forwarded methods + `subscribe`) in `packages/platform/src/agentHost.ts`; implemented by `createAgentHost` (`packages/host/src/service.ts`, 1.65k lines) |
| Desktop | Electron ~44.7 main process runs the host in-process (`agentsIpc.ts`). Window: `contextIsolation`, `sandbox`, no `nodeIntegration`; preload exposes one `DesktopHostApi` via `contextBridge`; one audited channel list (`ipc.ts`); sender URL checked per call (`security.ts`). Custom `app://` scheme with CSP |
| Desktop packaging | esbuild bundles `main.cjs`/`preload.cjs` (only `electron` external); electron-builder 26 ships `dist/**` without `node_modules`, web build as `extraResources`; macOS dmg+zip arm64+x64 (hardened runtime), Windows NSIS x64, Linux AppImage+deb x64; GitHub draft releases on `v*` tags (`release.yml`) |
| CLI Bridge | npm package `extalia-vo` (bin `extalia`, `files: dist`). `bridge/server.ts`: HTTP + SSE on 127.0.0.1, per-launch 64-hex token (constant-time compare), Host allow-list, Origin check, JSON-only bodies, 1 MiB body limit, bounded SSE backlog. Routes `/api/call`, `/api/events`, `/api/update*`, `/api/hooks/:app` |
| Hook ingest | Separate loopback listener (default port 4317, `hooks/http.ts`): bearer token or Hermes HMAC, rate limit, always "no decision" (ADR 0018 proposed) |
| SQLite | `node:sqlite` `DatabaseSync` opened in exactly one writer place: `MissionCheckpointStore` (`packages/host/src/missionCheckpoints.ts`) at `<data>/state/missions.sqlite`; WAL, `synchronous=FULL`, foreign keys, busy timeout 1 s, `user_version` 2 (schema 1→2 migration in code; 3 since 2026-10-22 for running totals), `STRICT` tables, **exact schema verification** (object count and SQL must match) and `integrity_check` on open. Read-only use in `nativeImport.ts` (Hermes `state.db`, lazily imported) |
| Persistence elsewhere | JSON/JSONL via `jsonStore.ts` (atomic writes): config, sessions + v0 event logs, library, appearances, profile. Data root `~/.extalia-vo` (`EXTALIA_HOME` overrides), private 0700/0600 (`paths.ts`) |
| Single writer | `lock.ts`: one host per data directory (`desktop` or `bridge`, pid + start time), acquired before the mission store opens and released after it closes |
| Durable mission semantics | ADR 0013 (checkpoint + change row per transaction, caps, tombstones, sidecar import), ADR 0014 (control event + checkpoint atomic, per-mission sequence, idempotent duplicate, failure latch), ADR 0015 (budget/usage in the same commit). Runtime contract: `commitEvent(...)` in `packages/runtime/src/mission.ts` is **synchronous and must never return a promise** |
| Providers | TypeScript (`packages/runtime/src/providers/{openai,anthropic}.ts`, `createProvider`), secret passed in per call, never stored |
| Secrets | `packages/host/src/secrets.ts`: macOS Keychain via `/usr/bin/security`, Linux Secret Service via `secret-tool`, otherwise a private file `<data>/state/secrets.json` (Windows has no OS-store adapter today) |
| Permissions/approvals | `packages/runtime/src/policy.ts` `decide(access, workspacePermissions, sessionGrants, mode)` → allow/ask/deny; session grants in RAM; one pending approval per run resolved by `resolveApproval` (`service.ts`). Protocol `Approval`/`Permission` types exist without enforcement (ADR 0007) |
| Skills | `packages/host/src/skills.ts`: built-in + user + workspace `.extalia/skills/*/SKILL.md`, 256 KiB cap, no symlinks from workspaces, whole catalog in one `skill_read` tool; no scan, hash or quarantine (gap map FR-16; W0 containment is being changed concurrently, not audited here) |
| Observers | `packages/host/src/{observations,transcriptEvents,hooks/*,connect/*}.ts`, `packages/importers`: Codex, Claude Code, Gemini CLI, Hermes, Antigravity detection; read-only by default |
| Tests | 184 `*.test.ts` files (~1.4k `it`/`test` calls) under `packages/*/test` and `apps/*/test`; one root Vitest config. `pnpm check` = lint (ESLint + boundaries + public safety) → typecheck → test → build → `check-versions` → `check-character-hair`. CI runs lint/typecheck/test/build/versions on Ubuntu, macOS, Windows plus an Ubuntu Desktop smoke test; it does not run `check-character-hair` |
| Versions | Lockstep: `check-versions.mjs`/`bump-version.mjs` only know workspace `package.json` files and `CHANGELOG.md` |

## 2. Blueprint path map

| Blueprint target | Repository module | Verdict |
| --- | --- | --- |
| `packages/contracts/` | `packages/protocol/src/*` | **EXTEND** `@extalia/protocol`; add generated `schemas/*.json` + shared fixtures there. No second contracts package (ADR 0021) |
| `packages/sdk/` | — | **DEFER** to W8 (FR-13) |
| `crates/extalia-core/` | TS equivalents: `runtime/src/mission.ts`, `runtime/src/policy.ts`, `host/src/missionCheckpoints.ts`, `host/src/mission.ts` | **CREATE** minimal (slice A: `domain/{task,event,approval}`, `ports/event_store`, `adapters/sqlite`, `security/permissions`); other modules DEFER |
| `crates/extalia-daemon/` | Host process role today: `apps/desktop/src/agentsIpc.ts`, `apps/cli/src/start.ts` | **CREATE** sidecar binary (ADR 0020) |
| `core/.../orchestrator/*` | `runtime/src/mission.ts` (DAG scheduler, budgets) | **DEFER** to phase 3; Rust ports proven ADR 0008–0015 semantics, does not invent new ones |
| `core/.../adapters/providers` | `runtime/src/providers/*` | **KEEP** in TypeScript behind a port; moving them needs its own ADR |
| `core/.../skills/*`, `security/attestation` | `host/src/skills.ts`, `builtinSkills.ts` | **DEFER** to W3; W0 stays TypeScript |
| `core/.../knowledge/*` | `host/src/memory.ts` (flat Markdown notes) | **DEFER** to W5 |
| `workers/intelligence/` | — | **DEFER** until W3 and the scanner pin are confirmed (ADR 0022, 0023); then CREATE with protocol + scanner only |
| `migrations/` | Inline SQL in `missionCheckpoints.ts` (TS-owned) | **CREATE** `crates/extalia-core/migrations/` (crate-local, embedded at build); TS schema stays inline until cutover (ADR 0019) |
| `tests/contracts` | `packages/protocol/test/*` | **EXTEND** + **CREATE** `packages/protocol/test/fixtures/` consumed by Vitest and `cargo test` |
| `tests/integration` | `packages/host/test/mission*.test.ts`, `apps/*/test` | **KEEP**; Rust integration tests live in `crates/*/tests/` |
| `tests/security` | Scattered (`files`, `hooks`, desktop `security` tests) | **DEFER** to W3 (skill gate tests next to the code) |
| `tests/performance` | — (no benchmark harness; ledger: nothing measured) | **CREATE** in the benchmark PR (`tooling/bench/`), not a top-level `tests/` |
| `tests/fixtures` | Per-package `test/helpers.ts` | **CREATE** only the shared contract fixtures above |
| `apps/web/src/features/*` | Flat feature folders `apps/web/src/{office,missions,approvals,chat,library,setup,pages,…}` (there is no `features/` folder) | **KEEP**; new `skills/`, `knowledge/`, `learning/` become siblings, no move |
| `docs/{adr,architecture,implementation,operations}` | `docs/adr`, `docs/architecture` exist | `implementation/` **CREATE** (this file); `operations/` **DEFER** |

## 3. KEEP

| Path / module | Reason | Blueprint item |
| --- | --- | --- |
| `apps/desktop/src/{main,preload,ipc,security}.ts` | Secure Electron baseline already matches the blueprint (context isolation, sandbox, single `contextBridge` API, sender checks) | §1.1 Electron, §2 Desktop |
| `apps/cli/src/bridge/server.ts` | Already authenticated loopback HTTP + SSE for the Web client; stays the only browser-facing endpoint | §2 Rust HTTP "optional if transport absent", §5 API versioning |
| `apps/web` (incl. `office/`, R3F) | Working UI and 3D Office; no rewrite | §1.1, §3 apps/web |
| `packages/runtime/src/providers/*`, `loop.ts` | Working TS providers (ADR 0005); LLM calls need no Python and need not move to Rust | §1.2, §12 New LLM provider |
| `packages/host/src/secrets.ts` | OS keychain / Secret Service adapters, secrets never in logs | §6 Secrets in OS keychain |
| `packages/host/src/{observations,hooks/*,connect/*}.ts`, `packages/importers` | Read-only observers with freshness semantics | §4 Observed agents read-only, §12 New external agent |
| `packages/core`, `packages/office` | Pure domain/projection packages | §3 |
| `tooling/check-{boundaries,public-safety,versions}.mjs`, `.github/workflows/*` | Quality gates to extend, not replace | §11 CI |
| `packages/host/src/lock.ts` | Single-host-per-profile rule is the basis of the single-writer rule | §6 one owner |

## 4. EXTEND

| Path / module | Change | Blueprint item |
| --- | --- | --- |
| `packages/protocol/src/*` | Schema generation for slice-A types, daemon wire messages v1, shared fixtures; keep hand validators as the TS source of truth until codegen parity is proven | Phase 1 Contracts, §5 |
| `packages/runtime/src/mission.ts` | Add an asynchronous acknowledgement port next to the synchronous `commitEvent` (requires an ADR 0014 amendment); sync path unchanged | Phase 2, §10 slice A |
| `packages/runtime/src/policy.ts` | Becomes the parity oracle for Rust `security/permissions`; enforcement authority moves to the daemon only behind the flag | §4 security guard, §7 |
| `packages/host/src/service.ts`, `mission.ts` | Daemon client adapter behind `AgentHostApi` and a feature flag; per-mission single writer routing | Phase 2, §10 slice A |
| `packages/host/src/missionCheckpoints.ts` | Later: read-only export source for the one-time cutover import (no schema change) | §6 migration rules |
| `packages/host/src/lock.ts` | Record the daemon child (pid) under the host lock; stale-daemon detection | §6 ownership |
| `apps/desktop/src/agentsIpc.ts`, `apps/cli/src/start.ts` | Spawn, supervise and stop the sidecar when the flag is on | ADR 0020 |
| `apps/desktop/electron-builder.yml`, `.github/workflows/{ci,release}.yml` | Per-OS daemon binary in `extraResources`, Rust jobs | §11, Phase 8 |
| Root `package.json` `check`, `tooling/{check-versions,bump-version}.mjs` | Cargo checks; lockstep version for `Cargo.toml` (and later `pyproject.toml`) | §11, gap-map decision 5 |
| `packages/host/src/skills.ts` | W0 in progress elsewhere; later a client of the daemon skill registry | Phase 4 |
| `packages/host/src/memory.ts` | Migrates into per-profile vaults | Phase 5 |
| `apps/web/src/{missions,approvals}` | Approvals queue, Skill Security Center as sibling folders | Phase 7 |

## 5. CREATE

| Path | Content | Blueprint item |
| --- | --- | --- |
| `docs/implementation/REPO_AUDIT.md`, `docs/adr/0019`–`0023` | This audit and five Proposed ADRs | Phase 0 |
| `packages/protocol/schemas/`, `packages/protocol/test/fixtures/`, `tooling/generate-schemas.mjs` | Generated JSON Schema + golden fixtures for slice-A types | Phase 1 |
| `Cargo.toml` (virtual workspace), `rust-toolchain.toml`, `Cargo.lock` | Pinned toolchain and dependencies | ADR 0021 |
| `crates/extalia-core/` | Minimal domain/ports/sqlite adapter/permissions; `migrations/0001_*.sql` | Phase 2 |
| `crates/extalia-daemon/` | `main.rs`: handshake, stdio framing, lifecycle | Phase 2, ADR 0020 |
| `tooling/check-rust.mjs` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` when `crates/` exists | §11 |
| `packages/host/src/daemon/` | Typed client, spawn/supervise, feature flag | Slice A |
| `tooling/bench/` | TS-baseline vs daemon measurements (method, hardware, build SHA) | §11 benchmarks |
| `workers/intelligence/` (W3) | `pyproject.toml`, `uv.lock`, protocol v1, scanner adapter | Phase 4, ADR 0022/0023 |

## 6. DEFER

| Item | Why | Revisit at |
| --- | --- | --- |
| `packages/sdk` | No stable extension contract yet | W8 |
| Rust scheduler/router/supervisor | TS kernel delivered and tested (ADRs 0008–0015); port after slice A parity | Phase 3 |
| Rust provider adapters | No evidence of need; TS adapters work with keychain secrets | Separate ADR |
| Axum `/v1/*` HTTP API in the daemon | Bridge already serves the browser; daemon has no network listener in slice A | W8 service mode |
| Long-lived daemon service | Needed only for headless automation (gap-map decision 6) | W8 |
| `workers/intelligence`, scanner adapter | Scanner facts unverified (ADR 0023) | W3 |
| Knowledge/vault/graph, learning modules | Depend on W1 profile model | W5/W6 |
| Top-level `tests/` tree, `docs/operations/` | Per-package tests work with one Vitest config | When a cross-package suite needs it |
| Tauri | Explicitly not a prerequisite (blueprint §1.1, PRD §16.1) | Never by default |

## 7. REMOVE_ONLY_IF_APPROVED

| Path | Why it could go | Condition |
| --- | --- | --- |
| `packages/renderer/` | Two empty folders, no `package.json`, not a workspace package | Owner confirms it is not reserved |
| Legacy sidecar import in `host/src/mission.ts` (`sessions/<id>.missions.json`) | One-time import path from before ADR 0013 | After a stated number of releases and an export tool; never delete user sidecars |
| `MissionCheckpointStore` as a writer | Replaced by daemon ownership after cutover | Parity tests green, cutover import shipped for ≥1 release, downgrade/export path exists, owner approval |
| `FileSecretStore` default on Windows | Plaintext-at-rest fallback | Only once a Windows Credential Manager adapter exists; otherwise keep |
| Untracked `shots/` folder at the root | Local capture, neither tracked nor ignored | Owner decides ignore vs delete |

## 8. Breaking risks

| # | Risk | Evidence | Mitigation |
| --- | --- | --- | --- |
| 1 | **Two writers on one SQLite file.** Any daemon table inside `missions.sqlite` makes the TS host fail closed at startup | `verifySchema` requires exact object count/SQL (`missionCheckpoints.ts`) | Daemon owns a separate file (`<data>/state/core.sqlite`); one writer per file; each mission has exactly one owning store (ADR 0019) |
| 2 | **Synchronous acknowledgement contract.** IPC is asynchronous; ADR 0014 rejects promise acknowledgements | `commitEvent … Never return a promise` (`runtime/src/mission.ts`) | ADR 0014 amendment + async port; reuse the failure latch; parity tests for "no effect before ack" |
| 3 | **SQLite ownership transfer** from `@extalia/host` to the daemon breaks downgrade | ADRs 0013–0015: older binaries reject newer data, no downgrade | Flag-gated, new missions only; one-time import with markers, originals preserved read-only; no automatic downgrade claimed |
| 4 | **Profile lock and orphan daemons** | `lock.ts` knows only `desktop`/`bridge` | Sidecar is a child of the lock holder; daemon exits on stdin EOF; daemon takes its own lock on `core.sqlite` |
| 5 | **Packaging a Rust binary per OS** | electron-builder ships no `node_modules`; macOS arm64+x64 from one runner with hardened runtime; Windows/Linux x64 only; CLI npm package ships `dist` only | Build both macOS targets, sign/notarize the extra Mach-O (electron-builder support to verify), packaged smoke test; CLI distribution of the binary is an owner decision (per-platform npm packages vs source builds) |
| 6 | **`node:sqlite` status** | Module is flag-free since Node 22.13 (ADR 0013); local Node 26.12 shows no warning; Electron's embedded Node only feature-probed. Current stability index **unverified** | TS keeps `node:sqlite` for the legacy store and Hermes import; Rust uses bundled SQLite, so the two may run different SQLite versions on the same file during cutover — only read-only access from TS after cutover |
| 7 | **IPC/Bridge changes** | 62 forwarded `AGENT_HOST_METHODS`; web mocks (`apps/web/src/host/mock*.ts`) | Slice A changes no method signatures; renderer and browser never reach the daemon |
| 8 | **Lockstep versions and CI time** | `check-versions`/`bump-version` only read `package.json`; CI has no Rust | Extend both tools to `Cargo.toml`; cache cargo in CI; owner decision 5 on making cargo a contributor prerequisite |
| 9 | **Scanner assumptions** | PRD names NVIDIA SkillSpector; repository has no verification | ADR 0023: unverified until pinned; fail closed; Windows/Linux release jobs not yet run in CI (verified locally on macOS arm64 only) |
| 10 | **Concurrent uncommitted work** | ~550 changed paths; W0 skills change in progress | Re-run this audit after those land (blueprint §9) |

## 9. Staged pull-request plan

Later waves (W3–W5) are tracked in [docs/product/prd-v1.1-gap-map.md](../product/prd-v1.1-gap-map.md) §5.

Each PR: `pnpm version:patch` once, `pnpm check` green, ledger/gap-map update. "Rollback" states what a revert leaves behind.

| PR | Wave | Scope | Tests (explicit) | Migration / rollback | Status (2026-10-23) |
| --- | --- | --- | --- | --- | --- |
| 0 | Phase 0 | This audit + ADRs 0019–0023 | `pnpm lint` (public safety on docs) | Docs only; revert freely | Delivered (v0.4.57); audit accepted, ADRs 0019–0023 accepted |
| 1 | W1 | `tooling/generate-schemas.mjs`; JSON Schema for `Mission`, `Task`, `AgentEvent`, `Approval`, `Permission`; golden fixtures (valid + invalid) | Vitest: every fixture's verdict from `parseOrchestration` equals its schema verdict; schema drift check in `pnpm check` | No data; revert | Delivered (v0.4.58); JSON Schema for the five contracts |
| 2 | W1 | Daemon wire contract v1 in `@extalia/protocol`: `hello`, `mission.create`, `task.transition`, `event.commit`, `permission.check`, `health`, error codes | Round-trip + rejection fixtures (unknown op, newer `schema_version`, oversize frame) | No data; revert | Delivered (v0.4.58); daemon wire contract v1 |
| 3 | W1 | ADR 0014 amendment + runtime async acknowledgement port (opt-in), sync path untouched | Duplicate ADR 0014 tests for the async sink: rejected/late/non-monotonic ack latches the mission, no provider/tool call before ack, siblings stop | No data; revert | Delivered (v0.4.58); opt-in async acknowledgement, sync path unchanged |
| 4 | W2 | Cargo workspace, `rust-toolchain.toml`, empty `extalia-core`, `extalia-daemon` handshake; `tooling/check-rust.mjs`; CI Rust job on 3 OS | `cargo fmt/clippy/test`; integration test spawns the binary, handshake, EOF exit | No data; revert | Delivered (v0.4.59) |
| 5 | W2 | `extalia-core` SQLite adapter (ADR 0019): `migrations/0001_core.sql` (missions, tasks, events, leases, approvals, `profile_id` on each), migrator with exact-schema check, backup before migrate | Fresh create; reopen; newer `user_version` fails closed; tampered schema fails closed; injected failure mid-migration rolls back; 0600 permissions; WAL/FULL/foreign keys asserted | New file only, never read by TS; revert leaves an unused file (do not auto-delete) | Delivered (v0.4.59) |
| 6 | W2 slice A | One durable task: create mission + task + event in one transaction; per-mission sequence; caps mirroring ADR 0014; restart turns running into recovering/unknown (ADR 0013); minimal lease (holder, expiry) | Duplicate event id (identical → original ack; conflicting → atomic failure); crash before commit (kill between write and commit); stale lease recovered as unknown, never replayed; cross-profile read/write denied | Down migration not offered for populated DB; rollback = flag off (PR 8) | Delivered (v0.4.69) |
| 7 | W2 slice A | `permission.check` in Rust ported from `policy.ts`; deny when the daemon is unavailable | Shared fixture matrix (mode × access × grants × workspace policy) run in Vitest against `decide()` and in `cargo test`; identical results required | No data | Delivered (v0.4.69) |
| 8 | W2 slice A | Host daemon client behind `AgentHostApi`, flag (off by default); Desktop and Bridge spawn the sidecar; new missions only route to the daemon | Parameterized host suites (`missions`, `missionJournal*`, `missionCheckpointIntegration`, `missionBudget`) pass against both backends; Desktop smoke with flag on; daemon crash → mission `recovering`, host stays up | Flag off → TS path; daemon-owned missions stay quarantined in `core.sqlite`, not exported or deleted | Delivered (v0.4.70); behind the `nativeCore` flag, off by default |
| 9 | W2 | Packaging (self-contained, owner decision 9): per-OS daemon binary in `extraResources`, macOS arm64+x64 signing, CLI per-platform optional npm packages, packaged smoke (`dist:dir`); the Python worker bundle joins in W3 | Release-matrix dry run; app starts with and without the binary (flag off ignores absence); packaged app and `npm install -g` run on a clean machine with no Rust/Python toolchain on `PATH` | Revert removes binary; data unaffected | Delivered (v0.4.70); CLI daemon npm packages not published until the npm scope is reserved; Windows/Linux release jobs not yet run in CI (verified locally on macOS arm64 only) |
| 10 | W2 gate | `tooling/bench/`: TS baseline vs daemon (commit p50/p95, cold start, idle RSS, restart recovery, binary size) on stated hardware | Reproducible script; numbers published, never estimated | Default-on decision is a later ADR; cutover import (`missions.sqlite` → `core.sqlite`) is a separate PR after this gate | Delivered (v0.4.71; running-totals fix v0.4.72); gate passes (2026-10-23). Default-on still needs an AC-power re-run on Apple silicon and an x64 Windows re-run (gap map decision 8) |

## 10. Open questions for the owner

1. Accept a separate `core.sqlite` (risk 1) and "new missions only" routing during transition?
2. Gap-map decision 5: cargo as a mandatory contributor prerequisite in `pnpm check`, or CI-only with a local opt-out?
3. Gap-map decision 6: sidecar now, service deferred to W8 (proposed)?
4. CLI (`extalia-vo`) daemon distribution: per-platform npm packages, or Desktop-only until W8?
5. Gap-map decision 7 and scanner: accept a Python worker that is required for skill import only (ADR 0022/0023)?
6. Benchmark thresholds that let the daemon become default.
