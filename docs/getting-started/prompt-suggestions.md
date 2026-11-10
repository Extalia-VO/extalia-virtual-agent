# Suggested next prompts

After a successful task, Chat and the Office message dialog can show up to three
next prompts. They are optional suggestions, not accepted tasks or proof of work.
Choose one to fill an empty message box, review it, then send normally. Existing
typed drafts are never replaced and suggestions are never sent or queued
automatically. Sources without a normal Extalia message sender show Copy buttons
so you can use a suggestion in the source application. Observe shows the same
harness suggestions for the selected conversation.

## Extalia Native

After Native Chat completion, the host retains a bounded current-task summary in
memory. When the conversation view needs suggestions, it requests one tools-free
completion using the task's already approved lead provider and model. This is an
additional AI request; opening the same result again does not retry it. Headless
or unviewed tasks do not incur that generation request. Input and output are
bounded, and the model may return no suggestions when nothing useful follows.

Prediction runs separately from task completion and pending work. A new task,
cancel, changed model/context, pending outbox, source invalidation or shutdown
revokes stale output. The default publication deadline is eight seconds, capped
at twelve; cancellation does not claim the underlying request physically settled.
Predictions have no tools, permission requests, file access, delegation, learning
writes or conversation-history mutation. Their reported usage is separate from
the completed task's context accounting. Prepared data and predictions remain
memory-only, including history-off sessions, and expire with the application.

## Observed sources

The optional Extalia MCP server exposes `report_followups`:

```json
{"session_id":"existing-native-session","prompts":["Review the remaining edge cases."]}
```

Report zero to three distinct single-line prompts, each at most 240 characters,
near completion. Use the existing source session ID. Reports cannot create a
session, impersonate a worker, start a task, or grant a message-sending capability.
The installed MCP server instructions encourage useful reports; the source agent
and its client still decide whether to call the tool. Existing MCP clients may
need to refresh their tool list to see a newly added reporting tool.

Authenticated hooks can carry the same report name and `tool_input`. The host
accepts reports only for an existing watched lead, stages them until a successful
completion and clears them on a new task. It does not preserve report text in
transcripts or event history. Labels-only privacy drops report content.

An already attached Codex controller can also receive
`thread/prediction/updated` and request `thread/prediction/request` once for the
exact known successfully completed native turn. These experimental methods were
verified against the installed 0.167.0 schema. This feature never connects,
resumes a thread, creates a conversation or sends a task to obtain a prediction.
Unknown completed turns, source changes, newer turns, unsupported methods and
privacy settings suppress it. Availability depends on the source's support and
eligibility; live Desktop prediction generation is not certified by the mock RPC
tests.

Claude Code, Gemini CLI, Hermes and other observed integrations can supply the
cooperative report. Their ordinary completion hooks do not by themselves provide
a documented standalone prediction API. Extalia therefore does not insert a
hidden prompt or use another model on their behalf when that capability is absent.
No external application configuration is installed or edited by this feature.
