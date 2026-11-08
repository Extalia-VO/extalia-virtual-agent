# ADR 0059: Native workspace folder authority

Status: Implemented locally v0.4.200; full verification passed on v0.4.201, 2026-11-08

## Decision

Retain `projectLocation` as the primary working directory. Add at most fifteen
`additionalProjectLocations` and `crossWorkspaceAccess` with isolated, read-only
and read-write values. Read-only is the requested effective default for absent
legacy fields. Use the minimum of actor and destination policy for foreign file
access. Approvals, prompt instructions and member model choices cannot expand
the host-owned authority.

Canonicalize a per-run snapshot of all registered folders, including nested
registrations, and authorize both path spellings and resolved targets. Prune
inaccessible traversal entries before formatting or sending search content to
the worker. Refuse credential and hard-linked files; protect the app profile
even beneath a selected ancestor. Explicit run-owned worktree mappings permit
their own strict subtree only and pin mission writes there. Before copying, a
Native write mission requires an exact local repository root and refuses
inaccessible nested workspaces. The Git adapter refuses partial/promisor and
redirected strict layouts, disables lazy fetching and merge signature programs,
and preserves the existing filter/hook/custom-merge restrictions. Recheck member edit
scope against the canonical target as well as the model's relative spelling.

Reserve workspace mutation synchronously against Native and memory admission.
Refuse boundary changes until prior Native ownership and memory operations are
clear. Save a host-owned boundary fingerprint with chat history and require a
new session when grants change; do not silently delete visible history. Isolated
memory has a separate scope, automatic instructions stay in the primary project,
and external skill metadata/body require fresh exact-workspace applicability.

## Command limitation

An unrestricted shell can bypass file-tool authorization through filesystem,
process and local Bridge access. No verified isolated command executor exists.
Production Native command tools therefore require a boundary and fail closed;
the production integration queue does the same, with `not_run` evidence. Low-level
command utilities remain available for existing explicit host/test callers;
managed Native composition never enables their unrestricted path.

This is a cooperative host file-tool boundary, not proof against malicious
concurrent parent-directory replacement or other external applications. A future
executor needs inherited filesystem confinement, private temporary/home state,
control-IPC restrictions and verified descendant settlement. It must not silently
fall back to an unrestricted shell.

## Verification

Use temporary profiles only. Cover source/destination mode combinations, multiple
folders, canonical aliases, nested roots, protected app data, link/hard-link
refusals, traversal pruning, member scope and mission worktree parity. Verify
profile mutation/admission interleavings, stale history refusal, isolated memory,
instruction symlinks and fresh scoped skill grants. Prove required command gates
never spawn or become ready. Inspect create/edit settings and persistence in both
languages, light/dark and phone width; record final checks in the PRD tracker.

See [the user guide](../getting-started/workspace-boundaries.md).

Final `pnpm check` passed: 6,478 TypeScript tests, 23 optional tests skipped,
474 Rust tests, lint, typechecks and all builds. Independent review findings were
resolved with regressions. Browser component/mock checks covered both languages,
light/dark and 1280/390px layouts; full shell and real OS folder dialogs were not
claimed. No real profile edits, paid-provider calls, commit or publication.
