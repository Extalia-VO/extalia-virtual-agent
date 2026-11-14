# Skill origins and local storage

The default application data directory is the OS user's `.extalia-vo` folder.
`EXTALIA_HOME` can select a different data directory.

Knowledge uses `vaults/<vault-profile-id>/` by default. A selected Obsidian
folder can be outside that directory. The Knowledge page shows the effective
host-confirmed folder. Existing notes are not relocated by origin labels.

On macOS and Linux, the default Native skill library is separate: immutable package objects live
under `skills/objects/<tree-sha256>/`, directly beneath the data directory.
Generated packages include `SKILL.md` and `PROVENANCE.md`. Thus the ordinary
location is `~/.extalia-vo/skills`, shared across workspaces and future operating
profiles, subject to the existing scope, inspection and activation rules.

The internal default registry identity and lifecycle records do not change when
the objects move. The upgrade verifies and copies legacy
`profiles/default/skills/objects/` bytes, retains the old copies, and publishes
the new layout only after verification. Existing unrelated W0 folders under
`skills/` are preserved; conflicts with reserved internal names are refused.
Nondefault daemon CLI namespaces retain their legacy paths and independent
authority rather than silently merging approvals into the application library.
See [ADR 0082](../adr/0082-global-skill-storage.md).

Windows retains its existing `profiles/default/skills` and staging paths in this
update so existing installations remain usable. Its physical migration needs a
native no-follow implementation and platform validation; logical sharing and
per-worker relevance are unchanged.

Project sources can live in `<project>/.extalia/skills/`. Folder and project
imports retain their source and are copied into immutable registry objects.
Canonical built-in instructions ship with Extalia. Their internal native
registrations do not turn a user import into an app-shipped built-in.

## Visible origin

The library and revision inspector show origin separately from lifecycle state:

| Marker | Meaning |
| --- | --- |
| Extalia built-in | Canonical instructions shipped with the application. |
| Marketplace | This exact revision and profile have a valid recorded pinned marketplace source. |
| Custom | User-origin or Native-generated content in the user's skill library. |
| Project | Workspace-origin content, retaining its own scope and review rules. |
| Imported | Imported content whose marketplace provenance is not confirmed in the summary. |

The additive `marketplaceSource` summary field is derived from exact-revision
recorded sources. Imported origin, a package name, an unrelated revision and a
package's first import are insufficient. Older peers omit the field and remain
generic Imported. List rendering needs no per-book inspection requests. Source
markers do not certify a publisher or license and do not approve or activate a
package. They do not change scanner eligibility or permissions.

## Shared procedures, scoped project context

The owner clarified that universal means reuse across Extalia workspaces,
including isolated projects. It does not require cross-agent export. Skills
provide reusable procedures; Knowledge, memory recall and project-file access
keep the selected workspace's boundaries.

Completed work in any workspace can propose a new skill or another immutable
revision. Shared instructions should generalize project paths, identifiers and
private facts into parameters instead of carrying project notes or raw evidence.
Source provenance stays separate from instructions. Generation is not activation;
review is still required, including checking the content is appropriate to share.

Globally approved active skills may be available in isolated workspaces too.
An explicitly scoped grant retains its scope; unrelated grants cannot widen
the active revision's authority. Availability does not mean every worker loads
every skill. Procedure selection and full-body reads use the individual worker's
current request, and no relevant optional procedure is a valid result.

[Operating profiles](agent-operating-profiles.md) are a separate proposed preset
for purpose, personality and model/team defaults. Their purpose is background
guidance, not evidence that an optional skill matches an individual worker task.
The storage upgrade does not implement this profile manager.

`SKILL.md` remains a portable instruction file. Runtime integrations retain their
actual capabilities; shared local storage alone grants no external application
access or automatic activation.
