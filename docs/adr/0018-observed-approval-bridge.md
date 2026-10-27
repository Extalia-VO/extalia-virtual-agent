# ADR 0018: Observed approval bridge (opt-in, per adapter)

Status: Proposed (2026-10-18)

## Context

Users run several agent apps at once (Claude Code, Codex CLI, Hermes, and
Antigravity or Gemini CLI). Each one asks for approval in its own window. The
owner wants Extalia to be the place where those approvals are answered, so the
user does not switch windows.

ADR 0004 and [security.md](../architecture/security.md) currently say observed
sessions are read-only and that hooks "forward events only; they never block,
steer or inject text into the agent". Product rule FR-07 (as stated by the
owner) is that observed does not mean controlled: any control must be an
explicit, opt-in capability per adapter. This ADR proposes the first such
capability and amends 0004 and `security.md` only once accepted.

Today the ingest endpoint always answers `204` with an empty body
(`packages/host/src/hooks/http.ts`), the Claude HTTP hooks have a 2 s timeout
(`connect/claude.ts`), the Codex and Gemini forwarder prints nothing and exits
0 (`connect/forwarder.ts`), and the Hermes connector registers outbound
webhooks (`connect/hermes.ts`). None of these can decide an approval, and an
empty answer is the correct "no decision" signal for all of them.

## Research: what an external process can decide

Versions checked: Claude Code `2.1.295` (installed), Codex CLI `0.163.0`
(installed), Hermes Agent `v0.22.0` (local checkout), Gemini CLI (not installed
on this machine). Official pages were read through a summarising fetch, so
exact quotes should be re-checked against the installed binaries before
implementation (see Open questions).

### Capability matrix

| App | Decide an approval? | Mechanism | Decision output | Timeout and failure | Current Extalia state |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.295 | **Decide** (documented) | `PermissionRequest` hook, `command` or `http` type | `hookSpecificOutput.hookEventName: "PermissionRequest"` with `decision.behavior: "allow" \| "deny"`; `decision.message` (deny), `decision.updatedInput` and `decision.updatedPermissions` (allow), `decision.interrupt` (deny). A 2xx `http` body is parsed with the same schema. Empty body or exit 0 without output = no decision, normal prompt. | Default `timeout` 600 s for `command`/`http`; documented maximum not found. On timeout or connection failure the hook is non-blocking and the normal prompt appears, unless `onFailure: "block"` (v2.1.295+), which would deny. Must not be set for this event. | Event is registered as `http` with `timeout: 2`. Would need a timeout change through `extalia connect`. |
| Codex CLI 0.163.0 | **Decide** (documented), command hooks only | `PermissionRequest` hook in `hooks.json` or `[hooks]` in `config.toml` | `hookSpecificOutput.hookEventName: "PermissionRequest"`, `decision.behavior: "allow" \| "deny"`, `decision.message` (deny). Any deny across matching hooks wins; an allow skips the prompt. `updatedInput`, `updatedPermissions` and `interrupt` are reserved and fail closed. | `timeout` in seconds, default 600. Failure semantics for command hooks on timeout or crash not confirmed by the docs read. Hooks must be reviewed and trusted by hash (`/hooks`); a changed hook is skipped until re-trusted. | Forwarder sends events and `codex_app_server` writes trust records. A decision path needs a forwarder that prints JSON for this event only. |
| Hermes Agent v0.22.0 | **Decide only through an approval-transport plugin** (in-process Python) | `ctx.register_approval_transport(name, present_fn)`; present returns `request.respond(choice)` with `once`, `session`, `always` or `deny` from the offered set | Choice bound to the request ID and digest; the host rejects scopes it did not offer. Enabling the plugin and selecting it under `security.approval.transport` are two separate consent steps. | Host enforces `approvals.timeout` (default 300 s). Transport exception, timeout, unavailable or invalid choice = **deny**, unless `security.approval.transport_fallback: builtin` is set, which shows Hermes's own prompt. | Outbound webhooks for `pre_approval_request` (notify-only). |
| Hermes shell hooks (`pre_tool_call`) | Partial: **block** or **escalate**, never allow | `hooks.pre_tool_call` in `config.yaml`, shell command, per-entry consent | stdout `{"action":"block","message":...}` (or Claude-style `{"decision":"block","reason":...}`); `{"action":"approve",...}` escalates to the human gate. Claude-style `{"decision":"approve"}` is not mapped as allow. Exit 2 = block. | Default `timeout` 60 s, capped at 300 s. Fail-open by default; `fail_closed: true` blocks on timeout or error. | Not used. |
| Hermes outbound webhooks (`hooks.outbound`, `pre_approval_request`) | **Notify-only** | Signed POST to a URL | Response body ignored; "they observe, never steer". 4xx not retried; redirects not followed. | 2 s in Extalia's connector. | Used by the Hermes connector. |
| Antigravity CLI (`agy`), successor to Gemini CLI | **Unverified; treat as notify-only** | `PreToolUse` hook in `hooks.json` (matcher = tool name) | A third-party guide reports `decision` JSON, with exit 0 read as allow and non-zero as deny. A Google forum report and a third-party guide say a hook's allow is ignored under `request-review` tool permission mode. The official hooks page (`antigravity.google/docs/hooks`) was not read. | Not confirmed. | Connector writes `PreToolUse`/`PostToolUse` to `~/.gemini/config/hooks.json`. |
| Gemini CLI (superseded?) | **Unverified** | `BeforeTool` in `settings.json` | Official reference (`geminicli.com/docs/hooks/reference/`): `decision` `allow`/`deny` (`block` alias), `reason`; no `ask` documented; exit 2 blocks; `timeout` in ms, default 60000. A mirror (`mintlify.wiki`) also lists `ask` and `approve`, and says allow skips confirmation. Conflicting. The official page says the CLI was replaced by Antigravity CLI on 2026-06-18. | See left. | Connector timeout is 2000 ms (`connect/gemini.ts`), which is far below the documented default. |

