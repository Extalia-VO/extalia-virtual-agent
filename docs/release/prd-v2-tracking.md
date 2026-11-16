# PRD v2 GitHub tracking and version governance

Created: 2026-10-29. Scope: issue, label, milestone and dependency metadata;
no runtime version, release, tag, branch protection or application capability is
changed by creating the backlog.

Roadmap: [#38](https://github.com/Extalia-VO/extalia-virtual-agent/issues/38).
Source: [audit](../product/prd-v2-audit.md) and
[staged plan](../product/prd-v2-development-plan.md).

## Current implementation and release checkpoint

### GitHub reconciliation — 2026-11-13

Maintenance integration [#93](https://github.com/Extalia-VO/extalia-virtual-agent/issues/93)
collects the locally verified v0.4.289–294 profile storage, workspace recovery,
isolated Knowledge scheduling, native folder selection, discovery and documentation
updates. Main integration and package publication are separate steps. npm `latest`
is v0.4.288; GitHub's newer Desktop beta is the v0.4.288 prerelease, while its
stable/latest release still points to v0.4.227. README uses the release list and
keeps npm installation separate from Desktop downloads.

Live milestone checkpoints for v0.4, v0.5, v0.6 and Observe were reconciled, preserving
their titles, dates and open state. PR #85 was merged on 2026-11-10; earlier
"unmerged/unpublished" milestone notes no longer describe its status. Issues
#14, #38–40, #48, #54–55, #57, #59 and #60 now link the current scoped evidence and
retain their unchecked acceptance gates. In particular, pinned SkillSpector/Python
is verified on macOS 14+ ARM64; other scanner targets and general Python execution
remain open. No broad epic or v0.5 release gate was closed by this reconciliation.

### Historical documentation checkpoint — 2026-11-12

Reconciled 2026-11-12 at **v0.4.288**. The issue/label/dependency inventory below
is the original 2026-10-29 planning snapshot, not a fresh query of all live issue
states. This documentation update makes no GitHub issue, label or milestone
changes. Current implementation is mapped in the
[requirement checkpoint](../product/prd-v2-acceptance-map.md#current-implementation-checkpoint)
and [remaining work](../product/prd-remaining-work.md).

- The [v0.4.288 Desktop/Web/npm preview](v0.4.288.md) is a scoped release, distinct
  from the retained [v0.5 acceptance gate #60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60).
  A released 0.4 package does not automatically accept V2 work packages.
- Skills/Knowledge/meetings/curation/marketplace and observed control/handover now
  have implemented slices. Historical “missing scanner/learning/graph” statements
  are not current backlog. Full resolver/evaluation, cross-platform scanner,
  ACL/provenance and real multi-app acceptance remain explicit.
- V2-03/04/05/06 still govern complete ownership/fencing, physical reconciliation,
  effect-time grants and accepted evidence. Do not close these from contract,
  local-drain, load-receipt or UI evidence alone.
- ADR 0071 makes backend placement evidence-based. Retaining production
  TypeScript completion after measured Rust/Python comparisons is a decision,
  not a missed language-migration deadline. The specific bundled Python scanner
  is implemented on macOS 14+ ARM64; a general Python executor is not.

Before synchronizing GitHub statuses, read back each issue and reconcile its own
acceptance checklist with exact evidence. Do not infer closure from the numbers
of tests, commits or closed predecessor issues. Preserve later work and reviewed
scope exceptions when updating issue metadata.

## Version domains and milestones

- PRD `2.0.0-draft` identifies a document, not application `v2.0`.
- Application/package versions remain lockstep. Implementation increments use
  Unreleased notes, one `pnpm version:patch` and `pnpm check` per completed update.
- Stage T0–T8 is workflow classification, not a semantic version or release.
- Reuse existing release milestones and historical closed issues. Closing a
  predecessor means only its scoped work was closed; full acceptance remains
  explicit in the new gate issues.
- Integration verification is a nonrelease lane until a reviewed target-version
  decision; it carries no new release deadline or entitlement certification.

| Milestone | Use and release gate |
| --- | --- |
| [v0.4](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/4) | Existing product/project orchestration; PRD adoption and additive contracts |
| [v0.5](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/6) | Durable control, retained knowledge and scanner/Python acceptance; gate [#60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60) |
| [v0.6](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/7) | Reviewed learning/evaluation/Evolve; gate [#61](https://github.com/Extalia-VO/extalia-virtual-agent/issues/61) |
| [v1.0](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/5) | Stable declared SDK/portability/packaging scope; gate [#62](https://github.com/Extalia-VO/extalia-virtual-agent/issues/62) |
| [Integration verification: version TBD](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/8) | Per-engine/worker/version/account-mode investigation; not a release milestone |

Existing v0.1/v0.2/v0.3 milestones and historical due dates were left unchanged.
Those dates remain prior planning metadata; this backlog makes no new delivery
promise and does not certify the historical milestones against all PRD v2 tests.

## Work-package issue map

| Package | GitHub issue | Target milestone number |
| --- | --- | --- |
| V2-01 | [#39](https://github.com/Extalia-VO/extalia-virtual-agent/issues/39) | 4 |
| V2-02 | [#40](https://github.com/Extalia-VO/extalia-virtual-agent/issues/40) | 4 |
| V2-03 | [#41](https://github.com/Extalia-VO/extalia-virtual-agent/issues/41) | 6 |
| V2-04 | [#42](https://github.com/Extalia-VO/extalia-virtual-agent/issues/42) | 6 |
| V2-05 | [#43](https://github.com/Extalia-VO/extalia-virtual-agent/issues/43) | 6 |
| V2-06 | [#44](https://github.com/Extalia-VO/extalia-virtual-agent/issues/44) | 6 |
| V2-07 | [#45](https://github.com/Extalia-VO/extalia-virtual-agent/issues/45) | 6 |
| V2-08 | [#46](https://github.com/Extalia-VO/extalia-virtual-agent/issues/46) | 6 |
| V2-09 | [#47](https://github.com/Extalia-VO/extalia-virtual-agent/issues/47) | 6 |
| V2-10 | [#48](https://github.com/Extalia-VO/extalia-virtual-agent/issues/48) | 6 |
| V2-11 | [#49](https://github.com/Extalia-VO/extalia-virtual-agent/issues/49) | 8 |
| V2-12 | [#50](https://github.com/Extalia-VO/extalia-virtual-agent/issues/50) | 8 |
| V2-13 | [#51](https://github.com/Extalia-VO/extalia-virtual-agent/issues/51) | 8 |
| V2-14 | [#52](https://github.com/Extalia-VO/extalia-virtual-agent/issues/52) | 8 |
| V2-15 | [#53](https://github.com/Extalia-VO/extalia-virtual-agent/issues/53) | 8 |
| V2-16 | [#54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54) | 6 |
| V2-17 | [#55](https://github.com/Extalia-VO/extalia-virtual-agent/issues/55) | 7 |
| V2-17A | [#59](https://github.com/Extalia-VO/extalia-virtual-agent/issues/59) | 6 |
| V2-18 | [#56](https://github.com/Extalia-VO/extalia-virtual-agent/issues/56) | 5 |
| V2-19 | [#57](https://github.com/Extalia-VO/extalia-virtual-agent/issues/57) | 5 |
| V2-20 | [#58](https://github.com/Extalia-VO/extalia-virtual-agent/issues/58) | 6 |

V2-17A is the concrete v0.5 knowledge carryover child of V2-17. The v0.5 release
gate depends directly on that child, while V2-17 remains the v0.6 learning/meeting
package. This avoids requiring all Evolve work merely to certify the retained
knowledge subset, or silently dropping that subset from v0.5.

## Labels and workflow

New labels: `prd:v2`, `type:epic`, `status:blocked`, `status:needs-design`,
`status:needs-verification`, `release:gate`, `stage:t0-adoption` through the
nine T0–T8 stage labels, and focused `area:control-plane`, `area:queue`,
`area:skills`. Existing type/area/priority/legacy-phase labels are reused.

- `status:needs-design`: a concrete design/scope decision is required.
- `status:blocked`: identified delivery/activation prerequisites remain open;
  design/mock work can proceed only where its issue explicitly permits it.
- `status:needs-verification`: implementation/interface documentation alone
  has not established acceptance. Use actual evidence before promotion.
- `release:gate`: reviewed scope/evidence closure, never automatic publication.

Recheck status labels when dependencies/evidence change. Native dependency
relationships do not automatically synchronize these custom labels; no label
automation or required CI policy was installed by this metadata task.

Issue bodies include the PRD document version, package/stage/requirement IDs,
proposed owned files, target milestone, linked prerequisites, activation gates,
acceptance checklists and evidence status. All new work starts open. Existing
open #14/#16/#17 and closed scoped predecessors #13/#15/#26/#27/#28/#29 are
retained rather than rewritten or silently reopened.

## PR and release traceability

1. A branch/PR links its work-package issue and requirement IDs, and identifies
   the target milestone. Codex branches use the repository `codex/` prefix.
2. Record schema/state/ID compatibility, migration/rollback, exact ownership,
   denied/stale/restart tests and sanitized evidence. Do not link an unpublished
   local document as if it existed on the default branch; relevant issue scope
   is self-contained until a separately reviewed documentation PR publishes it.
3. Use `Closes` only for fully satisfied work packages; do not auto-close a parent
   roadmap or release gate merely because one implementation PR merged.
4. Preserve the distinction between implemented, acceptance-verified and
   released. A task/label/milestone closure is not a provider, account or platform
   certification. Keep scope exceptions explicit and reviewed.
5. New production dispatch/retry requires V2-03/04/05/06, regardless of permitted
   schema/mock development. V2-05 effect activation needs V2-03 and applicable
   V2-04; V2-09 Web acceptance needs the applicable V2-20 Bridge gate.
6. All required CI and applicable scoped release evidence must pass before
   publication. No new tag, npm login, installer or release is created here.

GitHub dependency/sub-issue metadata supports planning and review. It does not
replace execution authority, CI checks or branch-protection enforcement. No
branch-protection settings or existing release holds were changed by this task.

## Verification

GitHub readback verified on 2026-10-29: 25 new open issues, 18 new labels,
one nonrelease milestone, 24 parent/sub-issue relations and 75 blocking relations
match the planned mapping. Existing issue bodies/states/labels/milestones and
existing milestone titles/descriptions/states/dates and label definitions were
preserved. No new issue has an assignee; the dependency graph is acyclic.

This document and mapping do not themselves implement or certify the backlog.
