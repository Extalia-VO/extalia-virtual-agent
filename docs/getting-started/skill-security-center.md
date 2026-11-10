# Skill Security Center (preview)

The Skill Security Center is a section of the **Grimoire** page where you import
skills, review them, and decide which ones reach agents. It uses the lazy Rust
profile daemon independently of the backend chosen for new missions. A new
installation does not need an experimental mission flag to import skills.
If the daemon is missing or unavailable, the Center explains the failure and
external skills remain unavailable; built-in skills remain usable.

The native core also has a [read-only dependency check](../adr/0039-read-only-skill-dependency-preflight.md)
in Grimoire. It cannot activate a skill. Packages declaring dependencies,
conflicts or compatibility still wait for authoritative resolver integration;
a consistent diagnostic plan does not pass scanner, approval or activation gates.

## Check dependencies

1. Choose one exact **Skill revision** in **Dependency check**.
2. Optionally add the exact dependency revisions you want to pin. Nothing is
   selected automatically; missing pins are reported. Remove a pin to change it.
3. Click **Check dependencies**. Review blockers or the diagnostic ordering.

This check uses unknown compatibility facts and an empty diagnostic permission
ceiling, so it reports compatibility and permission findings conservatively.
It neither scans nor approves anything. An unscanned or stale revision remains
unavailable. Truncated reports say that more findings exist and stay blocked.
Changing inputs clears the result; changed host, scanner/policy or registry
context also discards pending replies. An older host/core shows that dependency
checks are unavailable while preserving its existing registry controls.

## What it does

User and project skills reach agents only as approved, verified revisions held
by the native core. A skill is a package. Each package has one or more
revisions, and a revision is one exact set of files. If any file changes, that
is a new revision and it needs its own review and approval.

Agents receive user and project skills only from active, verified revisions.
When the native core is unavailable, agents are offered only built-in skills.
Built-in skills ship with the app and remain separate from external imports.
Native offerings use canonical shipped content, not an arbitrary builtin source
flag or a same-name external override; this is not an external scanner result.
Daemon-registered built-in objects retain their startup hash checks.

## Import a skill

### Learn from a Native Chat prompt

Select **Learn as skill** for one message, then ask naturally, for example:
“Learn this procedure as a reusable skill.” Alternatively type
`/learn-skill` followed by source text or a link. The command also works in the
Office prompt dock. Plain document reading does not save a skill automatically.

This requires Extalia skills enabled on the connection and the Rust skill
registry. It is unavailable for plan/read-only, observed and Hermes sessions.
Existing edit approval policy still applies. The model may propose one candidate
per opted-in turn; an answer without a successful proposal receipt is not a save.

The generated candidate appears in this profile's Skills library, with origin
**Generated**, its exact revision and actual inspection state. It is an
instructions-only draft with unverified source attribution; its package is what
the registry inspects. This does not certify the original URL or all referenced
files. The proposal tool does not fetch URLs, install packages or execute code.

When the scanner is unavailable, the candidate remains **Quarantined** and cannot
be used as a skill. Successful scan evidence and separate user approval/activation
are still required. If an inspection response is lost after import, inspect the
library before retrying: a saved candidate is not automatically rolled back.

### Import an existing package

1. Open **Grimoire** in the sidebar and find **Skill Security Center**.
2. Click **Import from folder**, then type the path to a skill folder or click
   **Browse…** to choose one. The folder needs a `SKILL.md` at its top level.
   Or click **Import from project**, choose a workspace, and choose one of its
   project skills. The list includes allowed and waiting project skills.
3. Click **Import**.

The folder is copied into Extalia's private skill store and quarantined. The
original is not changed. If the exact same files were imported before, the
Center says so and shows the current state.

## Reading a package

Each package shows its origin (**Built-in**, **User**, **Project**, **Imported**
or **Generated**), its active version or **Not active**, and its number of
revisions. Each revision shows:

- Its version and state.
- The reason, in plain words.
- Its risk: **Instructions only**, **Uses tools** or **Ships code**.
- Its declared permissions: **Read files**, **Write files**, **Network**,
  **Terminal** or **Secrets**. A declared permission is a ceiling, never a grant.
- Two short hashes: the package SHA-256 and the permission digest. Hover over
  them for the full values.

**Details** lists the files and their SHA-256 hashes, the inspections, the
approvals and the history.

### States

| State | What it means |
| --- | --- |
| Discovered | Recorded by the core, not yet quarantined. |
| Quarantined | Held by the core. Not active, and not offered to agents. |
| Inspecting, Inspected | A scan is running, or has finished. |
| Review required | A medium-severity finding needs your review. |
| Blocked | Stopped for good: a high or critical finding, or a version another revision already used. |
| Validated | The manifest, permission, dependency and compatibility checks passed. |
| Evaluating, Evaluated | An evaluation is running, or has finished. |
| Awaiting approval, Eligible for approval | Waiting for your approval, or able to receive it. |
| Approved | You approved its exact digests. It can be activated while the approval lasts. |
| Active | Agents can use this revision. A package has one active revision. |
| Superseded | Replaced by a newer active revision. |
| Deprecated | Marked deprecated. It stays active until it is replaced. |
| Revoked | Withdrawn for good. It can never be approved or activated again. |

