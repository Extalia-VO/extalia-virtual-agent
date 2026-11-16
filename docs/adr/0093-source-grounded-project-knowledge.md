# ADR 0093: Source-grounded project Knowledge builds

- Date: 2026-11-16.
- Status: Implemented and verified locally and on the authorized main host in v0.4.340; acceptance details in the product PRD.
- Extends: ADRs 0074, 0075, 0087 and 0088.

## Problem

A discussion grounded in recent conversation and indexed vault notes cannot prove
that project documents were read. Exporting that discussion as minutes does not
build a useful project Knowledge graph, especially when the destination is empty.
Repeated meeting participants can also duplicate investigation without expanding
source coverage.

## Decision

Explicit **Update knowledge** schedules one source build after ten quiet seconds.
It uses the saved Native team's approved idle routes, registered project access
and selected vault, independently of automatic-learning and minutes consent.
Automatic post-task review keeps its existing narrower evidence contract.

The host authorizes every Rust-discovered relative source path before capture.
Rust owns confined bounded source reads, raw and credential-masked hashes,
freshness checks, deterministic note rendering, managed compare-and-swap writes
and publication manifests. Hidden, sensitive, dependency and symlink paths are
excluded. The selected destination is excluded from source inventory. Supported
filesystem guarantees fail closed on unsupported platforms.

TypeScript retains provider orchestration to reuse existing approved routes and
event attribution under ADR 0071. Sequential bounded Native requests see exact
contiguous evidence units from every captured source and submit neutral topic
labels with current-batch evidence IDs. The host expands IDs through an immutable
map to unchanged source text, rejecting invented IDs, paths and quotations. This
removes model transcription drift without trusting generated factual prose.
Rust independently checks the expanded quotations
against complete captured projections and rechecks actual source hashes before
publication. Embedded source instructions never become execution authority.
Declared status and attributed quotations do not establish universal factual truth.

## Obsidian graph and provenance

Ordinary Markdown under `Projects/<workspace-id>/Knowledge/` contains an overview,
folder maps, topic notes, source snapshots and a coverage report. Full
vault-relative wikilinks with display aliases avoid duplicate-basename ambiguity.
Source relationships become edges only when they resolve to one captured content
identity; unresolved original references are reported in plain text. Source
snapshots are fenced so their embedded link examples cannot create phantom edges.
Topics connect through shared evidence; maps connect topics and source groups.
Existing Obsidian configuration remains untouched.

Exact raw-content duplicates share one stable source snapshot and retain all
source-path aliases. Different versions remain distinct. Generated paths do not
depend on the model response order. Same topic keys merge with exact citation
deduplication and explicit bounded omission counts.

Requests fit the transformed evidence payload and dynamic ID schema before
inference. Nine primary batches reserve three recovery slots within twelve total
requests. Compact submissions and 120-second request allowances reduce timeout
pressure; a settled retryable failure may retry the same batch once through the
next approved idle route. Authority cancellation and nonretryable errors never
fail over. Total allowance is ten minutes, or fifteen minutes for at least 128
sources, measured from original entry rather than reset after retries.

## Settlement and repeat runs

The manifest binds source fingerprints and acknowledged output hashes. An exact
unchanged rerun returns existing receipts without provider inference. Source
changes retain stable managed paths. User edits are conflicts, never fresh
overwrite authority. Existing removed-source notes are retained rather than
silently deleted. A positive publication receipt survives later event, release or
index failure, which is presented as partial completion.

The host refreshes the selected index, reads every proposed note and checks its
indexed link pages before reporting indexed success. Cancellation drains entered
provider and filesystem promises before releasing workspace ownership. Pending
same-workspace updates coalesce; working team members are excluded, and foreground
work retains priority. React presents receipts and compact status only.

## Verification

Temporary-profile tests cover exact quotation validation, bounded all-source
excerpt coverage, duplicate-content aliases, source freshness, deterministic paths,
source-authored reference resolution, actual Rust publication, unchanged reruns,
user-edit conflicts, cancellation and partial receipts. Live acceptance must read
the authorized real project and verify meaningful notes, resolved graph links and
an unchanged second request before claiming a successful source build.
