# PRD v2 canonical acceptance map

Date: 2026-10-29. Scope: V2-01 / [#39](https://github.com/Extalia-VO/extalia-virtual-agent/issues/39).
This is the canonical requirement → backlog → planned acceptance → release
applicability crosswalk for compatible adoption under
[ADR 0036](../adr/0036-prd-v2-compatible-adoption.md). It covers all 40 FR and
18 NFR from the [audit](prd-v2-audit.md). Requirement priorities and identifiers
are retained; applicability reconciles conflicting incoming release statements.

The [staged plan](prd-v2-development-plan.md#5-kasus-acceptance-tambahan-yang-harus-diwujudkan)
defines AR-01–AR-34. These are **planned scenarios**, not a claim of runnable tests
or passing results. A mapped scenario may cover only part of a requirement;
suite families below retain the remaining obligations. Each implementation must
attach runnable assertions, commands, fixture/build/platform/version, observed
result, artifact digest and reviewer before its applicable gate closes. Existing
tests count only after their assertions and traceability are reviewed.

Work-package IDs resolve through the
[GitHub issue map](../release/prd-v2-tracking.md#work-package-issue-map).
V2-17A is the retained v0.5 knowledge child; V2-17 holds later learning/meeting
work. V2-02A/B/C/D add capability-manifest, scoped identity-map, task-state and
delegation-intent contracts plus pure read-only legacy/attenuation/replay inspection
inside V2-02. They do not establish
all T1 mappings, authoritative acceptance/record resolution, transition admission,
delegation or runtime activation. AR-01–04 remain open beyond these bounded tests.

## Current implementation checkpoint

Reconciled **2026-11-12, v0.4.288** against checked-in source, test assertions and
existing dated evidence. This is a documentation audit, not a fresh live-provider,
scanner, installer or hardware run. The original 2026-10-29 requirement/suite
mapping below is retained. [Release notes](../release/v0.4.288.md) describe the
distributed preview; [remaining work](prd-remaining-work.md) orders follow-up.

- **Implemented slice**: named functionality is present with supporting tests or
  recorded evidence; it does not certify the entire FR or every platform.
- **Partial**: implemented foundations plus explicit unfulfilled obligations.
- **Planned**: no production implementation of the named v2 expansion established.
- **Acceptance open**: evidence needed before the complete requirement/release gate
  can be marked done. Planned AR identifiers alone never count as passing tests.

| FR | Current implementation / evidence | Unfinished acceptance or expansion |
| --- | --- | --- |
| 001 | Partial: profile-scoped core/index and stable workspace vault profiles; ADRs 0024/0074 | Complete profile manager, ACL/sharing and simultaneous-profile cases |
| 002 | Implemented slice: workspace folders, explicit moves and observed association; ADRs 0059/0076/0078 | v2 engine generation, trust/migration and switch authority |
| 003 | Partial: Native/Hermes selection and capability contracts | Formal multi-engine registry and safe switch/reconciliation |
| 004 | Implemented slice: Native API Chat, teams and mission coordinator | Complete provider-free v2 vertical slice and durable authority gates |
| 005 | Partial: additive engine/state/identity/delegation contracts in protocol | Authoritative runtime translator/receipt and lifecycle conformance |
| 006 | Partial: worker capability/intent contracts | Production worker seam with complete lifecycle/auth/ownership proof |
| 007 | Acceptance open: scripted-provider and existing Native executor evidence | One permitted external worker certified by actual version/account/mode |
| 008 | Implemented slice: DAG planning, budgets, leases and mission UI | Accepted evidence/waiver before dependency release (V2-06) |
| 009 | Partial: durable mission checkpoints/leases and provisional reservations | Canonical jobs, command intents/receipts, replay-safe dispatch/outbox |
| 010 | Partial: existing tool policy, pending action intents and exact skill approvals | Durable effect-time actor/target/arguments/expiry/revocation authority |
| 011 | Implemented slice: managed/imported/observed history and canonical handover ledger; ADR 0076 | Unified v2 ownership/index and complete registry/restore acceptance |
| 012 | Implemented slice: Extalia Protocol, generated schemas, durable mission journal | Workspace inbox/outbox/cursors and authoritative v2 runtime mapping |
| 013 | Implemented slice: shared Chat/Observe/Missions/Files/Git/Knowledge/Grimoire | Complete no-WebGL primary-action and accessibility certification |
| 014 | Implemented slice: shared event-driven Office, freshness, hierarchy and follow | Canonical instance/generation mapping and full v2 acceptance |
| 015 | Implemented slice: source-safe parsers/import and retained source archives | Complete per-source version/revision/tombstone acceptance |
| 016 | Implemented slice: authenticated loopback Bridge with Host/Origin defenses | Full installation pairing/per-client scope/revoke cases BRG-01–10 |
| 017 | Partial: redacted portable sessions and retained handover archives | Consistent selected mission/evidence/settings export snapshot |
| 018 | Implemented slice: public-safety checks, provenance inventory and release checksums | Full source-history/SBOM/provenance review; no repository rewrite mandate |
| 019 | Implemented slice: existing Hermes runtime, hooks and observer | Formal engine lifecycle/profile switch acceptance |
| 020 | Planned: OpenClaw engine | Gateway policy, lifecycle, scopes, reconnect and reconciliation |
| 021 | Implemented slice: observed Codex control routes; ADRs 0060–0064 | Dedicated managed v2 worker and version/mode certification; hook trust is separate |
| 022 | Implemented slice: Claude Code observer/hooks and capability-bound messaging | Managed CLI/SDK worker with independent auth/policy/ownership acceptance |
| 023 | Implemented slice: categorized catalog, immutable revisions, managed automatic loading and marketplace; ADRs 0073/0077 | Authoritative dependency/compatibility integration and full dispatch parity |
| 024 | Implemented slice: real pinned SkillSpector 2.13.4/bundled Python on macOS 14+ ARM64; ADR 0068 | Intel macOS/Windows/Linux isolation and code/tool evaluation; scan never activates |
| 025 | Implemented slice: isolated write-task worktrees, inspection/proposals and digest-bound validation | Production test gate is not run and Apply refuses; isolated executor, Rust writer fencing, complete physical ownership and reconciliation remain open |
| 026 | Implemented slice: editable 2D/3D Markdown Knowledge, team meetings and scoped curation; ADRs 0065–0067/0074–0075 | V2-17A ACL/CAS/provenance acceptance, cross-store conflict and quality evaluation |
| 027 | Implemented slice: saved teams, connection-owned delegates and Office hierarchy | Complete child membership, engine-qualified authority and routing |
| 028 | Implemented slice: transcripts/hooks/MCP, freshness and observed association; ADR 0078 | Source/version/mode certification and full failure matrix |
| 029 | Implemented slice: pending prompts, supported steer/control routes and cooperative inbox receipts; ADRs 0064/0072 | Per-route real-app acceptance; submitted/queued never means applied or settled |
| 030 | Partial: capability restrictions and explicit unavailable control routes | Complete backend per-surface/account entitlement registry before new workers |
| 031 | Partial: existing platform notifications | Scoped optional channel adapter and identity/replay acceptance |
| 032 | Planned: public extension SDK | Versioned public contracts/compliance and permission isolation |
| 033 | Implemented slice: updater, guarded restart, cross-platform preview artifacts | Full signing/notarization/channel/rollback and clean-machine matrix |
| 034 | Implemented slice: Gemini/Antigravity import, hooks, source-bound messaging | Independent managed-surface policy/version evidence; no blanket wrapper clearance |
| 035 | Planned: Kiro managed worker | ACP version/mode, entitlement, cancellation and lifecycle proof |
| 036 | Implemented slice: licensed campus/interior/avatars and interactive facilities | Profile/building/room designer and representative hardware acceptance |
| 037 | Partial: session interchange | Full multi-store restore dry run, migration/conflicts and rollback |
| 038 | Planned: executable plugin host | Out-of-process isolation/broker before executable activation |
| 039 | Implemented slice: token/task/time/concurrency budgets and reported cache usage | Fine cost/pricing provenance, full failure accounting and inherited caps |
| 040 | Implemented slice: EN/ID UI and preserved user text | Complete localization/accessibility audit and optional language packs |

All 18 NFRs below retain **acceptance open** for their complete declared scope.
Existing CI, release artifacts, security tests and benchmark snapshots support
bounded assertions; they do not prove pilot scale, all-platform scanner support,
whole-app FPS/RSS, complete accessibility, broad provider entitlement or full
restore. ADR 0071 keeps production completion in TypeScript after measured Rust
and Python prototypes; a language migration is not an outstanding acceptance
requirement by itself. The generic Python executor remains planned, independently
of the implemented specific SkillSpector worker.

The v0.4.288 release closes its scoped publication work, not V2-03/04/05/06 or the
[v0.5 gate #60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60).
Do not calculate completion percentages from this table or test counts.

## Source integrity and applicability

The incoming archive contains 10 Markdown documents. Audit source digest:
`88db9001964a0f11c4602e47addde8f5f0d5d75cfa81f5eefaaa10b5c83e5db9`.
Refer to the audit source inventory for filenames/sections; original private
identity examples are not copied into this public map. Incoming F0/C1/N2/U3/A3/H4/
O4/X4/W5/I5/S5/K5/G5/R6 and suite IDs remain source references, not executable
project tasks or evidence. Invalid schema/version/ownership examples are resolved
by ADR 0036; their text is not adopted verbatim.

| Code | Gate applicability |
| --- | --- |
| R | Preserve existing behavior and security in every increment that touches it, including 0.4.x; no regression waiver from a later milestone. |
| V05 | Retained v0.5 acceptance: durable control, scoped profiles/delivery, knowledge V2-17A, scanner/Python and compatibility; omissions need explicit roadmap/ADR amendment. |
| A | Core v2 alpha claim: T1–T4, one real permitted worker, minimal source-safe import/export, applicable Bridge/security/platform evidence. Mock-only remains preview. |
| F | Before enabling or claiming the named optional engine/adapter/feature; integration verification is version TBD. If promised in a release, it gates that release. |
| V06 | Reviewed learning/evaluation/Evolve v0.6 acceptance, preserving earlier gates. |
| S | Declared stable/v1 scope: full restore, SDK/isolation, packaging, required CI and release hardening. Existing behavior remains subject to R earlier. |

Codes are cumulative when listed together. A feature's incoming P1/P2 priority
cannot postpone a security prerequisite of an earlier path: entitlement clearance
precedes the first real worker, executable isolation precedes executable plugins,
and exact approvals/fencing precede production dispatch. Hermes/OpenClaw E2E gates
their feature claims, not every core alpha. OpenCode is the first candidate; final
vendor selection and per-account/mode certification remain open. Document v2 does
not reset the application version or publish a release.

## Functional requirements

| Requirement | Backlog owner scope | Planned AR / retained source suite obligations | Applies |
| --- | --- | --- | --- |
| FR-001 Profile isolation | V2-07; V2-05, V2-17A | AR-14, AR-27; WS-01–10, profile ACL/settings/skills/knowledge isolation | R, V05, A |
| FR-002 Workspace manager | V2-07; V2-09 | AR-14, AR-18; WS-01–10, canonical paths and engine pointer migration | R, V05, A |
| FR-003 Engine selection | V2-02, V2-07; V2-12/13 per engine | AR-01–03, AR-14, AR-22–24; ENG/SW, honest availability and preserved runtime IDs | R, V05, A; F external engines |
| FR-004 Native coordinator | V2-02, V2-06, V2-09 | AR-12, AR-18/19; NAT, manual coordinator independent of API executor | R, V05, A |
| FR-005 Engine contract | V2-02; V2-08, V2-09 | AR-02–04, AR-16/17; ENG-01–08, receipts and reconciliation, unsupported invokes no driver | R, V05, A |
| FR-006 Worker contract | V2-02; V2-11, V2-14/15 | AR-03/04, AR-21/25; WKR, per-mode lifecycle, version, ownership and auth | A; F each worker |
| FR-007 Real worker proof | V2-09, V2-11; approved substitute scope if selected | AR-18, AR-21/25; WKR/OC, mock plus actual permitted worker and artifacts | A |
| FR-008 Mission DAG | V2-02, V2-04, V2-06 | AR-02/04, AR-07/08, AR-12/13; DAG/NAT, versioned plan and dependency policy | R, V05, A |
| FR-009 Durable queue | V2-03/04/05/06, V2-08 | AR-05–08, AR-15–17; QUE/REC, durable claim/intent/receipt and unknown reconciliation | V05, A |
| FR-010 Approval/PDP | V2-05; V2-03/04, V2-20 | AR-09–11, AR-33/34; PDP, exact actor/scope/digest/expiry/revocation at effect | R, V05, A |
| FR-011 Session registry | V2-07/08/09/10; V2-18 full portability | AR-01, AR-14, AR-17/20/28; SES, managed/imported/linked/observed index, archive/trash/search | R, V05, A; S full restore |
| FR-012 Event protocol | V2-02, V2-08 | AR-01/02, AR-15–17; EVT, inbox/outbox/cursor, redaction and compatibility | R, V05, A |
| FR-013 2D core UI | V2-09; V2-19 | AR-18/19, AR-31; UI/A11Y, complete no-WebGL primary workflows | R, A; S certification |
| FR-014 Office core | V2-02, V2-09; V2-19 | AR-02/17/19/31; OFC, instance/generation/freshness and no fabricated activity | R, A |
| FR-015 Safe import | V2-10; V2-07/09 | AR-01/14/20; IMP, source hashes unchanged, revision/dedupe/preview/tombstones | R, A |
| FR-016 Local Bridge | V2-20; V2-05/09 | AR-32–34; BRG-01–10 and SEC, backend pairing/scopes/revoke | R, V05, A for Bridge paths |
| FR-017 Owned-data export | V2-10; V2-18 full portability | AR-20/28; PORT, consistent selection/checksums/schema/provenance and secret exclusion | R, A minimal; S full |
| FR-018 Safe public repository | V2-01, V2-19 | AR-30/31 plus F0/REL/source-integrity checks below; revalidation under ADR 0001, no rewrite mandate | R, A, S |
| FR-019 Hermes engine | V2-12; V2-07/08 | AR-14/22/24; HM-01–08, actual profile/lifecycle/control-mode evidence | R existing modes; F formal engine |
| FR-020 OpenClaw engine | V2-13; V2-07/08 | AR-23/24; CL/SW/DEL, scoped Gateway handshake, receipts/revoke/reconcile | F |
| FR-021 Codex worker | V2-14; V2-11 common compliance | AR-21/25; CX/WKR, app-server/SDK modes separate, hook trust is not task ownership | R observe/import; F managed |
| FR-022 Claude Code worker | V2-14; V2-11 common compliance | AR-21/25; CC/WKR, CLI and SDK auth/permission distinctions | R observe/import; F managed |
| FR-023 Skills registry | V2-16; V2-03/05 | AR-09/11/26; SKL, immutable revisions, dependency/router closure, enforcement parity | R, V05; F new capabilities |
| FR-024 Skill scanner | V2-16 | AR-26; SKL, verified pin/license/report, quarantine/attestation, explicit trust, bundled supervised Python | R containment, V05 |
| FR-025 Git/worktrees | V2-03/04/05/06; V2-19 | AR-05–13, AR-21; GIT, writer fencing/physical ownership, review before merge/push | R, V05; A applicable write path |
| FR-026 Knowledge/meetings | V2-17A retained knowledge; V2-17 meetings/learning | AR-27; KNO, CAS/history/ACL/provenance/review; meetings need real participants/evidence | R, V05 knowledge; V06/F expansion |
| FR-027 Roster/subagents | V2-02, V2-03, V2-09; V2-12/13/16 | AR-01/04/05/19/22/24/26; persistent identity vs live instance, complete child membership and honest presence | R, A; F engine-specific routing |
| FR-028 Observer bridge | V2-09, V2-12/14/15 | AR-01/20/22/25; HM/CX/CC/GG, tested-version metadata/freshness, no hidden control | R; F each new source/mode |
| FR-029 Queue/live steer | V2-02, V2-08, V2-11/14/15 | AR-03/16/21/25; WKR, negotiated queue vs steer, receipt distinct from applied instruction | R unsupported honesty; F |
| FR-030 Provider entitlement | V2-02, V2-05, V2-11/14/15 | AR-03/09/11/25; SEC/WKR and per-surface policy evidence, backend blocked state | A before real worker; F every mode |
| FR-031 Notifications/channels | V2-18 | AR-29; MSG/SEC, optional inbound/outbound identity/scope/replay; concrete channel cases still required | R existing notifications; F |
| FR-032 Public extension SDK | V2-02, V2-18 | AR-02/03/29; SDK, version compatibility/compliance; isolation before executable activation | F, S |
| FR-033 Safe updater | V2-19 | AR-30; REL/UPD, packaged per-OS/arch, signing/channel, defer active-work restart/rollback | R, F packages, S |
| FR-034 Google surfaces | V2-15 | AR-25; GG, Gemini/Antigravity/CLI/API independently verified; prohibited consumer wrapper denied backend | R observe/import; F managed |
| FR-035 Kiro worker | V2-15 | AR-25; KR, ACP version/mode negotiation, refuse/cancel, entitlement independent of technical PoC | F |
| FR-036 Advanced Campus | V2-09, V2-19; feature scope decision required | AR-19/31; OFC/PERF, profile/building/room data and licensed assets; designer cases still required | R visuals; F expansion, S promised scope |
| FR-037 Portable restore | V2-18; V2-10 prerequisite | AR-20/28; PORT, schema/conflict preview, dry run, interruption/rollback and source untouched | F, S |
| FR-038 Plugin isolation | V2-18; V2-05 | AR-09/11/29; SDK/SEC, privileged API separation, permission broker/revoke and supply chain | Before any executable plugin; S |
| FR-039 Fine budgets | V2-02/03/05/06/08; V2-11/16 | AR-04/06/11/24/26 plus budget-specific cases to add; inherited caps, time/token/task/cost limits and reported vs estimated usage | R existing limits; A delegated caps; F finer pricing |
| FR-040 Languages | Every touched UI package; V2-19 | AR-19/31; EN/ID i18n, locale displays, user content unchanged, pluggable packs later | R immediately; F packs, S certification |

## Non-functional requirements

| Requirement | Backlog owner scope | Planned acceptance / remaining measurements | Applies |
| --- | --- | --- | --- |
| NFR-001 Platforms | V2-19; each feature owner | AR-30/31; actual packaged OS/architecture/browser smoke, pinned runtime/scanner support per claim | R claimed targets; A, F, S |
| NFR-002 Local-first | V2-09, V2-07/08 | AR-14/18/19; offline local planning/history and no mandatory inference/analytics | R, V05, A |
| NFR-003 Reliability | V2-03/04/08 | AR-05–08, AR-15–17; atomic state/event/intent, crash boundaries, idempotent projection | R, V05, A |
| NFR-004 Performance | V2-09/19 | AR-31; declared scene/hardware: incoming 30 FPS/20 avatars target, aspirational 60 FPS separately; preserve accepted campus >40 FPS target | R, F changed scene, S |
| NFR-005 Responsiveness | V2-08/09/19 | AR-31; measured local command ACK p95 <250 ms target when DB unblocked, provider latency separate | A measured scope; S |
| NFR-006 Event delivery | V2-08/09/19 | AR-17/31; measured local propagation p95 <1 s target, paused OS/provider exclusions, durable cursor recovery | R, A, S |
| NFR-007 Availability | V2-03/04/08, V2-12/13 | AR-05–08/15/16/22/23/30; restart data preserved, unknown quarantined, engine outage contained | R, V05, A; F mixed engines |
| NFR-008 Security | V2-03/05/16/18/20 | AR-06/09–11/25/26/29/32–34; exact authority, sandbox/secret/least privilege and Bridge defenses | R, V05, A, F, S |
| NFR-009 Accessibility | V2-09/19 | AR-19/31; no-WebGL all primary actions, keyboard/contrast/reduced motion/assistive technology; WCAG 2.2 AA target needs review | R, A primary parity; S certification |
| NFR-010 Localization | Every touched UI package; V2-19 | AR-31; EN/ID strings and date/time/currency display, no translation of user content | R immediately; S |
| NFR-011 Privacy | Every new data/effect path; V2-10/18/19 | AR-20/25/28/31; canaries before persistence/logs/export, opt-in diagnostics, no prompt telemetry upload | R, V05, A, F, S |
| NFR-012 Portability | V2-10/18 | AR-20/28; owned-data checksum/schema snapshot, secrets excluded, cross-schema migration/rollback | R, A minimal; S full |
| NFR-013 Maintainability | V2-01/02/18/19 | AR-01/02/29/30; one schema authority, boundaries, semver/migrations/CI, public SDK and no private paths | R, A, F SDK, S |
| NFR-014 Supply chain | V2-16/18/19 | AR-26/29/30/31 plus source-integrity gates below; pins/lockfiles/license/SBOM/distributed artifact provenance/signing | R, V05 scanner/Python; F, S |
| NFR-015 Pilot scale | V2-08/12/13/14/15/19 | AR-17/31 plus load fixtures: three engine connections, ten concurrent adapter sessions, 10k indexed sessions; targets, not measured capacity | F scale claim; S promised scope |
| NFR-016 Network | V2-20; V2-05 | AR-32–34; loopback default; remote web explicit enablement, secure transport/auth/scopes, no accidental LAN | R, A Bridge; F remote, S |
| NFR-017 Observability | V2-08/09/19 | AR-15–17/31; correlation/receipts, durable timeline/dead-letter, heartbeats and diagnostic health; add endpoint-specific cases | R, V05, A |
| NFR-018 Offline degradation | V2-09; V2-12/13 | AR-18/19/22/23; retained 2D data/Office, last-seen/reason indicators and unavailable execution | R, A; F external engines |

## Explicit Bridge gates

FR-016/NFR-008/NFR-016 include every BRG gate, even where another suite covers
the same threat. V2-20 owns implementation; V2-05 owns permission integration.
Current loopback/Host/Origin/token defenses stay in place during pairing rollout.
Client/UI checks alone cannot satisfy these gates.

| Source gate | Required assertion | Planned scenario |
| --- | --- | --- |
| BRG-01 | Default local bind has no accidental LAN listener | AR-32 |
| BRG-02 | Unpaired origin cannot access privileged API | AR-32 |
| BRG-03 | Malicious WebSocket Origin is denied | AR-32 |
| BRG-04 | Host/DNS rebinding is refused | AR-32 |
| BRG-05 | Cross-site request forgery cannot invoke an effect | AR-32 |
| BRG-06 | Explicit pairing grants only requested client identity/workspace scope | AR-33 |
| BRG-07 | Hidden endpoint/body changes cannot broaden granted capability | AR-33 |
| BRG-08 | Revoke/expiry denies next request and reconnect, including applicable open SSE/WS flows | AR-34 |
| BRG-09 | Rate limits bound authentication brute force | AR-32 |
| BRG-10 | Generic endpoints cannot obtain shell or approval authority | AR-32/33 |

## Cross-cutting source and release gates

V2-19 retains F0/REL public-safety obligations before a distributed artifact is
claimed safe: source/license attribution, Git history review, build inputs,
dependencies/lockfiles/SBOM, assets and hashes, package/tarball contents, secret and
private-term scans, signing/provenance and clean-profile package smoke. A source
lint pass alone does not certify history, binaries, licenses or whole release
provenance. Keep synthetic fixtures and record reproducible archive/artifact
digests; do not publish the unsanitized incoming pack as a shortcut.

The DB/ART/AUD/QA/EXEC/CLI/UI-SEC/SDK/REL/UPD source placeholders still require
individual runnable cases and owners. AR-01–AR-34 are an acceptance design, not a
blanket replacement for missing assertions. In particular budget pricing/cap
boundaries, advanced room editing, channel identity and pilot-scale load need
concrete cases before their feature claim. Per-platform sandbox feasibility and
per-mode/account policy clearance remain open evidence, independent of mock or
structural contract conformance.

No production queue dispatch/retry, terminal reconciliation, engine switch,
approval activation, skill activation or executable plugin is enabled by this
map. Preserve quarantine where membership, external outcome or writer/worktree
settlement is unknown. Changes to other applications still need dry run, explicit
approval, backup and undo; tests use temporary profiles. Implementation completion
retains Unreleased notes, one patch increment and required `pnpm check`; required
CI and actual supported package/platform evidence precede publication.
