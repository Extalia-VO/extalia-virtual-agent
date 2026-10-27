# Project skills

A project skill is a set of instructions that lives in a project folder, so
the agent can follow how that project works. Extalia does not give a project
skill to the agent until you allow it.

## What a project skill is

A project skill is a `SKILL.md` file inside a folder under the workspace:

```text
<project>/.extalia/skills/<name>/SKILL.md
```

The file starts with a front matter block that has a `description`, and an
optional `name` (it defaults to the folder name). The rest of the file holds
the instructions:

```markdown
---
name: release-notes
description: How this project writes release notes.
---

Write release notes in the Keep a Changelog format.
```

- `name` uses lowercase letters, numbers and hyphens, up to 64 characters.
- `description` and the instructions are required.
- A file is read only up to 256 KB. Symbolic links are not loaded from a
  workspace.
- A file that cannot be loaded is skipped and listed as a skipped file, with
  the reason.

## Why they wait for your review

A project folder can come from anyone, for example a repository you cloned.
Its instructions would otherwise reach the agent without you seeing them, so
Extalia holds each project skill until you allow it. Built-in skills are not
affected.

## Allow or revoke a skill

1. Open **Skills** in the sidebar and find the workspace under **Project skills**.
2. Its section lists the skills waiting for your review.
   Each entry shows the description, the file path and a short SHA-256 hash.
   The full hash is in the tooltip.
3. Click **Allow** for one skill, or **Allow all**.

Allowed skills are listed under **Allowed (n)**. Click **Revoke** to remove one
skill, or **Revoke all** to remove every allowed skill in that workspace.

When the active workspace has skills waiting, Chat shows a notice with a
**Review skills** button that opens this section. In **Settings → Workspaces**,
a workspace with skills waiting shows **Review**, which opens the Skills page on
that workspace.

## What "Changed since you allowed it" means

Your allowance covers the exact file you reviewed, identified by its SHA-256
hash. If you edit the file, or a new version arrives (for example after a
pull), the hash no longer matches. The skill then returns to the review list
marked **Changed since you allowed it**, and it does not reach the agent until
you allow the new version.

A skill you have never allowed is marked **New in this project**.

If a skill changes after the list is loaded and you click **Allow**, Extalia
refuses that allowance, reloads the list and shows the current version to
review.

## How the agent receives allowed skills

- The agent sees the name and description of each allowed skill in a catalog,
  marked as untrusted, and reads its instructions when a task needs them.
- The instructions open with a notice that the skill was supplied by the user
  or the project, not by Extalia.
- An allowed skill cannot grant permissions, approve actions or override
  system and safety instructions. File edits and commands still follow the
  usual approval rules.
- Your allowance applies to one project folder. The same skill in another
  folder needs its own review.

## Planned: a stricter registry with a security scanner

This is planned work and is not available yet. Extalia is building a stricter
skill registry that checks skills with a security scanner. Until a verified
scanner is configured, imported skills stay in quarantine, which means they are
not activated. The registry has no screen yet.

## Where to go next

- [Security architecture](../architecture/security.md)
- [Getting started](README.md)