### Notes on the matrix

- **Claude Code** has the cleanest contract. Extalia can answer `PermissionRequest`
  over HTTP. "Allow for this session" is expressible through
  `updatedPermissions` with `destination: "session"` and `addRules`. Deny and
  ask rules still apply, so an allow cannot override a deny rule. The hook input
  carries `permission_suggestions` (suggestions the app would offer), which
  Extalia may show but must not apply on its own. Claude's own `tool_use_id` is
  absent from `PermissionRequest` input, so request binding has to use
  `session_id`, `tool_name`, `tool_input` and `cwd`.
- **Codex** can decide, but only with command hooks (a process must print JSON
  within the timeout). `allow` skips the approval prompt, which is what we want
  for an explicit user click. Session-scoped allow is not expressible
  (`updatedPermissions` is reserved). The app-server protocol is for a client
  that drives a thread it owns; the docs read did not say whether it exposes
  approvals for a terminal session started by the user, so it is not a route
  for this feature.
- **Hermes** has a real decision path, but it is a Python plugin running inside
  the Hermes process, not a webhook. Extalia would ship a plugin and a config
  change, both with consent. The transport API expresses only deny or an
  offered scope. "Let Hermes show its own prompt" therefore needs
  `transport_fallback: builtin`; without it, any Extalia outage denies the
  command. Hermes also has `pre_approval_request` as an observer, and
  observer hooks cannot answer.
- **Antigravity and Gemini** cannot be classified until the installed binary
  has been tested. Do not implement a decision path for them before then.

## Decision

1. **Opt-in per adapter.** A decision capability is off by default for every
   app. It is enabled per app with `extalia connect <app> --approvals`, which
   shows a dry run, requires approval, backs up the files it changes, and has an
   undo (`extalia disconnect <app>` removes the entries). Enabling the
   capability for one app never enables it for another. The first version
   implements **Claude Code only**; Codex is the second candidate; Hermes waits
   for a plugin design; Antigravity and Gemini wait for verification.
2. **Notify stays the default.** Existing hooks keep their 204 and empty-output
   behaviour. Only the new approval route answers with a decision, and only
   for an enabled app.
3. **Long-poll on the authenticated ingest endpoint.** A new route,
   `POST /api/hooks/<app>/approval`, is handled by the same loopback, Host,
   Origin, content-type, body-limit, rate-limit and token checks as
   `handleHookRequest`. It creates a pending approval with a random 128-bit ID
   and waits up to `T`, where `T` is the hook timeout minus a safety margin
   (for example, a hook timeout of 60 s and `T` of 45 s). The user answers in
   the Extalia approval inbox (Desktop or Web), which calls an authenticated
   local API with the pending ID. The answer is returned as the hook body.
