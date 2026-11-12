# Automatic skill context in Native Chat

With **Extalia skills** enabled for a Native connection, the host selects and
loads relevant procedures before a model request. No separate classifier model
call is made. The catalog remains available through Grimoire Book/List and
`skill_list`, `skill_search` and `skill_read` for additional on-demand procedures.

## Defaults

- `memory-recall` guidance is always loaded. Memory access still follows the
  connection's settings; this does not enable memory or read every saved note.
- `orchestrator` is loaded for the lead when its saved team is enabled and has
  at least one member. Set up the team through **Team & orchestrator** in Chat.
  An absent or disabled team is skipped; the host does not create a team.
- Workers receive their own task-based context and connection feature checks.
  They receive no orchestrator or extra delegation rights. Both read-only
  meeting rounds use the same worker preparation boundary.
- Explicitly turning Extalia skills off disables this automatic preparation.

## Selection and context size

The current request takes precedence. Local English/Indonesian intent and skill
name matching can select a few useful procedures for debugging, testing, review,
security, documentation, design and other supported work. Short continuations
such as “continue” or “lanjutkan” may reuse the last two user requests as relevance
hints. Current exclusions win; optional Caveman style needs an explicit request.
This is bounded matching, not a promise to infer every task or inspect every file.

At most three optional procedures, including dependencies, accompany the defaults.
The entire prepared skill section is capped at 24,000 characters, and the full
request must also fit the configured input ceiling. Complete procedures are
loaded; oversized ones are skipped with an explanation. A useful full core may
fit when its specialist does not. Required guidance that cannot fit stops the
request rather than silently dropping the default or truncating conversation.

Registered procedures still need an active, approved and freshly verified exact
revision. Preparation rechecks selected external bodies at each request boundary;
revocation takes effect on the next request. Newly activated skills join on the
next turn. Initial large-library verification retains its existing scan bounds;
per-request optional reads are capped, including failed candidates.

## See what was loaded

Expand **Skill context** in the conversation, including an Office character's
conversation, to see:

- the lead or worker whose context was prepared;
- skill names and reasons, such as required memory guidance, configured team,
  explicit request, current context, recent conversation or required dependency;
- loaded, unavailable, unconfigured-team and budget-skipped statuses;
- character usage and any additional candidates not loaded.

A receipt means the host prepared those instructions. It does not prove that a
model followed them or authorize any action. It carries metadata only; full
procedures remain out of the event log. The host refreshes after admitted steering
and later tool steps; unchanged selections do not create repeated cards.

This feature covers Native Chat, ordinary delegates and meeting participants.
Observed apps, canonical mission workers and helper completion workflows retain
their separate behavior. See [ADR 0073](../adr/0073-automatic-native-skill-context.md)
for the authority and budget boundaries.
