# Roadmap and implementation phases

## Current status (v0.4.288, reconciled 2026-11-12)

Desktop and Web/npm v0.4.288 are published previews. The shared 3D Office is
already integrated; it is not an unstarted final integration milestone.
Implementation and acceptance are tracked separately in the
[PRD directory](../product/README.md) and [module hubs](../modules/README.md).

| Module | Implemented scope | Work still open |
| --- | --- | --- |
| Native | Managed Chat, bounded file tools, teams/worker reports, Missions with read-only defaults/isolated write tasks and selected Rust services | Production integration test/apply, isolated command executor, full writer/child ownership, physical reconciliation, durable exact approvals and evidence-gated dispatch |
| Skills | Built-ins, import/library/marketplace, revision review, automatic Native context and pinned scanner on supported Mac | Broader scanner platforms, executable-package sandbox/quality acceptance |
| Knowledge | Markdown/Obsidian indexing, search/backlinks, 2D/3D graph, bounded memory and scoped learning | Retained shared-vault ACL/CAS/conflict/provenance acceptance, reviewed compaction and measured quality promotion |
| Observed apps | Hooks/transcripts, capability-specific messages/questions and reviewed handover | Real vendor/version certification and controlled multi-app/compaction continuity acceptance |
| Office | Shared campus/floors, avatars, movement, doors/chairs/transit, camera and lighting | Sustained hardware/FPS and long-duration crowd/render acceptance |
| Delivery | Cross-platform packages, Web Bridge, npm install, recovery/update paths | Apple notarization and remaining capability-specific platform acceptance |

## Application milestones

| Version | Intended scope | State |
| --- | --- | --- |
| v0.1–v0.3 | Public foundation, workspaces, import and console | Historical milestones; current behavior is documented per module |
| v0.4 | Subagents and project orchestration | Current published preview line; v0.4.288 is the audited source baseline |
| v0.5 | Durable control and retained Knowledge/scanner scope | [Gate #60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60) open; substantial implementation does not certify acceptance |
| v0.6 | Evolve and autonomous learning | Some bounded learning slices already exist; broader acceptance remains future work |
| v1.0 | Stable extension SDK and production release | Future release scope; not an extra prerequisite silently added to v0.5 |

The original phase 0–9 sequence is a historical planning model, not a feature
completion percentage or the current milestone-to-version mapping. PRD v2
stages T0–T8 are dependency stages and do not reset the application to v2.0.
Use [version policy](../release/versioning.md), [tracking](../release/prd-v2-tracking.md)
and the [acceptance map](../product/prd-v2-acceptance-map.md) for current decisions.

## Next development order

1. Complete executor/descendant membership and writer fencing (V2-03).
2. Add reviewed physical-settlement reconciliation (V2-04).
3. Bind durable exact action approvals to actual effect-time execution (V2-05).
4. Require accepted evidence before releasing dependent tasks (V2-06).
5. Complete applicable durable delivery, Knowledge, scanner/platform and real
   worker acceptance without weakening those prerequisite gates.

Parallel documentation, skills and graph improvements may continue within
existing capabilities. Contracts, UI and mocks cannot bypass execution gates.
See [staged plan](../product/prd-v2-development-plan.md) for full dependencies.