### Common reasons

| Reason | What it means |
| --- | --- |
| Scanner unavailable: no verified scanner is configured | Nothing can be checked, so the revision stays quarantined. |
| Waiting for inspection, Inspection running | A scan is queued, or in progress. |
| Review required: medium-severity finding | Review the finding before you approve. |
| Blocked: high-severity finding, Blocked: critical finding | The scan found a serious problem. |
| Blocked: another revision already used this version | Give the changed skill a new version. |
| Integrity failure: the stored files no longer match their hash | The stored copy changed. Extalia does not fall back to another copy. |
| Approval expired | Your approval ran out before activation. Approve again. |
| Inspection no longer valid (scanner or policy changed) | The scan was made under a different scanner or policy. Inspect again. |
| Needs your approval: uses tools or ships code | The revision needs your approval before it can be activated. |
| Needs your approval: asks for more permissions | The revision asks for more than before. Check the permissions before you approve. |
| Revoked by you, Deactivated by you | You made this change. |
| Replaced by a newer active revision | Another revision of the package is now active. |

## Review and approve

These are two separate steps.

- **Review** records your decision on a finding. You can add a note of up to
  2,000 characters. **Accept** does not activate the revision: it still needs an
  approval. **Reject** returns it to quarantine. If the panel says recording a
  review is not available yet, this version of the core cannot record one.
- **Approve…** shows the package hash and the permission digest you are
  approving, along with its declared permissions and the expiry. Click
  **Approve these digests** to send exactly those two values.

An approval binds the exact hashes shown. It expires 10 minutes after approval
unless you activate the revision first. The panel shows the expiry in minutes.
Any changed file or permission is a new revision that needs its own approval.
Only you can approve. An agent cannot.

## Activate, deactivate, roll back and revoke

- **Activate** makes an approved revision the active one for its package. The
  previously active revision becomes **Superseded**.
- **Deactivate** stops agents from receiving the package's active revision.
- **Roll back to this** makes an earlier revision active again, if it is still
  valid and approved.
- **Revoke…** withdraws a revision for good. The confirmation asks you to
  confirm it. A revoked revision can never be approved or activated again.

## Real scanner inspection and approval

Supported macOS packages bundle NVIDIA SkillSpector 2.13.4, its pinned Python
runtime and hash-locked dependencies. Users do not install Python or download a
scanner on first use. The current scanner launch requires macOS 14 or newer and
verified local sandbox support; other platforms remain unavailable until their
confinement is implemented and validated.

Importing a folder or successfully proposing a requested skill starts an actual
local scan. LLM analysis, source URL fetching and execution of skill code are
disabled. The scanner cannot access provider credentials or the network. A denied
dependency lookup or other missing coverage remains incomplete; it is not a clean
scan. Large or complex packages may hit explicit resource limits.

The Center shows progress and each inspection's coverage, highest severity,
scanner version/pin and policy. **Details** can show the verified instruction
text literally for review; opening it never runs or activates the skill. If a
complete bounded preview is unavailable, review the source package instead.
Raw scanner findings and source snippets are not persisted as a retrievable report;
the current inspection record contains bounded verdict metadata and a summary hash.

Complete clean/low inspection can make a non-executable, Markdown-only package
with no tool permissions or unresolved relationships **Awaiting approval**. A
medium finding needs a separate accepted user review first. Packages requiring
code/tool or compatibility evaluation keep that requirement; no evaluation success
is invented. High/critical findings are blocked. None of these results activates
a skill: use **Approve**, check its exact package/permission digests, then
**Activate**. Approval expiry, changed bytes, scanner/policy changes and revocation
are still enforced.

For a stored quarantined candidate, **Scan again** explicitly requests a new
inspection when the scanner is ready. This also works for an older generated
candidate whose source was never a user folder. Refreshing the library, opening
Details or reading a book never rescans a package. An uncertain completion asks
you to refresh before retrying; it does not promise that nothing was recorded.

If the daemon, verified bundle or required isolation is absent, the scanner
reports unavailable. Imported/generated packages stay **Quarantined**, and neither
approval nor activation can bypass the missing evidence. See
[ADR 0068](../adr/0068-pinned-skillspector-inspection.md) and the
[build and fixture evidence](../../tooling/skillspector/README.md).

## Where to go next

- [Built-in skills library](builtin-skills.md)
- [Native core (preview)](native-core.md)
- [Project skills](project-skills.md)
- [ADR 0025: skill manifest and immutable revisions](../adr/0025-skill-manifest-and-immutable-revisions.md)
- [Getting started](README.md)
