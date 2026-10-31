# ADR 0046: Immutable original planned-task membership

Status: Verified locally v0.4.152, 2026-10-31; V2-03 prerequisite

## Context

Execution admissions bind an exact task lease and the graph seen when that
task starts (ADR 0033). Recovery review reads a coherent current graph and its
admissions (ADR 0035). Neither independently records which tasks belonged to the
original mission. Comparing admissions with a mutable current table cannot detect
a removed task, and zero missing admissions cannot certify complete execution
ownership.

## Decision

Capture the validated original mission graph in the same SQLite transaction as
mission creation, task insertion and the creation journal entry. Migration 11
adds an immutable, profile/mission/workspace-bound planned-task record. It keeps
the creation revision, sorted original task identities and digests, original
graph digest and a domain-separated membership digest. Reads and writes are
bounded by the existing 64-task limit and an encoded-byte limit. SQL guards
refuse update, deletion and replacement of an existing record. The table is
`STRICT, WITHOUT ROWID`, so hidden-rowid replacement cannot bypass those guards
when recursive delete triggers are disabled.

Identical creation retries retain the same record; a reordered equivalent task
list does not create a different plan. Conflicting identity or content refuses.
Invalid direct Rust callers cannot bypass mission/graph contract validation.
The public Rust reader distinguishes an available original record from legacy
absence. Migration never derives an original plan from a mutable legacy graph.

For missions with a record, admission and recovery review validate current task
membership and definitions against it inside their existing transaction. Missing,
extra, foreign or changed definitions refuse without partial writes. Ordinary
task state, attempt, lease, assignee, evidence and verification changes remain
valid: planned membership does not certify who executed a task. The original
full digests remain historical references, not hashes of later mutable state.

This increment is a Rust storage/library API. Existing daemon and portable
recovery responses retain their shape and meaning. Legacy admission and review
remain informational under their existing conservative rules; absence does not
become proof of complete membership.

## Boundaries and next gate

A planned task is not an executor. This record does not establish planner/root
execution ownership, register child obligations before launch, seal descendant
admission, prove direct/remote process settlement or fence worktree writers.
An empty missing-admission list, settled turn promise or scoped local-drain
record still cannot clear quarantine. Existing restart/reaping behavior remains.

Before terminal reconciliation, establish root ownership before planner effects,
record and seal applicable child obligations, verify settlement for every exact
epoch and enforce canonical writer/worktree fencing. Bind any explicit closure
decision to a revalidated coherent review. V2-03, AR-05/06 and v0.5 acceptance
remain open; no production Python/scanner activation is implied.

The historical reader validates the captured record and its scope. `Available`
does not independently certify all mutable mission-row columns/digests; canonical
recovery review retains its stronger snapshot checks.

## Verification

Thirteen focused temporary-store tests cover atomic rollback, creation
retry/conflict, scope, sorting and byte/task limits, SQL immutability,
task-set/definition drift, normal task transitions, restart/reaping retention and
legacy migration absence. Fresh, replayed and unsupervised starts reject drift;
corrupt history never reports availability. An independent review found a
hidden-rowid replacement bypass, reproduced by a failing test before the fix.
The regression now covers `rowid`, `_rowid_` and `oid` against a different valid
legacy parent with recursive triggers disabled, preserving both histories.

All 305 core tests, Rust formatting and strict core Clippy pass. Independent
source re-review found no remaining blocker within this increment. Full
`pnpm check` passes: 334 TypeScript suites/4,771 tests (one suite/five tests
skipped), 434 Rust tests, formatting/strict Clippy, schema/boundary/type checks
and Web/Desktop/CLI builds. No live-provider, cross-platform release or complete
physical-settlement certification is claimed.
