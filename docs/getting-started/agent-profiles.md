# Agent profiles

Agent profiles let projects share a default way of working while retaining
individual personalities and models. This feature currently runs with Extalia
Native.

## Create a team preset

1. Open **Settings → Agent profiles → Create profile**.
2. Give it a name, a standing team purpose and a shared personality.
3. Choose the lead's saved model connection, preferred model and reasoning
   effort, or inherit the project's connection defaults. Set its role and
   responsibility. Keep shared personality enabled or provide its own style.
4. Under Subagents, choose **Configured team → Configure individual agents**.
   Select a project for its actual model catalogs. Add members, set their roles,
   responsibilities, personalities and permitted model order. Blank member
   personality uses the shared style.
5. Choose **Use this team**, then **Save** in the profile editor. The inner editor
   changes a draft; it does not save a project team.

Profiles reference existing saved connections. A profile does not change
project permissions or make an unavailable model/runtime usable. Keep long
project notes in Knowledge rather than in the reusable preset.

## Apply or customize a project

Open **Settings → Projects** and choose its **Agent profile**. The project shows
whether it uses profile defaults or has project overrides. Its normal team
editor can customize the inherited roster; **Use profile defaults** clears
those overrides. Choosing **Project settings only** removes the preset binding.

Profile edits affect new sessions. Existing conversations keep their saved
connection, model, team and personality even after the preset changes. A session
being created during a concurrent defaults change may need to be started again.
Knowledge, memory and files continue to follow the project's isolation policy.

## Customize one agent

Open its team settings from **Chat** or its **Office** conversation. Expand
**This agent's personality** to edit the idle lead's role, standing responsibility
and personality, then save that section. Subagent controls below edit their
individual role, personality and model preferences. Session model controls
remain available in the conversation.

These changes apply to that conversation rather than rewriting the reusable
profile or other agents. Finish or stop the lead's current work before changing
its personality. A background purpose never replaces the actual current task;
skills are selected separately for the worker's assignment.

## Recover a stale or interrupted save

**Refresh profiles** reads the current catalog without replacing an open draft
or its expected revision. If another editor saved a newer revision, retain or
copy your changes, then review the newer profile before saving again.

A new draft keeps the same creation identity if its save response is lost.
An explicit retry of the unchanged draft returns the existing profile instead
of creating a duplicate. Writes are never automatically replayed. Unlink a
profile from its projects before deleting it; existing session snapshots remain.

Profiles are stored under Extalia's data folder in
`config/operating-profiles.json`. The default root is `~/.extalia-vo`; data-folder
overrides still apply. The catalog accepts up to 32 profiles, 64 KiB per profile
and 512 KiB total. Large imported goal documents may need shortening.
