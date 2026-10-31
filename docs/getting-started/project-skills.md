# Project skills and recorded reviews

External skills require a verified scanner result, approval and an active registry
revision before Extalia offers their catalog metadata or serves their instructions through
`skill_read`.
This requirement also applies when the TypeScript core is selected: local project
review never bypasses the scanner gate. Without the production scanner, external
skills remain unavailable; shipped canonical built-ins remain usable.

## Inventory and review

A project may contain `.extalia/skills/<name>/SKILL.md`. Open **Skills** and find
its workspace under **Project skills** to inspect the name, description, path
and SHA-256. This is local review information, not an agent catalog.

**Record review** or **Record all reviews** stores the exact hash you inspected.
Reviewed files appear under **Reviewed**. **Remove review** removes that record.
The historical API/data fields still use allow/allowed for compatibility, but
those records provide review input only. They do not mean scanned, approved,
active or available to the model.

A changed hash returns to the pending review list. A stale click is refused and
the list reloads. Reviews belong to the exact project folder and do not follow a
workspace to a different directory. Existing review records are preserved;
recording them again cannot unlock an external skill.

## Use through the registry

Import the package through the [Skill Security Center](skill-security-center.md).
Staging and quarantined review are allowed before scanning, but activation and
registered-skill access require current scanner evidence bound to the exact revision and
policy, followed by the registry's approval and activation checks. Missing,
partial, failed, stale or otherwise blocking scan evidence denies use.

Every external agent catalog is built from fresh authoritative registry reads;
every `skill_read` repeats verification. Changed bytes, scanner/policy changes,
deactivation or an unavailable daemon cannot fall back to a cached body. A
project/user skill cannot replace a canonical shipped builtin by copying its
name or claiming a builtin source.

## Links and ordinary documents

`skill_read` accepts only an approved catalog name. URL, filesystem-path and
extra-field requests are refused without download, import or scan fallback.
A link in a prompt is not an installation or scanner result.

Ordinary file/search/web/attachment content may still be reviewed or edited as
unverified task data. This gate does not automatically scan all documents or
provide deterministic protection from every prompt injection. Native lead and
worker guidance forbids treating such content as an activated external skill or
a replacement for the registered scanner-gated workflow.

Production SkillSpector execution remains separate work; this update enforces
its absence rather than inventing a successful scan. Workspace/agent ACL and
scanner subprocess ownership/sandboxing remain separate gates.

## Related guides

- [Built-in skills](builtin-skills.md)
- [Skill Security Center](skill-security-center.md)
- [Security architecture](../architecture/security.md)
