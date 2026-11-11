# ADR 0073: Bounded automatic Native skill context

Status: Implemented and verified locally in v0.4.260 (2026-11-11).

## Context

A metadata preview and instructions asking a model to call `skill_read` do not
ensure a useful procedure is actually supplied. The owner requested host-owned
selection, mandatory memory guidance, configured-team orchestration guidance,
and visible reasons while keeping context small and permissions authoritative.

## Decision

Managed Native Chat prepares skill context at each safe model-request boundary,
after admitted steering and before the existing complete-request budget check.
It rebuilds from the base system rather than appending earlier selections.
Loaded bodies are not written into conversation history. Ordinary delegated
workers and both meeting rounds use their own preparation factory and selected
connection features; they do not inherit the lead's skill bodies or orchestrator.

When Extalia owns skills for the connection, canonical `memory-recall` is
mandatory. This loads guidance, not memory notes or permissions: disabled memory
remains disabled. Canonical `orchestrator` is mandatory for the lead only when
its saved team is enabled and has members. Unconfigured/disabled teams are
reported as skipped; workers cannot acquire delegation by reading a skill.
The explicit skills-off feature is respected.

Selection is local deterministic EN/ID matching, not an extra model request or
a claim of general semantic understanding. A bounded current prompt head/tail
has precedence. Short underspecified continuations may use the last two bounded
user messages; assistant/tool output is not independently searched as user intent.
Explicit current exclusions override names, aliases, historical matches and
required-core expansion. Caveman remains explicit current-request opt-in.

At most three optional procedures, including required cores, accompany the
mandatory guidance. Synonymous procedures are deduplicated. A complete specialist
and its core are admitted together; if the group cannot fit, the complete core
may be supplied alone and the specialist remains visibly skipped. No procedure
or license-bearing body is clipped to manufacture a fit.

The entire escaped source envelope, host guidance and bodies are bounded to
24,000 UTF-16 characters. This is a character ceiling, not measured token usage.
Admission also checks the actual prospective system, composed history/images and
tool schemas against the connection's explicit estimated input-token limit and
the existing structural request ceiling. Mandatory failure holds inference;
diagnostics retain the rejected request's pressure. No user history is deleted
or silently compacted to make room.

## Authority and lifetime

A private WeakMap-backed catalog grants read eligibility. Caller-supplied bodies,
forged catalogs, names and source flags cannot mint it. The full-body read helper
preserves canonical built-ins and exact registered revision/digest reload checks;
it does not reuse the truncated output of `skill_read`. Every request repeats
selected external verification, so revocation removes that procedure from the
next prepared system. New activation joins on the next turn's inventory.

External bodies remain escaped JSON source data with host-owned scope and
permission guidance outside the envelope. Neither content nor a load receipt
can enable tools, expand member scope, select a new model/connection, approve an
action or activate another skill. Cancellation is checked around awaited reads
and publication; current feature/workspace authority is checked again after the
receipt has been persisted. Invocation ownership remains held until preparation
actually settles.

At most eight external full-read attempts and twelve optional attempts occur per
request, including unavailable or oversized candidates. This bounds repeated
failed reads, not the initial catalog scan: existing raw-row limits and linear
startup verification I/O remain. No skill-body cache or constant startup cost is
claimed.

## Reporting

A new `skills.loaded` protocol event records bounded names, source, fixed reason
and intent codes, status and character accounting. It contains no body, raw
prompt, free-form source explanation or secret. Up to eight entries are retained;
loaded entries are never hidden. An optional bounded omission count describes
other candidates not loaded without inventing names or reasons. Identical
metadata is deduplicated within an invocation; changed selection is recorded.

The shared Chat/Office transcript renders a quiet disclosure with localized
EN/ID reasons, worker ownership, skipped/unavailable status and budget. Wording
states that instructions were prepared, not that inference entered or the model
followed them. There is no synthetic tool execution, Office work bubble or toast.
TypeScript/schema and Rust validate the display contract. Canonical mission
journal admission remains unchanged and rejects this receipt as control evidence.

## Scope and validation

This increment covers managed Native Chat, ordinary delegated workers and team
meeting participants. Observed external applications, canonical mission workers,
planning/curator helper completions and external harnesses keep their separate
contracts; they are not certified by this hook. Mission skill context needs its
own admission and display integration rather than broadening journal authority.

Focused evidence covers actual synthetic-provider host requests, skills-off and
memory-off, configured/disabled teams, worker connection ownership, both meeting
rounds, steering, cancellation, private catalog forgery, revocation, full-body
budget refusal, current exclusions, bounded failing registry reads and receipts.
No paid provider, real user profile or external application configuration is used.

The final `pnpm check` passed: 8,147 TypeScript tests (26 optional skips),
543 Rust tests, lint, types, schemas, reviewed ownership baseline, formatting,
Clippy with warnings denied, all builds and version/asset checks. Eight browser
fixture cases cover EN/ID, light/dark and 1440/390px with actual disclosure
clicks, keyboard toggles, no horizontal overflow and no page/console errors.
Default loaded-status text contrast pairs were checked separately (5.41:1 light,
7.51:1 dark); this is not complete accessibility certification. CLI/Desktop
bundles contain preparation and worker hooks; the renderer contains the shared
localized card. Detailed scope and results are in
[the evidence record](../architecture/native-skill-loading-evidence.json).

The Node host's private-catalog selection and request composition remain in the
reviewed backend inventory; the new shared validator is also recorded as review
code. The inventory now has 803 product source files and 240 outstanding
backend/review files. This is placement accounting under ADR 0071, not a language
migration score or a whole-app resource improvement claim.
