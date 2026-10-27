# Skill Security Center (preview)

The Skill Security Center is a section of the **Skills** page where you import
skills, review them, and decide which ones reach agents. It is part of the preview Rust
native core, so it appears only when that core is on. See
[Native core (preview)](native-core.md) to turn it on.

With the TypeScript core, project skills are allowed or revoked as described in
[Project skills](project-skills.md). The Skill Security Center does not appear.

## What it does

User and project skills reach agents only as approved, verified revisions held
by the native core. A skill is a package. Each package has one or more
revisions, and a revision is one exact set of files. If any file changes, that
is a new revision and it needs its own review and approval.

Agents receive user and project skills only from active, verified revisions.
When the native core is unavailable, agents are offered only built-in skills.
Built-in skills ship with the app, are checked by their content hash each time
the daemon starts, and are not listed in the Center.

## Import a skill

1. Open **Skills** in the sidebar and find **Skill Security Center**.
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

## Why imported skills stay quarantined

Extalia never runs an unverified scanner. Until a verified scanner is
configured, a scan cannot pass, so imported skills stay quarantined. The Center
shows the banner **Imported skills stay quarantined until a verified scanner is
configured.** You can still import and inspect skills. Approval and activation
wait for the scanner.

## Where to go next

- [Native core (preview)](native-core.md)
- [Project skills](project-skills.md)
- [ADR 0025: skill manifest and immutable revisions](../adr/0025-skill-manifest-and-immutable-revisions.md)
- [Getting started](README.md)
