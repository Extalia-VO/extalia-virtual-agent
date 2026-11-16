# Extalia documentation

## Find documentation by module

Start with the [module directory](modules/README.md). Each hub links the user
guides, implementation contracts, source/tests, PRD status and remaining gates.

| Module | Documentation |
| --- | --- |
| Native agent, teams and missions | [Native agent](modules/native-agent.md) |
| Skills, import and security review | [Skills](modules/skills.md) |
| Obsidian, graphs, memory and learning | [Knowledge and memory](modules/knowledge-memory.md) |
| Connect agent apps and observed control | [Integrations](modules/integrations.md) |
| Spatial scene and interactions | [3D Office](modules/office.md) |
| Desktop, Web/CLI and releases | [Platform and delivery](modules/platform-release.md) |

## Find documentation by purpose

- **Use the app:** [Getting started](getting-started/README.md).
- **Requirements and done/remaining work:** [PRD directory](product/README.md).
- **Implementation contracts:** [Architecture directory](architecture/README.md).
- **Decisions and superseded proposals:** [ADRs](adr/README.md).
- **UI and scene behavior:** [Design directory](design/README.md).
- **Build/install/release:** [Release directory](release/README.md).
- **Measurements:** [Benchmark directory](benchmarks/README.md), including
  [Office and renderer measurements](bench/README.md).
- **Historical migration/audit:** [migration ledger](migration/ledger.md),
  [Office parity](migration/office-parity.md) and
  [v1.1.1 repository audit](implementation/REPO_AUDIT.md).
- **Brand:** [Brand assets](brand/README.md).
- **GitHub wiki source:** [Home](wiki/Home.md), [Architecture](wiki/Architecture.md),
  [Roadmap](wiki/Roadmap-and-Phases.md), [Security](wiki/Security-and-Permissions.md)
  and [Contributing](wiki/Contributing-and-Governance.md).

## Documentation maintenance

The 2026-11-12 reconciliation uses source/release **v0.4.288**. It separates
implementation from acceptance and preserves dated review/benchmark evidence.
It does not re-run those historical experiments or close the v0.5 gate.

Update a module hub and the applicable PRD row when behavior changes. Keep one
requirement-level status in the linked tracker; use the hubs as navigation and
scoped summaries. Keep original file locations so existing links remain valid.

Verification for this documentation update: `pnpm check` passed; local link/anchor
and navigation checks reached all 198 Markdown documents under `docs/`, indexed
all 77 numbered ADRs, and confirmed FR-001–040 appear exactly once in the current
PRD v2 checkpoint. Optional prerequisite-dependent tests were skipped as reported
by the suite. No remote-link, new live-provider or installer certification is
claimed by this audit.
