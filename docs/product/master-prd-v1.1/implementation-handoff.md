# Extalia v1.1 — Coding Agent Handoff

**Task:** Implement incrementally from the current repository; do not rebuild the entire app or replace existing React/Three/Electron architecture.

1. Audit repo and document actual components/migrations/tests/toolchains. Note mismatches between PRD and code.
2. Define ADRs for skill manifest, scanner adapter, policy enforcement, ACL/vault roots, event evidence, schema migrations and skill package immutability.
3. Implement Gate 1 contracts + denial tests before UI or self-learning.
4. Implement Gate 2 registry, category routing, quarantine and pinned SkillSpector adapter. Validate real upstream CLI/version at implementation time. Never claim scanner works without executing tests.
5. Implement Gate 3 Markdown/Obsidian vaults, wikilinks and graph with isolation and conflict tests.
6. Implement Gate 4 verified experience learning, skill candidates, sandbox/evaluation and hybrid activation.
7. Run AC-16–AC-30, resource benchmarks, restart tests, regression suite; report exact commands, pass/fail, skipped items, changed files and residual risks.

**Constraints:** Rust incremental, Python on-demand, SQLite WAL, Obsidian optional, external agents observed by default, no fabricated telemetry, no cross-profile leakage, no skill self-approval, no privileged auto-activation, no always-on scanning/embeddings.

**First deliverable:** repository audit + ADRs + migration/contract plan. Do not attempt all phases in one patch.
