# Built-in skills

Open **Skills**, then **Browse built-in skills** to jump to the bundled library.
It is available with both the TypeScript host and the preview Rust core; it does
not require importing a package or configuring a scanner.

The current app bundles eleven instruction sets:

| Category | Skills |
| --- | --- |
| Planning | `plan-feature`, `memory-recall` |
| Development | `debug-issue`, `refactor-safely` |
| Quality | `code-review`, `write-tests` |
| Security | `security-review` |
| Documentation | `explain-codebase`, `update-docs`, `caveman` |
| Delivery | `commit-changes` |

Search matches names, descriptions and category labels. Multiple search words
must all match. Category buttons show counts for the entire received catalog;
the match count shows how many remain after both filters. **Clear filters**
returns to the whole catalog. Search does not inspect instruction bodies.

**Read instructions** opens the bundled text as a read-only disclosure, with
ordinary keyboard controls. It is displayed literally: Markdown, HTML and code
inside instructions are never executed by the preview. The text is supplied by
the host and is not translated when you change interface language.

An older host can still list names and descriptions without extra metadata.
Such entries appear under **Uncategorized** and the disclosure explains when
instructions are not included. Unknown categories and malformed/oversized body
metadata are omitted rather than invented or silently truncated. Catalog
filters and open disclosures are temporary view state.

This is a catalog of the bundled definitions, not a report of the exact skill
revision offered to an individual agent. Agent offerings now use canonical
shipped definitions: an external file cannot replace one by using the same name
or claiming a builtin source. External instructions require the scanner-gated
registry workflow. Reading text and choosing a category do not run a skill, select
it for a task, change permissions, import a package, or approve an activation.

`memory-recall` guides selective metadata search and paged reads of relevant
[workspace memory](workspace-memory.md). It tolerates memory being disabled.
`caveman` is independently written concise-response guidance inspired by the
[upstream project](https://github.com/JuliusBrussee/caveman), activated only by
an explicit user request. Technical precision and requests for detail win over
brevity. Neither installs upstream hooks/proxies or automatically receives
upstream updates; changes ship through reviewed Extalia releases.

Imported/project skills retain their existing review and scanner requirements.
Automatic category/intent routing, dependency resolution and verified scanner/
Python-worker integration remain separate work under
[V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).

## Preview routing for imported skills

With a supporting Rust core, the Security Center also offers **Skill routing
preview**. This compares registered revisions; it does not route the built-in
catalog or run a skill.

1. Enter category or intent identifiers from the skill's manifest, separated by
   commas. Parent categories also match declared descendants.
2. Select exact candidate revisions, at most one per package. Optionally choose
   a workspace to check approval applicability.
3. Add exact dependency pins yourself, then choose **Preview matches**.

The report explains matches and exclusions. A tie stays ambiguous even when the
result limit displays only one candidate. Quarantined or inactive revisions,
missing pins, unknown compatibility and permissions outside the empty diagnostic
ceiling can prevent a match. A partial catalog is labelled. No matching result
grants permission or activates anything; the existing scanner and consent rules
still apply. Changing inputs or the host clears old results.

## Related guides

- [Project skills](project-skills.md)
- [Skill Security Center](skill-security-center.md)
- [Native core (preview)](native-core.md)
