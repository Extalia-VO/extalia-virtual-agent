# Native teams with multiple models and connections

Extalia Native can delegate independent tasks to several team members. Each
worker has its own bounded model/tool loop and reports its result to the lead
agent. The lead combines those results into its response.

Open the team's setup dialog from the prompt dock, Chat or a managed session. Choose
the lead connection's allowed models, then add any additional saved connections
the team may use. For each additional connection, explicitly select the permitted
models in priority order (up to 32 per connection). A catalog lookup only lists choices; saving the team
grants access. Custom model ids remain useful when an endpoint cannot list them.

For each member, choose the lead connection or one of those additional
connections, then set its preferred model and fallbacks. A member with no explicit
model chain uses its selected connection's approved order. For example, a
researcher can use one saved connection while a reviewer uses another; both can
work concurrently on independent read tasks. No API key is copied into the team.

The roster supports up to **32 members**, eight additional connections and 32
permitted models per connection. Each explicit member chain holds up to eight
models in order: one primary and up to seven fallbacks, within the same saved
connection. A larger catalog is not a request to run every model.

A Native lead turn admits at most **eight active worker invocations**. Further
readers queue without occupying active slots. Cancelled queued calls never enter
the provider; cancelled active calls retain their slots until their work actually
settles. Other sessions have their own turn budgets, and provider quotas can
still reduce throughput. Delegation counts and per-worker step limits also bound
each turn. All eight admitted workers can use eight different approved models
at the same time, including different saved connections. A controlled regression
verifies overlapping calls and exact model routing; it is not a paid-provider
benchmark. An enabled saved roster can raise the per-turn call budget above the
connection’s generic delegation setting; it never raises the eight-active-worker
ceiling. The separate read-only Missions feature keeps its own task/concurrency
limits unchanged.

32 is an initial conservative product ceiling, not a measured universal optimum.
The current Office has 51 allocatable desks; one full roster plus its lead uses
33 before other sessions are counted. Overflow still follows Office seating
rules. Choosing 32 rather than 40 leaves more shared-office and context headroom.
No real-provider cost, latency or hardware-capacity claim is implied.

Jobs for the same named member queue, and write-capable jobs serialize because they share the project folder.
Scope, forbidden paths, permission mode and approval rules still apply.

Chat shows the saved team status, setup and an active/inactive switch. Disabling
a team retains the roster, models and connection grants. Unconfigured, empty and
paused Native teams work solo, including when a connection has tier settings;
active delegation requires a named member. The setup persists across prompts.
Concurrent model roster edits cannot replace newer user settings.

Saving a session team affects its next turn. Saving a workspace default affects
new sessions; existing sessions keep their own team. A model may reorganize the
roster within approved connection/model choices, but it cannot authorize another
saved connection itself. Missing connections produce an error instead of routing
work through an unrelated provider. Mission connection settings are separate.

Each provider keeps its own request limits and feature ownership. A worker only
receives Extalia memory or skills when its selected connection enables that
feature. Status reports active local invocations, and cancellation remains pending
until their work settles. A cancellation request is not proof that an external
provider stopped immediately.

These settings describe **Extalia Native**. Hermes uses its own delegation
capabilities; the team editor must not promise Native multi-connection routing
for a Hermes session.

## Hermes is a different adapter

Hermes supports multiple delegated children. Its standard batch concurrency
default is 10, configurable by `delegation.max_concurrent_children`. Standard
children use the shared `delegation.model`/provider or inherit the lead model;
the base task schema does not expose a model selector for every child.

Extalia invokes Hermes with **`--oneshot`**. The separate
`delegation.oneshot_max_children` setting defaults to **two children total across
calls in one finite run**. Increasing the batch limit alone does not increase
that total. Setting the one-shot limit to eight permits up to eight configured
roles in Extalia; setting it to zero removes Hermes's total budget, while
Extalia retains its **32-member roster ceiling**. A smaller batch limit controls
how many children Hermes can admit together, independently of roster size.

The team editor reads the selected workspace profile, or the saved session's
profile for a session team. It shows the configured total, batch limit and shared
worker model. Refresh the profile limits after changing the profile outside
Extalia. Saves, planning and dispatch re-read limits before admitting an enabled
team; lowering a limit preserves the existing roster for review instead of
silently deleting members. Missing metadata from an older host keeps the
conservative two-member policy. Failed profile reads block enabled team changes.
Named profiles use their own configuration, not the default profile's values.

Hermes team controls configure roles, tasks and soul. Individual model chains
and connection assignment controls are hidden. Choose the lead model in the
message composer; the Hermes profile determines standard delegation routing.
Dormant Native model settings are retained; unsupported cross-connection Hermes
bindings are refused. Use Native for separately selected worker models and
fallback chains. Custom Hermes backends may route differently; this adapter
refuses enabled teams for a configured custom backend because it cannot promise
its shared-model contract.

Profile metadata describes current configuration, not proof of a resumed
session's effective backend: Hermes can retain the backend in its saved tool
set. Start a new Hermes session after changing the delegation backend. Extalia
does not rewrite Hermes profiles. The checked Hermes source exposes no verified
CLI/environment override for the one-shot total-child setting.

For upstream details, see the official
[delegation guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
and [delegation configuration source](https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool_config.py).

## Roster, queue and Office presence

A 32-member roster makes roles available; the lead only invokes the members it
needs. A member that has never been invoked stays offline and is not drawn in
the Office. If the lead submits 32 eligible Native jobs together, eight can run
and the remaining 24 wait for capacity. Queued members are shown as waiting,
with the capacity reason, and remain in the Office until admitted or cancelled.
They do not use idle departure timers while waiting for a worker slot.

After a worker completes or stops, its Office character can linger for a stable
per-character period: one to five minutes at the desk, then six to fifteen
minutes on an idle outing, for seven to twenty minutes total before going
offline. New activity brings it back to its desk. These are visual presence
timers; a completed character does not keep a model request running.
