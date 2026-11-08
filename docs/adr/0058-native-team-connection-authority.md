# ADR 0058: Native team connection authority

Status: Implemented and verified locally v0.4.190, 2026-11-08

## Context

Native already supports concurrent read delegates and ordered model fallbacks,
but its member models resolve through the lead's saved endpoint and credential.
Different model ids therefore do not establish independent provider routing.
Multiple simultaneous jobs for one named member also share an Office identity.

## Decision

Keep the existing lead `allowedModels` chain for compatibility. Add optional
team `connections`, each containing a saved `connectionId` and an ordered,
nonempty `allowedModels` list. A member may select a `connectionId` only from
this explicit user policy. Its model chain must be a subset of that connection's
approved models; an empty chain inherits that connection's approved order.
An omitted member connection continues to use the lead connection and chain.
Persist identifiers and model policy, never provider credentials.

The team editor inspects catalogs without granting access. Saving the team's
connection policy is the authorization step. Prompt imports, model planning and
`manage_team` cannot mint additional connection grants. This authority is separate
from workspace mission connection policy. Hermes remains capability gated;
Native routing must not imply that an external runtime supports it.

At turn admission the host owns a snapshot of every approved connection used by
the team. Provider creation uses each selected connection's API, endpoint,
credential and request limits. Mutation guards cover those connections until
the turn and its actual workers settle. Missing or unapproved references fail
closed rather than falling back to the lead provider. Team edits affect the
next turn; model-driven roster edits stay within the admitted policy.

Independent readers run concurrently, with at most 20 roster members and eight
additional connections. Existing delegation and step budgets still apply.
Concurrent invocations of one named member queue to preserve its stable Office
identity. Write members continue to serialize across the shared workspace and
use existing scope, forbidden-path and approval checks. This does not implement
isolated parallel worktrees or recursive unbounded delegation.

Workers run their own bounded tool loops and return results to the lead for
synthesis. Cancellation tracks actual settlement; requesting cancellation alone
does not prove an uncooperative provider has stopped. Per-connection Extalia
memory/skill ownership applies to worker tool availability, with existing
workspace authority checks retained.

## Verification

Use temporary profiles and mock endpoints to prove concurrent distinct-provider
requests, model/credential separation, worker tool use and lead synthesis.
Cover schema and plan preservation, denied grants, missing connections,
configuration changes during work, queued cancellation and stable member state.
Inspect the real team editor in English/Indonesian, light/dark and phone layouts.
Record final full repository checks in the PRD tracker. Mock-provider validation
establishes local routing behavior, not a paid-provider capacity or cost claim.

The full `pnpm check` passed: 6,241 TypeScript tests, 23 optional tests skipped,
474 Rust tests, lint/typechecks and all builds. Independent review findings were
resolved with regressions for planning, disabled teams, feature isolation and
initially empty rosters. Real isolated Bridge browser checks exercised concurrent
mock OpenAI Chat and Anthropic Messages endpoints, both workers' local file reads,
separate credentials and final lead synthesis. The team editor passed 12
theme/material/language/viewport combinations. Office display now prefers actual
worker model/fallback metadata, with configured models for standby Native members
and persisted team revisions for same-size edits.

## Capacity follow-up (v0.4.194)

The original 20-member/model-pool limits above are superseded by a 32-member
Native roster and 32 approved models per connection, retaining eight models per
member chain. A separate eight-active-worker queue now bounds each Native lead
turn. The Hermes one-shot adapter accepts two configured members and does not
apply per-member model choices; upstream profile/routing capabilities differ.
See [current team guidance](../getting-started/native-teams.md).


## Hermes profile follow-up (v0.4.195)

The fixed two-member Hermes adapter policy above is superseded by fresh selected
profile metadata. One-shot total children (default two, zero unlimited) bounds
the enabled roster, capped at 32; batch concurrency (default ten) stays separate.
Workspace defaults and saved-session profiles are resolved independently.
Profile/team mutations serialize so an asynchronous configuration read cannot
persist a stale roster against a changed profile. Shared standard worker routing
remains distinct from Native's per-member model policy; configured custom
backends are refused. Metadata describes configuration, not a resumed session's
pinned backend. See the current team guidance for refresh and Office lifecycle.
