# Extalia Protocol v0

`@extalia/protocol` defines the only event format that views, the Office and
storage understand. Runtime adapters and observers translate native output into
it; nothing runtime-specific crosses this boundary.

## Envelope

```jsonc
{
  "v": "extalia.v0",            // protocol version
  "id": "8c3e…",                // unique event id
  "at": "2026-01-31T12:00:00.000Z", // UTC, millisecond precision at most
  "sessionId": "…",
  "seq": 12,                    // optional, per-session order assigned by the store
  "agentId": "primary",         // required by agent.* and subagent.* events
  "taskId": "task-1",           // required by task.* events
  "parentId": "…",              // optional: the event that caused this one
  "correlationId": "…",         // optional: groups one logical operation
  "source": { "runtime": "hermes", "channel": "stream", "adapter": "adapter-hermes", "adapterVersion": "0.1.0" },
  "body": { "type": "agent.state", "state": "working", "activity": "edit", "target": "server.ts" }
}
```

`source.runtime` is an open lowercase identifier, so new runtimes need no
protocol change. `source.channel` records how the event arrived: `stream`
(managed runtime output), `hook`, `transcript` or `mcp` (observed agents), or
`bridge`, `import`, `user`, `system` (Extalia itself).

## Event families

| Family | Types |
| --- | --- |
| Session | `session.started` (with `control: managed \| observed`), `session.ended` |
| Conversation | `prompt.submitted`, `user.intervention` (steer, pause, resume, cancel), `model.thinking`, `model.delta`, `model.completed`, `turn.completed`, `turn.failed` |
| Agents | `agent.created`, `agent.state`, `agent.stopped`, `agent.error`, `subagent.spawned`, `subagent.state` |
| Tools and commands | `tool.started`, `tool.output`, `tool.completed`, `command.started`, `command.output`, `command.completed` |
| Files | `file.read`, `file.written` |
| Tasks | `task.created`, `task.assigned`, `task.progress`, `task.completed` |
| Approvals | `approval.requested`, `approval.resolved` |
| Git | `git.status`, `git.commit`, `git.push` |
| Meetings | `meeting.started`, `meeting.completed` |

Agent states: `idle`, `thinking`, `working`, `waiting`, `delegating`,
`blocked`, `offline`. Activity kinds: `edit`, `command`, `test`, `search`,
`read`, `web`, `delegate`, `knowledge`, `think`, `tool`.

## Validation

`parseEvent(value)` returns `{ ok: true, event }` or `{ ok: false, code, errors }`:

- `unsupported-version`: a different protocol version.
- `unknown-type`: a body type this version does not know. Consumers skip these,
  which keeps older clients working with newer producers.
- `invalid`: anything else, including unknown fields. Rejecting unknown fields
  stops runtime payloads from slipping through the protocol.

Text is bounded (200,000 characters per field; labels 2,000; ids 200).
`createEvent()` fills `v`, `id` and `at` and throws on invalid input.
`parseEventLines()` validates JSON Lines.

Try it: the Event log page in the app, or `extalia validate events.jsonl`.

## Versioning

Additive changes (a new event type or optional field) stay within `extalia.v0`
while the project is pre-1.0 and are recorded in the changelog. Breaking
changes require a new version string and an ADR.
