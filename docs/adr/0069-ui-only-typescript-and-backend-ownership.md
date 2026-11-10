# ADR 0069: UI-only TypeScript and explicit backend ownership

Status: Historical language target accepted, 2026-11-09; mandatory migration
destination superseded on 2026-11-10 by
[ADR 0071](0071-rust-openai-completion-and-resource-evidence.md).
Ownership inventory and baseline enforcement remain useful. TypeScript backend
may remain when measured efficiency favors it; strict language mode is diagnostic.

## Decision

TypeScript/React is the presentation layer: rendering, scene animation, user
interaction, drafts and client-side protocol transport/validation. Backend
execution, model request processing, scheduling, analysis, filesystem access,
process supervision and persistence belongs to Rust or supervised Python.

This supersedes the permanent TypeScript executor/provider destination in older
plans. ADRs 0053 and 0067 still describe completed increments and their limits;
their permission, compatibility and positive-settlement requirements remain.
Remote model inference still belongs to the selected external provider.

Shared DTOs, protocol types and renderer-side validation may remain TypeScript.
Shared domain decisions consumed by the backend are migration debt even when
they are portable, side-effect-free or also consumed by the UI. Electron main,
CLI HTTP servers and adapters do not become UI by being placed under `apps/`.
Repository build/test/release tools are outside the product-runtime requirement.
An IPC facade is transitional until it contains only transport responsibilities.

Do not add new backend product features in TypeScript. Port their authority and
processing to Rust/Python; keep any necessary client port narrow. Existing
backend fixes must preserve behavior and remain visible in the migration ledger.
Changing the ledger is an explicit reviewed architecture change, never an
automatic step of CI or an alternative to migration.

## Audit evidence

Independent runtime and host audits found these live paths:

| Area | Current executable path | Destination / remaining work |
| --- | --- | --- |
| Native Chat, Teams and Missions | `packages/host/src/service.ts` invokes runtime turn/mission functions; `packages/runtime/src/loop.ts`, `mission.ts`, `delegation.ts`, `meetings.ts` execute them | Rust turn/history, scheduling, delegation and meeting lifecycle |
| Provider requests | `packages/runtime/src/providers/`, `fallback.ts`, `requestBudget.ts`; service creates providers for discovery, Chat, Missions and learning | Rust HTTP/stream parsing, budgets, retry and result assembly across every caller |
| Workspace tools and Git | `packages/host/src/tools/`, `workspaceFs.ts`, `workspaceAccess.ts`, `worktrees/` | Rust permission/path-bound tools and supervised child lifetimes |
| Search processing | JavaScript worker source embedded in `packages/host/src/tools/files.ts` | Rust/Python worker with verified expression semantics, deadlines and output parity |
| Files, profiles, secrets and sessions | Host stores, configuration, session persistence and migration modules | Rust storage, transactions and OS credential boundary |
| Observed agents and imports | `packages/host/src/observations.ts`, `nativeImport.ts`, `hooks/`, observed controls and `packages/importers/src/` | Rust/Python parsing, hook normalization, queue/control lifecycles |
| Other-app configuration | `packages/host/src/connect/`, transaction and journal modules | Rust dry run, approval-bound mutation, backup, recovery and undo |
| Memory, knowledge and learning | Mixed host facades and genuine Rust knowledge/learning/registry ports | Retain existing Rust authority; move remaining host ranking, policy, watch and provider work |
| Shared domain processing | `packages/core/src/`, `packages/platform/src/` | Separate UI contracts/projections from authoritative backend policies and parsers |
| CLI and Desktop | CLI `src/bin.ts`/`start.ts`; Desktop `src/main.ts`/`agentsIpc.ts` | Rust Bridge/CLI and privileged desktop host; retain only UI/client code in TypeScript |

The initial host audit counted approximately 25,000 host source lines and 1,150
importer lines, before runtime/shared/privileged-app modules. These are source
size observations, not performance measurements or a completion percentage.
Use the machine inventory for the current snapshot; exact counts change with
concurrent product work.

