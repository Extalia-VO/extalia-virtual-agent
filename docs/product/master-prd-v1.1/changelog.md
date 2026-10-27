# v1.1.1 Change Log — 2026-10-21 (technical implementation patch)

- Additive to v1.1; no requirement removed.
- Rust becomes the locked control-plane authority (task state, permissions, approvals, activation, process supervision); Python an on-demand stdio worker. Ratios are not targets.
- Ports/adapters modular monolith, contract-first schemas, event envelope, worker protocol v1, operational/skill/knowledge SQLite tables, skill activation state machine with TOCTOU hashing.
- Phases 0–8 with exit gates; phase 0 is a read-only repository audit (`REPO_AUDIT.md` + ADRs) before any runtime change.

# v1.1 Change Log — 2026-10-21

- FR-15 hierarchical category/intent indexed routing and scoped skill selection.
- FR-16 mandatory NVIDIA SkillSpector inspection, quarantine, fail-closed policy and immutable attestations.
- FR-17 Obsidian wikilinks, compatible graph view, indexed typed knowledge graph and profile isolation.
- FR-18 hybrid self-learning/skill activation policy.
- FR-19 agent capability registry.
- FR-20 memory hierarchy, provenance and conflicting-knowledge handling.
- FR-21 dependency/compatibility resolution.
- FR-22 sandboxed skill evaluation.
- FR-23 safe two-way Obsidian sync and knowledge revalidation.
- FR-24 learning dashboard and evidence-based effectiveness measurements.
- Added AC-16–AC-30, implementation gates, dedicated Skills/Obsidian specs and handoff.
- Preserved v1.0 orchestration/observation/3D plan; no implementation performed.
