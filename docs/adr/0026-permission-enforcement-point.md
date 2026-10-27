# ADR 0026: Permission enforcement point

Status: Accepted (2026-10-22) with the recommended defaults for its open questions; the owner
may revise them before the wave that implements them.

## Context

FR-16 requires permissions to be enforced "at tool-executor boundary, not in prompt text",
deny by default for shell, network, secrets, workspace writes and destructive actions;
PRD §8 control 4 requires a tool permission matrix with approval digest and expiry; PRD §17
says no agent can grant itself permissions or approve its own change; gate 3.4 / AC-07
requires digest-bound, expiring approvals enforced at execution; blueprint §4 says "the
frontend only displays decisions and is never the permission authority". Patch v1.1.1
moves the authority to the Rust daemon (audit PR 7: `permission.check`, "deny when the
daemon is unavailable").

Repository facts (working tree, 2026-10-21):

- **Decision point:** `decide(access, workspacePermissions, sessionGrants, mode)` in
  `packages/runtime/src/policy.ts` returns `allow | ask | deny`. `read`, `memory` and `meta`
  are always allowed (so `skill_read` and `memory_write` never ask); `plan` mode denies
  writes and commands; `sessionGrants` allow a whole access class (`write` or `execute`).
- **Enforcement point:** one call site, `packages/runtime/src/loop.ts` (tool call
  execution, after argument validation and `precheck`, immediately before `tool.run`). On
  `ask` it emits `approval.requested` with a random `approvalId` and awaits
  `options.requestApproval`; the outcome is `once | session | reject`
  (`ApprovalOutcome`); `session` adds the access class to `sessionGrants` for the rest of the
  session. Write-capable team members (`delegation.ts`) share the lead's `sessionGrants`;
  read workers get none; native mission workers get only `read` tools (`readOnlyTools` in
  `runtime/src/mission.ts`).
- **Approvals:** the host keeps one pending approval per run in RAM
  (`service.ts` `askUser`); `resolveApproval(sessionId, approvalId, decision)` resolves it,
  refuses observed sessions and stale ids. No parameter digest, no expiry, nothing durable:
  a restart drops the pending request (the run ends). The binding to the exact call is
  implicit because the loop waits in-process.
- Path containment and credential-file refusal live inside the file and command tools
  themselves (`policy.ts` doc comment), not in `decide()`.
- `@extalia/protocol` has `Permission`, `ToolCall.parametersDigest`/`idempotencyKey` and
  `Approval` (`parametersDigest`, `expiresAt`, `status`, `decidedBy` distinct from the
  worker) as unenforced contracts (ADR 0007); ADR 0007 left parameter-digest
  canonicalization open.
- ADR 0018 (Proposed) answers *observed* apps' approval prompts and never auto-allows; it
  does not touch native approvals.
- Skills currently declare no permissions (ADR 0025 adds them).

## Options considered

| Option | For | Against |
| --- | --- | --- |
| **Single enforcement point at the tool execution boundary in the core** (today `loop.ts` → `decide()`, later the daemon's `permission.check`) | One place to test; every runtime path (lead, team member, mission worker, skill) already passes through it | The TS loop must call the daemon synchronously per tool call once the flag is on (latency per call) |
| Enforcement inside each tool | Close to the effect | Duplicated, easy to miss for new tools; path checks stay there anyway as defence in depth |
| Prompt/system-instruction rules | Free | Not enforcement (FR-16). Rejected |
| UI-side gating (hide or disable actions) | Simple | Renderer and browser are untrusted clients; violates blueprint §4. Rejected |
| Fall back to TS `decide()` when the daemon is down | Availability | Two authorities; an attacker who crashes the daemon gets the weaker policy. Rejected |

## Recommended decision

1. **Policy enforcement point (PEP):** the tool execution boundary in the core, exactly one
   per runtime: today `loop.ts` before `tool.run`; after W2 the same call site asks the
   daemon. Every tool call (native lead, write members, mission workers, skill-driven calls,
   future `skill_run` for executable skills) passes it; tools keep their own path and
   credential checks as defence in depth. **Policy decision point (PDP):** `decide()` now;
   Rust `security/permissions` `permission.check` behind the flag (ADR 0021), ported from
   `decide()` with the shared fixture matrix as parity oracle (audit PR 7). `decide()` stays
   only as the oracle and for the flag-off path, which is a host setting, never an automatic
   fallback.
2. **Request shape.** `permission.check` receives: actor (agent id, origin `native`),
   profile and workspace (resolved by the host from the session, ADR 0024), session mode,
   tool, capability (`read | write | execute | network | secrets | memory | meta`), action,
   scope (canonical workspace-relative path or command class), `parametersDigest`
   (SHA-256 of RFC 8785 JSON canonicalization of the exact validated arguments), the
   active skill revision ids loaded into the task, and the policy version. It returns
   `allow`, `ask` (with an approval request id) or `deny`, always with a reason code
   (`mode_plan`, `workspace_policy`, `skill_ceiling`, `not_granted`, `approval_required`,
   `approval_expired`, `digest_mismatch`, `policy_unavailable`).
3. **Declared permissions vs grants.** A skill's manifest permissions (ADR 0025) are a
   ceiling and a request, never a grant. Grants come only from the user or the user's
   policy: workspace permissions, session mode, explicit approvals, and profile-level
   pre-authorized grants used by hybrid auto-activation (FR-18). Effective permission for a
   call = grants ∩ the ceiling of **every** non-built-in skill revision loaded into that
   task's context (most restrictive wins). Tasks without loaded skills keep today's rules.
   Activation never adds a grant; a revision whose ceiling exceeds the profile's
   pre-authorized grants needs explicit approval (AC-17).
4. **Fail closed when the daemon is unavailable.** With the flag on, a timeout, crash, EOF,
   handshake/schema mismatch or malformed reply is `deny` with `policy_unavailable` for
   every tool call, including reads; the run stops and a mission latches to `recovering`
   (ADR 0014 failure latch, ADR 0020). No `ask` is shown for an undecidable call.
5. **No self-approval.** An approval is decided only through the user channel: host API
   `resolveApproval` from the Desktop renderer (`contextBridge`, sender checked) or the
   authenticated Bridge. No tool, model output, worker, skill, scanner, Python worker,
   hook, observed session or MCP client may decide, create grants, change session mode,
   change workspace permissions or edit policy. `decidedBy` (the local user principal) must
   differ from `actorId`; a request whose actor is the decision channel is rejected. Tools
   that would wrap host approval or policy APIs are forbidden by a lint/boundary rule.
6. **Digest-bound, expiring approvals (gate 3.4).** Each `ask` creates a durable `approvals`
   row in `core.sqlite`: action, scope, capability, `parametersDigest`, actor, profile,
   workspace, skill revision ids, policy version, `requested_at`, `expires_at`, status. The
   user's decision must carry the approval id **and** the digest the UI showed; the PDP
   re-checks digest, actor, scope, expiry and policy version immediately before execution
   and consumes a `once` approval exactly once. Any argument change produces a new request.
   `session` becomes a recorded grant (capability + scope, expiring at session end, revoked
   by a mode change, a workspace permission change or a profile move). After a restart,
   pending approvals expire; they are never auto-granted.
7. **UI displays decisions only.** Renderer and Web client show the request (label, risk,
   short digest, reason codes, expiry) and send the user's choice; they never compute
   allow/deny, and their own state (hidden buttons, cached grants) has no authority. An
   "explain" query lets the UI show why a call was denied.

## Consequences

- W1 contracts: `permission.check` request/response and reason codes in `@extalia/protocol`,
  JCS digest fixtures, and a shared matrix (mode × capability × grants × workspace policy ×
  skill ceiling × daemon state) run against `decide()` and in `cargo test`.
- `decide()` gains no new authority; the skill ceiling and digest binding are built in the
  daemon (W2/W3), not added to the TS path first. Until then, the TS path keeps today's
  behaviour and its known gaps (no digest, no expiry, class-wide session grants).
- One IPC round trip per tool call when the flag is on; measured in the benchmark gate
  (audit PR 10), not assumed.
- `memory_write` and `skill_read` stop being unconditionally allowed once skills and memory
  are profile-scoped (`memory` capability checked against scope, ADR 0024).

## Open questions for the owner

1. Default `expires_at` for a `once` approval (proposal: 10 minutes) and whether `session`
   grants survive an app restart (proposal: no).
2. Should reads also be denied when the daemon is unavailable (proposed: yes, all calls), or
   may read-only tools continue in chat sessions?
3. Should `session` grants be narrowed from a whole access class to a scope (folder or
   command prefix) when they move to the daemon?
4. Is administrator break-glass (FR-16) ever enabled in the desktop product, and who counts
   as administrator on a single-user machine?