The reviewed source snapshot contains 780 product source files: 150 legacy
backend files (32,997 lines), 74 shared executable review files (10,655 lines),
548 UI files and eight erased contract files. The 224 outstanding files are a
conservative source inventory, not 224 independent migration tasks. Generated
scanner resources and bundled dependencies are excluded from authored-source
counts and remain subject to separate artifact review.

CLI `build.mjs` bundles the backend into `dist/extalia.mjs`. Desktop's build
bundles main/preload sources into its Electron artifacts. Moving a source file,
launching Node from Rust/Python, embedding JavaScript or generating an equivalent
bundle does not move backend ownership. The shipped theme bootstrap under
`apps/web/public/` is presentation code; build/release scripts are tooling.

## Enforcement and its limits

Maintain a source inventory and a reviewed legacy baseline covering executable
TypeScript and JavaScript variants, including files outside `src/`. Inspect
imports, dynamic code evidence and runtime composition entrypoints. Classify
backend-used shared computation conservatively instead of exempting all pure
functions. Keep source hashes for inspection and reproducibility.

Two separate outcomes must remain visible:

1. **Migration baseline compliant:** no unreviewed expansion relative to the
   recorded legacy inventory. Existing backend JavaScript still exists.
2. **Zero backend JavaScript compliant:** no backend or unresolved shared
   executable debt remains. This check must fail for today's implementation.

Run `pnpm audit:backend` for the current summary, or
`node tooling/backend-ownership.mjs --json` for per-file evidence. The normal
lint/CI path uses `--check-baseline`. Run `pnpm audit:backend:strict` to check the
actual language destination; its current nonzero exit is expected and must not
be described as a passing migration. A reviewed baseline refresh uses
`node tooling/backend-ownership.mjs --write-baseline`; inspect its diff and
record the reason before accepting it. CI never refreshes the baseline.

The source inventory is not a proof of packaged-artifact purity. Dynamic loading,
embedded code, dependency execution, generated assets and shipped bundles require
independent review before the strict target can be declared achieved. Tests for
the inventory must include pure backend algorithms without privileged imports,
JavaScript outside `src/`, type-only imports and unresolved dynamic imports.

## Migration order and acceptance

1. Move provider HTTP and parsing behind a capability-advertised Rust port on
   every supported target, first OpenAI-compatible, then Anthropic. Cover model
   discovery, Chat, Teams, Missions, fallback and automatic learning. Use bounded
   admission, chunked large inputs, stream backpressure, credential redaction
   and synthetic-server parity tests. Remove replaced production JS execution.
2. Move turn/history, prompts, steering, scheduling, team and meeting execution.
   Preserve task admissions, policy revisions and acknowledged durable events.
3. Move filesystem/process/Git tools and remaining profile/session/memory stores.
   Verify workspace confinement, path replacement, cancellation and shutdown.
4. Move observed adapters, imports, hooks/MCP, queues and other-app configuration
   transactions without inventing controls an external harness cannot provide.
5. Replace the privileged Node/Electron application backend, remove obsolete
   dependencies, and inspect built CLI/Desktop artifacts for backend JavaScript.

Each cut needs a single lifetime owner, explicit failure behavior and temporary
profile tests. A provider operation must distinguish result delivery from
positive local settlement: the existing daemon client can reject IPC promises
before a killed child has actually exited. A rejected promise alone cannot
release execution ownership. Lost acknowledgements remain uncertain; reconnect
does not replay a request or establish that a remote provider finished.

Do not disable supported features, weaken workspace permissions, change regex
semantics silently or bypass drain/recovery gates to achieve a language count.
Performance claims require measured equivalent workloads; Rust ownership alone
does not establish lower whole-application memory use or latency.

This audit update does not complete any of these production migration cuts.

## Verified audit update

Version 0.4.241 passes the full serial `pnpm check`: 7,774 TypeScript tests
(26 optional skips), 501 Rust tests, lint, typechecks, schemas, application builds,
version consistency and asset validation. Fifteen dedicated synthetic inventory
tests cover ownership, relocation/exclusion, embedded workers, named-type runtime
imports, unresolved aliases and package-scoped dependency resolution. The
reviewed baseline passes; strict source ownership exits 1 for the 224 recorded
backend/shared review files. Packaged-runtime purity and production migration
remain unverified and incomplete.
