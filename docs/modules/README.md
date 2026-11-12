# Documentation by module

Audit baseline: **v0.4.288**, 2026-11-12. These hubs describe the checked-out
implementation; they are not a new release or an acceptance certificate.

| Module | Responsibilities | Start here |
| --- | --- | --- |
| Native agent | Chat, teams, delegation, missions, permissions and recovery | [Native agent](native-agent.md) |
| Skills | Built-ins, discovery/import, Grimoire, scanning and activation | [Skills](skills.md) |
| Knowledge and memory | Obsidian-compatible vaults, 2D/3D graphs, recall and learning | [Knowledge and memory](knowledge-memory.md) |
| Integrations | Observed apps, hooks, messaging, questions and handover | [Agent integrations](integrations.md) |
| Office | Scene, avatars, navigation, furniture, camera and lighting | [3D Office](office.md) |
| Platform and delivery | Desktop, Web/CLI, setup, updates and packaging | [Platform and releases](platform-release.md) |

## Reading status

- **Implemented** means the scoped behavior exists in source with referenced
  evidence. It does not certify every provider or operating system.
- **Partial** means a usable slice exists but named requirements or acceptance
  cases remain open.
- **Not implemented** means the requested behavior has no production path;
  contracts, mock fixtures and proposals do not count as execution.
- **Acceptance pending** means code or historical tests exist, but the named
  release/real-provider/platform gate has not been completed.
- **Historical** means evidence is tied to its recorded version and date.

Do not compute an overall completion percentage from file/test/issue counts.
For requirement-level status use the [PRD directory](../product/README.md),
[app-flow tracker](../product/prd-app-flow-and-live-agents.md#11-status-tracker)
and [v2 acceptance map](../product/prd-v2-acceptance-map.md). For architecture
precedence use the latest applicable [ADR](../adr/README.md); ADR 0071 replaces
the mandatory backend-language destination in ADR 0069. Historical specifications
and measurements retain their original text and version context.
