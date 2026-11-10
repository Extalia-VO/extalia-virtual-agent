# ADR 0066: Profile-scoped automatic post-task learning

Status: Implemented and verified locally v0.4.235; full `pnpm check` and focused
English/Indonesian desktop/mobile Settings browser flows passed.

## Decision

Persist an opt-in automatic-learning policy per Extalia workspace vault profile,
with independent skill-candidate and note destinations. Bind note consent to the
canonical selected vault root separately from meeting-minute consent. Capture
the policy revision at Native Chat admission and revalidate it before inference
and persistence. Do not expand model or workspace permissions.

After a successful saved substantive Chat turn, retain parent invocation ownership
and run one bounded read-only curator using the approved lead provider. Supply
only successful tool evidence captured in the current root invocation. Historical
conversation results are not evidence for a later task. The curator submits data;
it has no write, command, memory, skill-registry or delegation tools. A valid skip
is normal. Plan, paused-team, history-off, failed and cancelled work is ineligible.

Host-owned persistence sends at most one generated candidate through mandatory
registry import/inspection, without approval or activation, and one immutable note
to the pinned profile vault. The shared user skill library carries profile/run
provenance, not profile isolation. Durable hash admissions prevent repeated
automatic candidate imports after uncertain acknowledgements. Notes carry actual
evidence and receipt metadata and never overwrite different existing content.

The runtime's pre-completion hook checkpoints successful source history and awaits
optional learning before parent terminal/idle events. Child terminal events also
wait for storage settlement. Deadline/cancellation aborts work but never releases
ownership before the underlying provider/tool has actually settled. Learning
failure does not reclassify source-task success. Subsequent prompts remain queued.

## Office behavior and limits

Only actual knowledge activity or an identified skill tool routes a worker to the
Skills room. Free-text mentions do not. Authored stations have exclusive occupancy
and overflow stays at a desk. No meetings or successful learning are fabricated.

There is no new observed-app, Hermes or mission capability. Additional profile
vaults are explicit Markdown export destinations; indexing and model read access
remain separate. No application configuration or real user profile is changed by
tests or installation of this feature.

## Rust ownership amendment

[ADR 0067](0067-rust-owned-learning-and-profile-artifacts.md) moves this feature's
curator state machine, deterministic result processing, deduplication, staging
and note filesystem effects to Rust. The production curator now reviews supplied
current-turn evidence without general host read tools. The approved provider
adapter and physical effect drain remain host ports; consent, quarantine and
parent-settlement requirements above still apply.
