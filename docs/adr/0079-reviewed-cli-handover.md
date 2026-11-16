# ADR 0079: Reviewed CLI continuation for observed handovers

Status: Accepted for explicit, installed CLI connections; runtime-specific acceptance is recorded separately.

## Context

Reviewed continuity capsules and pinned original archives already preserve one Extalia work record across native conversation IDs. A manual export still requires the user to move that packet into another harness. Hook observations alone do not grant permission to control that harness or prove that it consumed context.

## Decision

Add an explicit `official-cli-resume` delivery route for watched Codex, Gemini CLI and Claude Code conversations. The handover dialog can inspect the installed executable, original conversation ID, canonical working folder, native profile and reported model. The user confirms that the original interactive turn has stopped before pairing. Status inspection never launches or attaches a process; executable/version probing happens only during an explicit review.

The host owns source resolution and a bounded, supervised child process. It invokes official existing-session continuation, never a new/fork/latest fallback: Codex `exec resume`, Claude `--resume`, and Gemini ACP `session/load` followed by `session/prompt`. The Gemini client refuses unimplemented capabilities and cancels unsupported permission requests. This route does not attach to an already running Desktop process and does not provide its native approval/question controls. Existing native control routes remain preferred when available.

Each dispatch revalidates source scope, review binding and executable identity, journals the operation before spawning, and retains ownership until process close and stream drain. Admission is `queued`, not proof of context consumption or successful work. Exact native identity and terminal success are checked separately. Interrupted or unconfirmed effects remain uncertain across restart; reconciliation records inspection without inventing delivery or replaying a prompt. Equivalent observed aliases cannot run the same native conversation concurrently. Workspace-boundary changes and source handover wait for supervised execution to settle.

A small bundled, invocation-local MCP reader exposes only `extalia_continuity_status` and `extalia_continuity_read`. Its native caller is bound by the host. It cannot advertise side-effect tools, accept renderer-selected directories, broaden workspace scope or edit another application's configuration. Native authentication remains with the original profile; only scoped provider environment variables and the selected Codex provider's configured environment-key name are forwarded. Secret values are not stored in the pairing journal.

## Reported and configured models

A transcript's reported model is evidence about that transcript. It does not necessarily identify the provider route needed to continue it. In particular, a canonical Claude response model cannot safely be copied into `--model` when the native configuration uses a different route. Omitting the flag is also insufficient: native resume may restore the older saved selection.

Keep the reported model separate from an explicitly configured `resumeModel` and its source. For Claude, the bounded resolver reads the selected profile's `settings.json`, then the current folder's `.claude/settings.json` and `.claude/settings.local.json`, followed by an explicit `ANTHROPIC_MODEL` environment selection. The review exposes that candidate and the fixed arguments before pairing. A configured candidate can differ from the saved response model; the user reviews that difference. Without a configured candidate, Extalia does not synthesize a provider route from the response name.

This is a reviewed subset, not a reconstruction of every native setting source. Git-root/main-checkout local settings, ancestor discovery, managed policy, remote configuration and original invocation flags are not reproduced by this resolver. Native policy and model restrictions still govern execution. Native alias-selector environment variables are preserved and bound to the review revision; Extalia does not invent their mappings. The [native settings documentation](https://code.claude.com/docs/en/settings#settings-precedence) describes precedence beyond this subset.

Configuration reads are contained within the selected profile or current project folder, limited to 256 KiB per file, and checked for physical identity and revision changes. Malformed supported configuration, invalid explicit model values and escaping paths fail closed. Codex forwarding reads only the selected provider's `env_key` name from its contained `config.toml`; credential values stay in the process environment. Profile/settings contents, selected model source and relevant selector values invalidate a stale review when changed.

## Folder evidence and bounded coverage

The immutable Codex `session_meta.cwd` records the origin folder. Selected reads prefer the latest **visible, dated** native `turn_context.cwd`. Prompt text, embedded environment instructions and tool working-directory arguments cannot change a session's folder association. Equal timestamps use later source order; invalid, relative or undated folder records do not replace dated evidence. Existing model/effort freshness rules are independent.

Current-folder lookup reads a complete rollout up to 4 MiB. Larger selected sources use 512 KiB of complete head records and 3 MiB of complete tail records. An exact physical-revision cache keeps up to 500 results. Cold import discovery stays header-only unless a fresh cached result already exists; its unopened folder hint is therefore an origin hint, not a claim about the current working folder. Live observation parses the selected evidence rather than letting that hint override newer native metadata.

The omitted middle of a large file may contain folder changes. A large CLI resume consequently requires dated winning folder evidence in the tail; origin or head-only evidence cannot authorize a continuation in a potentially stale folder. Small legacy sources can retain their origin fallback. The host also checks the observed folder and its own workspace scope before dispatch. These bounds describe folder lookup, not constant-time behavior for all history parsing.

## Ownership and compatibility

Process supervision stays in the existing TypeScript host adapter, alongside other observed transports. This adds no inference engine to React and makes no unsupported memory, speed or language-migration claim; see ADR 0071. Native model calls and native compaction remain in their respective harnesses. CLI source identity, local process admission and semantic task acceptance are separate evidence.

Executables must support direct `shell:false` spawning. Shell-only launchers are not executed through a shell as a fallback. Runtime versions and platform differences can therefore make a CLI unavailable. An original application's concurrent activity cannot be excluded by a hook transcript alone; the explicit exclusive-continuation confirmation states this limit.

## Validation

Tests cover source/profile/path validation, selected-provider binding, review races, executable replacement, exact native identity, bounded I/O, retained child ownership, duplicate operations, restart uncertainty, inspected reconciliation, and the read-only MCP surface. UI tests cover async source changes, explicit pairing, route selection and narrow layouts. Real-model and compaction evidence is reported in the live handover benchmark; fixture transports are labeled separately.

The later native Antigravity roundtrip and its distinct acceptance limits are recorded in [ADR 0080](0080-detected-harness-and-native-handover.md) and the [native handover benchmark](../bench/native-antigravity-handover.md). Installed Desktop process attachment and universal compaction are not implied by either CLI continuation or that isolated UI test.
