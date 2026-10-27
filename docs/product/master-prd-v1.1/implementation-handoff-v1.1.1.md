# PRD patch v1.1.1: coding-agent handoff

## Mission
Extend the existing Extalia codebase incrementally according to Master PRD v1.1 and the [technical blueprint](technical-blueprint-v1.1.1.md). This is a **specification patch, not authorization for a full rewrite**. The architecture must stay extensible as needs evolve.

## Mandatory first pass — read only
1. Inspect the actual monorepo manifests, Electron boot/preload, React/R3F entry points, existing agent/provider adapters, persistence, IPC, skills, security, tests and packaging.
2. Map the proposed file paths onto actual existing modules; identify duplicates and breaking risks.
3. Write `docs/implementation/REPO_AUDIT.md` with `KEEP`, `EXTEND`, `CREATE`, `DEFER` and `REMOVE_ONLY_IF_APPROVED` tables.
4. Write ADRs for the SQLite driver, IPC transport, Rust integration strategy, Python worker distribution and scanner adapter pinning.
5. Deliver a staged pull-request plan with explicit tests and migration rollback. **Do not edit production code in the audit pass.**

## Subsequent passes
Implement in thin vertical slices: contracts → minimal Rust task/event core → provider and multi-agent concurrency → security skill gate → vault/graph → learning → UI → hardening. Require tests at each gate. Preserve existing Electron/React/Three.js functionality.

## Hard constraints
- Rust is the authority for task state, permissions and activation; Python is an on-demand helper.
- No bypass of the scanner or quarantine for imported, generated or modified skills.
- No cross-profile knowledge leakage; no secrets in prompts or logs.
- No fabricated external agent state or unsupported control claims.
- No always-on Python and no forced 3D rendering in headless mode.
- No blind creation of every suggested file/crate; refactor based on repository evidence.
- Do not treat a suggested Rust/Python percentage as a target.

## Final report template
- Files inspected:
- Files created:
- Files modified:
- Migrations:
- Commands/tests run and exact results:
- Security checks:
- Resource measurements:
- Assumptions/unverified behavior:
- Rollback steps:
- Next recommended slice:
