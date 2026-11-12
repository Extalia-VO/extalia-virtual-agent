# Extalia Master PRD v1.1: implementation specification

Read in order:
1. [`master-prd.md`](master-prd.md) — full v1.0 baseline + v1.1 consolidated decisions, FR-15–FR-24 and AC-16–AC-30.
2. [`skills-engine-and-security.md`](skills-engine-and-security.md) — routing, SkillSpector, permissions, lifecycle and schema.
3. [`knowledge-and-learning.md`](knowledge-and-learning.md) — isolated vaults, wikilinks, graph, sync and learning.
4. [`implementation-handoff.md`](implementation-handoff.md) — incremental execution order for coding agents.
5. [`changelog.md`](changelog.md) — change summary.

**Patch v1.1.1 (additive, 2026-10-21):**
6. [`technical-blueprint-v1.1.1.md`](technical-blueprint-v1.1.1.md) — frameworks, ports/adapters, Rust control plane, Python worker protocol, schemas, phased coding order, extensibility.
7. [`implementation-handoff-v1.1.1.md`](implementation-handoff-v1.1.1.md) — read-only audit pass first, hard constraints, report template.

Status of the imported deliverable: **specification completed**. The text below
is a preserved planning baseline, not today's implementation status. As of
v0.4.288, Native, skills, Knowledge and a platform-scoped pinned SkillSpector
integration have implementation evidence; their remaining acceptance gates are
tracked in the [current gap map](../prd-v1.1-gap-map.md) and
[PRD directory](../README.md). Do not infer that implementation has not started
from this historical pack or that scanner support covers every platform.

## Repository copy

Added to the repository on 2026-10-21 from the owner-supplied planning pack. Private workspace,
profile and persona names and the location were replaced with neutral examples (public repository
rule, [ADR 0001](../../adr/0001-clean-public-repository.md)); requirements are otherwise unchanged. Patch v1.1.1 was translated from the owner's
mixed Indonesian/English text to English for consistency with the rest of `docs/`, without
changing requirements.
What exists today and the upgrade order: [v1.1 gap map](../prd-v1.1-gap-map.md).
