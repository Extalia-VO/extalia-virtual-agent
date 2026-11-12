# Installing community skills in Grimoire

Open **Skills / Grimoire**, then use **Skill marketplace**. Search runs only when
you submit a query. A repository and skill can also be entered directly, without
using marketplace search. Neither action sends project files or chat context.

Choose **Preview package** to resolve the public GitHub repository to an immutable
commit. Review the source, file list, package digest and license notices. **View
pinned source** opens that exact revision. Missing license information stays
explicit; a marketplace listing does not establish license compatibility.

**Import for review** imports the exact previewed bytes into the existing Skill
Security Center. It does not approve, activate or execute the skill. The pinned
scanner, user review, approval and activation remain separate steps. Where the
installed scanner is unavailable or unverified, the imported revision stays
quarantined and is not offered to agents.

The preview shows the package version, risk class, requested permissions and
declared runtime requirements. Inferred manifests are labeled. Requirements
still need compatibility evaluation, and omitted rows have explicit counts.
The Security Center provides the imported revision for complete review.

Catalog refresh and package revisions are independent of Extalia releases. To
update a skill, prepare a new preview and import its revision. Existing active
revisions do not change automatically. The registry retains its existing explicit
activation, rollback and revocation controls. Two repositories or skill folders
cannot silently claim the same registered marketplace package name.

The Security Center shows source records for the exact revision, including pinned
GitHub commits. Legacy revisions without such records remain unknown; Extalia does
not invent per-revision provenance from old package-level metadata. The bounded
view discloses omitted retained records.

Search has a private, bounded cache. Fresh cached results avoid another request;
after a failed refresh, an available old snapshot is marked stale. Public search
uses a best-effort discovery adapter and may become unavailable independently of
Extalia. Direct public GitHub previews remain a separate path.

Previews expire after ten minutes. Imports require a preview prepared by the
current host; restart requires preparing it again. If completion is uncertain,
inspect Grimoire before creating a new preview. An entered import is owned by the
host even if its view closes. No automatic retry or activation follows.

Only bounded public GitHub regular-file packages are supported initially. Private
repositories, source installers, symlinks, submodules and oversized or nonportable
packages are refused. Network and filesystem processing run in Rust; the host
supervises processes and receipts, and React displays the controls.

This update adds CoreStore schema 14 for immutable revision-source records. The
existing migrator creates its pre-upgrade backup. Older binaries refuse a newer
store; application rollback must preserve that backup and follow the existing
store recovery procedure with the host stopped.

See [ADR 0077](../adr/0077-live-skill-marketplace.md) for architecture and bounds.
