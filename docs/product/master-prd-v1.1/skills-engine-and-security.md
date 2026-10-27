# Extalia Skills Engine and Security — v1.1

## Immutable lifecycle
`discovered → quarantined → inspected → validated → evaluated → awaiting_approval | auto_eligible → active → deprecated | revoked`.

No shortcut from discovered/quarantined to active. Mutation produces a **new revision**, never edits an active approved package in place. The active index references immutable `revision_id` and attestation ID.

## Skill manifest (Extalia proposal; not NVIDIA schema)
```yaml
id: laravel-query-optimization
version: 1.2.0
categories: [development.backend.laravel, development.database.mysql]
intents: [optimize_query, fix_n_plus_one]
compatibility:
  php: '>=8.2'
  laravel: '>=11'
dependencies: []
conflicts: []
permissions:
  filesystem_read: ['workspace/**']
  filesystem_write: []
  network: false
  terminal: false
  secrets: false
risk_class: declarative
```

## Category router
1. Infer categories from deterministic index (aliases, intent, workspace stack).
2. SQL indexed lookup for candidate skill IDs, not all SKILL.md contents.
3. Apply status/hash/security, profile ACL, capability, version, permission, dependency and conflict filters.
4. Rank eligible candidates; load selected skill content only.
5. On ambiguity use scoped semantic fallback if configured; otherwise request clarification or proceed without a skill.
6. Record selected skills and reasons. Hot reload index transactionally.

## Security gate
- Stage untrusted package in quarantine; canonicalize paths, reject symlink/path traversal and oversized packages.
- Pin and verify installed SkillSpector release; execute with fixed arguments established from that release's official CLI and validate its JSON schema.
- Complete inspection required; incomplete/timeout/tool missing = quarantine; critical/high = block; medium = human review; low = conditional policy.
- Independently inspect dependency integrity, tool grants, malicious file references and compatibility; run evaluation in isolated disposable workspace.
- For declarative low-risk candidates, auto-activation only under preauthorized grants and after all gates pass; others require human approval.
- Enforcement at execution boundary, never merely by prompt. No self-approval, no scanner bypass, no autonomous policy edits.

## Minimal SQLite entities
`skill_packages(id, origin, profile_id, status)`;
`skill_revisions(id, package_id, version, tree_sha256, manifest_json, created_at)`;
`skill_categories(id, parent_id, slug)`;
`skill_category_map(revision_id, category_id)`;
`skill_intents(revision_id, intent)`;
`skill_inspections(id, revision_id, scanner_version, policy_version, completeness, verdict, report_ref, scanned_at)`;
`skill_permissions(revision_id, capability, scope)`;
`skill_approvals(id, revision_id, approved_hash, profile_id, granted_scope, approver, expires_at)`;
`skill_dependencies(revision_id, required_skill_id, constraint)`;
`skill_evaluations(id, revision_id, baseline_id, result, evidence_ref)`;
`skill_activations(profile_id, package_id, revision_id, activated_at)`.

Add FK/uniqueness constraints and append-only audit records. Scanner reports and skill contents should be redacted before telemetry/export.

## Nonfunctional acceptance
- Never scan on each invocation; verify cached attestation and hash against immutable package.
- Background scan worker bounded by concurrency/time/memory.
- Test denial paths, policy upgrade invalidation, altered bytes, dependencies, revoked approvals, multi-category selection, and profile isolation.
