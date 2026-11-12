# Product requirements and implementation status

Reconciled against **v0.4.288**, 2026-11-12. A PRD document version is not an
application release version. Specifications describe required behavior; dated
implementation records describe evidence, and acceptance gates stay separate.

## Read in this order

1. [Status by module](../modules/README.md): what exists and its limits.
2. [App-flow and live-agent tracker](prd-app-flow-and-live-agents.md#11-status-tracker):
   current product work and versioned implementation entries.
3. [v1.1 gap map](prd-v1.1-gap-map.md): original Native/skills/knowledge requirements
   and their remaining work.
4. [PRD v2 acceptance map](prd-v2-acceptance-map.md): requirement → backlog →
   evidence → release applicability. Contracts are not execution acceptance.
5. [Remaining work](prd-remaining-work.md) and [staged development plan](prd-v2-development-plan.md):
   next work, dependencies and exit gates.
6. [GitHub tracking](../release/prd-v2-tracking.md): issues/milestones and open gates.

The [v0.5 gate #60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60)
remains open. Published v0.4.288 and passing integration/release CI do not close
executor ownership, physical reconciliation, exact approvals or retained
Knowledge acceptance. There is no evidence-based aggregate completion percentage.

## Requirements and planning documents

| Document | Role |
| --- | --- |
| [App flow and live agents](prd-app-flow-and-live-agents.md) | Current app-flow requirements and implementation tracker |
| [Observed agent control](prd-observed-agent-control.md) | Source-bound control requirements and provider acceptance |
| [Master PRD v1.1 / patch v1.1.1](master-prd-v1.1/README.md) | Preserved imported specification; use the gap map for current implementation |
| [PRD v2 source audit](prd-v2-audit.md) | Historical intake/compatibility audit plus current reconciliation |
| [Native orchestration handoff](native-orchestration-v1-handoff.md) | Incremental mission contracts and dated gate evidence |
| [Native harness review](native-harness-development-review.md) | Dated harness/memory/skills audit with current limitations |

Latest applicable [architecture decisions](../adr/README.md) resolve superseded
technical plans. ADR 0071 retains measured TypeScript provider execution; it does
not require a complete language rewrite. Never rewrite historical test results
as if they ran on the current version.

## Module review and evidence directory

Review documents retain their original versions, test scope and known failures.
They support a status claim within that scope; they are not a new acceptance run.

| Module | Reviews |
| --- | --- |
| Skills | [Skill library](skill-library-review.md) |
| Knowledge | [Graph](knowledge-graph-review.md) |
| Office avatars | [Portrait](avatar-portrait-review.md), [feet](avatar-foot-review.md), [shirt](avatar-shirt-review.md), [garment fit](garment-fit-review.md) |
| Office movement | [Natural walking](natural-walking-review.md), [doors/crowds](door-movement-review.md), [chair movement](chair-movement-review.md), [static seating](static-seating-review.md), [floor contact](floor-contact-review.md) |
| Office camera and lights | [Follow](character-follow-review.md), [night lighting](night-lighting-review.md) |
| Office assets | [Asset intake](asset-intake.md), [building](building-blender-integration.md), [interior](interior-blender-integration.md), [chairs](chair-blender-integration.md), [team pod](team-pod-blender-integration.md), [workstations](workstation-blender-integration.md), [desk rigging](desk-rigging-review.md), [devices](workstation-device-review.md) |

Raw measurements and versioned evidence live in [architecture](../architecture/README.md),
[benchmarks](../benchmarks/README.md) and [Office/provider measurements](../bench/README.md).
The [initial repository audit](../implementation/REPO_AUDIT.md) and
[migration ledger](../migration/ledger.md) are historical references.

## Update protocol

For a feature change, update its requirement row, module hub and linked guide.
Record the version/commit, evidence type (source, automated test, mock UI,
real provider, package/platform), remaining gate and next acceptance step.
Use **implemented**, **partial**, **not implemented** and **acceptance pending**
with the [shared definitions](../modules/README.md#reading-status).
Documentation cleanup changes no runtime version or release certification.