4. **No automatic decisions.** Extalia never allows anything without a user
   click bound to that pending ID. It never denies by default.
   - Timeout, Extalia closed or unreachable, pending entry cancelled, or the
     app closing the connection: return **no decision** (2xx empty body, or exit
     0 with no output). The app then shows its own prompt, so the user is never
     left with a silent refusal or a silent allow.
   - Allowing for the rest of the session is a separate, explicit control in
     the inbox. It is off in v1. If enabled later, it applies only to the exact
     `tool_name` and a rule for the exact command or path, and it is shown as
     session-scoped.
5. **Audit trail.** Append-only JSON Lines in the Extalia data directory (mode
   `0600`, never in an app's config). Each record holds: request ID, app,
   app session ID, tool name, `tool_input` digest (SHA-256 of canonical JSON),
   workspace, requested time, expiry, outcome (`allow`, `deny`, `no-decision:
   timeout`, `no-decision: closed`, `app-resolved`), `decided_by` (the local
   user), and the time to decision. Raw `tool_input` is not stored. Deleting a
   record is a user action only.
6. **Hook timeout and file changes only through `extalia connect`.** Changing a
   timeout (Claude `timeout: 2` to a larger value, Codex `timeout` in seconds)
   is a diff against the file, with a backup and undo, the same as today's
   connect flow.

## Request flow (Claude Code)

```
Claude Code                   Extalia host (loopback)                 User
PermissionRequest  --POST-->  /api/hooks/claude/approval
  (http, timeout T+margin)      verify token, Origin, Host, body
                                create pending {id, digest, expiresAt}
                                show in approval inbox  ------------->  Allow once / Deny
                                <-- POST /api/approvals/{id}/decision  (authenticated, id + digest)
  <-- 200 {hookSpecificOutput: decision: {behavior, message?}}
  or  <-- 204 (no decision: timeout, closed, cancelled)  -> app prompt
```

Codex follows the same shape, with `forward.mjs` printing the JSON on stdout
and exiting 0 for this event only.

## Security considerations

- **Authentication.** The bearer token used by the ingest endpoint is the only
  credential. It has to be a separate, approval-scoped token if the
  decision API is reachable from Desktop and Web. Constant-time comparison
  (`secretMatches`) and the existing re-read on rotation still apply.
- **Token exposure.** `connect/claude.ts` writes the bearer token literally into
  `~/.claude/settings.json` (`headers.Authorization`). Claude Code supports
  `allowedEnvVars` (the variable must be listed and set in the app's
  environment) and settings-level `httpHookAllowedEnvVars` and
  `allowedHttpHookUrls`. Using an environment variable instead of a literal is
  an open question, and a separate issue. Whatever is chosen, the approval
  route should not share the notify route's token.
- **Replay and binding.** Each pending approval is single-use and expires.
  The answer must carry the pending ID and the digest of
  `(session_id, tool_name, canonical tool_input, cwd)`; otherwise it is
  rejected. Late answers after the hook has returned are discarded.
  `tool_use_id` is not in Claude's `PermissionRequest` input, so binding does
  not rely on it.
- **Concurrency and ordering.** Several pending approvals may exist at once,
  each with its own ID. A decision on one never applies to another. If the
  user answers in the app's own window first, the hook connection closes; the
  pending entry is then marked `app-resolved` (or cancelled) and removed from
  the inbox.
- **Redaction and display.** The inbox shows the app, workspace, tool name and a
  command or path with secrets masked by the existing output masking. It never
  shows file contents for write or edit tools, nor environment variables. Text
  in a request is data, not instructions, and is labelled as the app's request.
- **Who may decide.** Only a local user action in Desktop or the authenticated
  Web client. Observed content (prompts, tool output, transcripts) cannot
  answer or create an approval.
- **Denial of service.** Pending approvals are capped (for example, 20 per app)
  and rate-limited. When full, new requests get no decision, which is safe.
- **Loopback.** The listener stays on `127.0.0.1`. Other local users on a shared
  machine can reach it, which is an accepted residual risk to record in
  `security.md` if the feature ships.
- **Observed ≠ controlled.** The UI must label a decision made through Extalia
  as made through Extalia for that app. The approval capability is shown in the
  observed-session view as a control, and it is disabled when the app is
  disconnected.

## Consequences

- Extalia can answer approvals for enabled apps, without any change to the
  behaviour of apps that have not opted in.
- The hook timeouts for enabled apps grow from 2 s to tens of seconds. This is
  a visible change to the app's behaviour and must go through `extalia connect`
  with its diff.
- ADR 0004 ("observed sessions are read-only") and `security.md`
  ("hooks ... never block, steer") need an amendment once this is accepted,
  scoped to the opt-in approval capability only.
- Hermes needs a separate design (a plugin with consent, `transport_fallback:
  builtin`, and `approvals.timeout`). Codex needs its own forwarder path. Both
  are separate follow-ups.

## Open questions

1. Claude Code: does `PermissionRequest` fire in `bypassPermissions`, `auto`,
   `acceptEdits` and `dontAsk` modes, and for MCP tools (`mcp_server` input)?
2. Claude Code: the documented maximum `timeout` for `http` hooks, and whether
   a 45 s open request is held reliably; retry behaviour, if any.
3. Claude Code: when several `PermissionRequest` hooks answer, which decision
   wins? Not stated in the docs read.
4. Codex: command hook failure semantics (timeout, crash, invalid JSON) for
   `PermissionRequest`; whether a trust hash changes on every `connect` (the
   command includes a Node path), which would cause re-review prompts.
5. Antigravity: the official `PreToolUse` decision contract, and how
   `request-review` mode interacts with hook allow. Which hooks path is
   correct (`~/.gemini/config/hooks.json` in the connector, versus
   `~/.gemini/antigravity-cli/hooks.json` in a third-party guide).
6. Gemini CLI: is it still supported after the 2026-06-18 transition? If not,
   the connector and its tests should be marked for removal.
7. Hermes: is a transport plugin shipped inside the Extalia package or
   installed by `extalia connect`? The plugin can only be selected with
   `transport_fallback: builtin`, which must be a visible setting.
8. Session-scoped allow (Claude `updatedPermissions` with `destination:
   "session"`): is the UX worth the risk, and what rule scope is safe?
9. Ownership: the Bridge and Desktop each host an ingest listener. Which
   process owns pending approvals when both run, and what happens when the
   other one is the answering UI?
10. Token: should the approval route use a token separate from the notify
    route, and should Claude read it through `allowedEnvVars` rather than a
    literal header?

## Sources

- Claude Code hooks (official): https://code.claude.com/docs/en/hooks
  (formerly `docs.anthropic.com/en/docs/claude-code/hooks`, redirected).
  Local binary check: `~/.local/share/claude/versions/2.1.295` contains
  `PermissionRequest`, `hookSpecificOutput`, `onFailure`,
  `updatedPermissions` and `permissionDecisionReason`.
- Codex hooks (official, redirected): https://learn.chatgpt.com/docs/hooks
  (from `developers.openai.com/codex/hooks`). Local binary check:
  `codex` 0.163.0 (Homebrew Caskroom) contains `PermissionRequest`,
  `permissionDecision` and `updatedInput`.
- Gemini CLI hooks reference: https://geminicli.com/docs/hooks/reference/ ;
  conflicting mirror: https://mintlify.wiki/google-gemini/gemini-cli/reference/hooks
- Antigravity CLI hooks: https://antigravity.google/docs/hooks (search result,
  not read directly).
- Hermes Agent v0.22.0 (local checkout `~/.hermes/hermes-agent`):
  `website/docs/user-guide/features/hooks.md` (`pre_tool_call` 546-590,
  shell-hook timeouts about line 1821, `pre_approval_request` 1361-1393,
  outbound webhooks notify-only about line 2141);
  `website/docs/user-guide/features/plugins.md` (approval transports 262-320);
  `website/docs/user-guide/security.md` (approval timeout 186-200);
  `hermes_cli/plugins.py:430,1451`; `hermes_cli/config_defaults.py:1781-1783`
  (`transport: builtin`, `transport_fallback: deny`).
- Repository: `packages/host/src/hooks/http.ts`, `hooks/ingest.ts`,
  `connect/claude.ts`, `connect/codex.ts`, `connect/codexAppServer.ts`,
  `connect/forwarder.ts`, `connect/gemini.ts`, `connect/hermes.ts`,
  `connect/antigravity.ts`; ADR 0004; `docs/architecture/security.md`.
