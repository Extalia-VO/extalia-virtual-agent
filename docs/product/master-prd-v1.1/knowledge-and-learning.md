# Extalia Knowledge, Obsidian and Continuous Learning — v1.1

## Vault model (locked)
- `vaults/<profile>` (for example `vaults/work`, `vaults/personal`, `vaults/client`) isolated by canonical filesystem roots and per-profile ACL.
- `vaults/Shared` optional, **publish only after explicit authorization and sanitization**; no implicit cross-profile lookup.
- Obsidian installation is optional. Markdown and `[[wikilinks]]` remain readable in any editor.

## Note taxonomy
`Knowledge/`, `Experiences/`, `Projects/`, `Skills/` (references and documentation, **not auto-executable files**), `Decisions/`, `Learning/Reviews/`.

Example:
```markdown
---
id: know.laravel.n-plus-one
kind: knowledge
profile: work
verification: verified
source_task_ids: [task-123]
revision: 3
---
# N+1 Query Optimization
Related: [[Laravel Eloquent]], [[MySQL Indexing]]
Learned from: [[Experiences/Example-Query-Optimization]]
```

## Graph architecture
- Markdown files are source of authored knowledge; SQLite graph is rebuildable index.
- Nodes: notes, skills, tasks, projects, agents; typed edges: related_to, learned_from, depends_on, supersedes, used_by.
- Obsidian graph uses wikilinks; Extalia graph uses typed indexed edges and ACL-filtered queries.
- Handle aliases, duplicate titles, missing targets, renames, cycles, broken links, backlinks, and case sensitivity across OSes.
- Only show bounded local subgraphs; lazy-load graph UI.

## Sync contract
- Watch authorized vault roots; debounce, validate frontmatter and UTF-8, protect against symlink traversal.
- Atomic writes with compare-and-swap hash; concurrent modifications create conflict copy + review record; never silently overwrite user-owned notes.
- Preserve history (Git or revision journal), backups and rollback; no auto-delete.
- Notes from external editors remain untrusted data, even when in approved vault. Editing note metadata does not change runtime ACL or approve skills.

## Learning contract
L1 experiences: bounded redacted events, task evidence, outcome confidence, timestamps, agent/source provenance.
L2 knowledge: merge verified findings into Extalia-managed notes, with attribution and conflict detection.
L3 skills: create candidate only; mandatory inspection, permission check, compatibility, sandbox evaluation, risk-based activation.

Trigger revalidation on dependency changes, contradictory evidence, or outdated versions. Do not run continuous expensive embedding scans. Human edits and review always override autonomous proposals within authorized policy.

## Evaluation
Compare verified task results against baseline, segment by difficulty and workspace, track regression, cost and user corrections; insufficient samples = `insufficient_evidence`, not `improved`.
