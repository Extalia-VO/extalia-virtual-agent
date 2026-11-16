# Cross-agent continuity acceptance — issue #112

This work strengthens the host and makes evidence review reproducible. It does
**not** close [issue #112](https://github.com/Extalia-VO/extalia-virtual-agent/issues/112)
or [release gate #60](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60).
The required live chain is Codex → Gemini → Claude Code → the original Codex
session, including genuine native compaction and sustained work. The older
[v0.4.288 report](live-handover-chain.md) did not exercise compaction or executable
artifact verification, and its raw evidence is not shipped here.

## What this change proves

| Layer | Evidence | Limit |
| --- | --- | --- |
| Reservation publication | File and directory fault-injection tests; acknowledged reservation before dispatch; no automatic replay after uncertain settlement | POSIX journal publication under an already durable profile root; Windows provides atomic file/process-restart recovery, not power-loss acknowledgement |
| Evidence selection | Actual Codex, Claude and Gemini parsers preserve external continuity tool identities; imported archive reads do not become new evidence | Anonymous streamed output is not assigned an invented tool identity |
| Long-history host continuity | Real temporary host, disk ledger, importers and scoped MCP; synthetic history larger than 4 MiB; three transfers, two restarts and original-source recovery | Synthetic provider transcripts and compaction markers, zero provider calls |
| Executable work | Controller-owned verifier compares actual artifact behavior with an offline inventory specification | Finite functional checks; no hostile-code operating-system sandbox or live model-quality certificate |
| Live evidence review | Hashed artifacts, native invocations, exact reviewed transfers, original-source retrieval and restart checks | Trusted local collector; hashes are integrity checks, not vendor-signed attestations |

Captured evidence remains recoverable after the observation window no longer
contains it. A decision omitted **before any checkpoint captured it** cannot be
reconstructed by this feature. Source windows, snapshot limits and omissions
remain visible in product coverage metadata.

The journal writer also flushes directory ancestry it creates itself. Startup's
layout owner can create a profile root before that writer runs; publication of
that earlier root is outside this acknowledgement. Whole-profile creation and
unconditional sudden-power-loss durability are not claimed.

## Commands

Install the repository's pinned dependencies first. From the repository root:

```sh
pnpm acceptance:continuity
pnpm acceptance:continuity:workload --prepare --run-id continuity-001 --output /absolute/disposable/run-001/controller
pnpm acceptance:continuity:workload --verify --run-id continuity-001 --project /absolute/disposable/run-001/project --output /absolute/disposable/run-001/verification
pnpm acceptance:continuity:evaluate --manifest /absolute/disposable/run-001/evidence/manifest.json
```

Create the parent run directory and a separate disposable project beforehand;
use canonical real paths. Preparation and verification create new directories
and refuse to reuse an existing path. Keep controller prompts, decision tokens,
verifier and evidence outside the agent project. The verifier reads a bounded
copy of `normalizer.py`; it does not edit the submitted project.

Preflight only locates executables, pins their bytes and runs `--version` in
temporary homes with a restricted environment. It makes no inference request
and changes no real application configuration. Optional `--codex`, `--gemini`
and `--claude` arguments select executable paths. Available decoders and a
version string do not establish installed-version compatibility.

The evaluator exits **0** only for `live_pass`, **2** for `blocked`, and **1**
for invalid or failed evidence. Fixture manifests always remain blocked when
otherwise structurally valid. A verified Gemini compaction observer is still
missing, so the complete current contract cannot return `live_pass`.

These commands prepare work, verify an artifact and evaluate evidence. They do
not launch the four provider sessions or automatically collect a live run.

## Workload and collection procedure

1. Pin a clean repository revision and record the installed CLI versions and
   executable hashes. Use a disposable project, isolated application profiles
   and one explicitly associated Extalia workspace. Review the installed
   clients' supported resume, MCP and compaction interfaces before collection.
2. Deliver `firstPrompt.txt` once to the original Codex session. The task is an
   offline Python inventory normalizer: stable order, first valid duplicate,
   Unicode case folding, strict integer quantities, 73 admitted unique rows,
   immutability, no retained state and a precise CLI contract.
3. Deliver `checkpointPrompt.txt` once at the first stage. Its run-specific
   decision token stays in that conversation, outside project artifacts. Capture
   the source before long-history truncation or compaction can remove it.
4. Use the substantive pressure prompts for continued work and record actual
   native user turns, tool results and outputs. The minimum is 48 fresh user
   turns, 24 fresh tool results and 256 KiB of unique fresh message/tool content,
   with at least four user turns in each stage. Repeated copies of an old
   transcript do not increase these counters. These thresholds establish a
   repeatable workload; they do not themselves prove context-window compaction.
5. For each hop use the product's normal preview/apply APIs and retain the
   exact reviewed packet, exact delivered bytes and original receipt. Bind the
   receiving observed endpoint explicitly. Manual delivery remains
   `manual-ready`; external CLI replies do not upgrade the transport receipt.
6. Record supported native compaction boundaries and subsequent scoped archive
   tool calls with their actual responses. `/compress` text, hook notifications,
   rewritten history and a token-count reduction alone are insufficient.
   Intermediate recovery requests do not echo the decision token.
7. Return to the original Codex native and host IDs. The last delivered packet
   must omit the decision token. The final agent must obtain it from a scoped
   read of the original Codex snapshot, then identify it in a fresh answer.
   Reading a later agent's repetition does not prove original-source recovery.
8. Restart the host and retain before/after views with distinct actual host
   process IDs. The final restart must preserve canonical identity, all three
   receipts and original source snapshots. Run the independent artifact verifier
   after the last agent answer, then evaluate the completed evidence directory.

An entered provider effect with an uncertain outcome must retain its original
operation ID and be inspected. Do not automatically retry it to manufacture a
successful chain. Mid-chain rate-limit/failure acceptance remains an additional
issue #112 scenario; it is not certified by this compaction evidence evaluator.

## Evidence contract

All artifact references have the form
`{ "path": "relative/file.json", "sha256": "<64 lowercase hex characters>" }`.
Paths are relative to the directory containing `manifest.json`. Traversal,
symbolic links, hard-linked files, changed hashes, oversized artifacts and
unbounded aggregate reads fail. Preserve original private artifacts for local
review; publish only an explicitly reviewed redacted summary, since native
transcripts and scoped bearer codes can contain sensitive work.

The top-level manifest is:

```json
{
  "schemaVersion": 1,
  "mode": "live",
  "runId": "continuity-001",
  "sourceRevision": "<clean 40-character Git commit>",
  "sourceDirty": false,
  "objective": {
    "firstPrompt": { "path": "firstPrompt.txt", "sha256": "<sha256>" },
    "checkpointPrompt": { "path": "checkpointPrompt.txt", "sha256": "<sha256>" },
    "requiredFact": "<original decision token>"
  },
  "stages": [],
  "transfers": [],
  "restarts": [],
  "verification": {
    "command": { "path": "verification-command.json", "sha256": "<sha256>" },
    "result": { "path": "verification-result.json", "sha256": "<sha256>" }
  }
}
```

The placeholders and empty arrays above document the shape; they are not a
passing fixture. Executable examples of the complete structure are maintained
in [the evaluator tests](../../tooling/test/continuityAcceptance.test.ts).

| Record | Required content |
| --- | --- |
| Four stages | Runtime order `codex`, `gemini`, `claude-code`, `codex`; version, native session ID, host session ID, canonical ID and ordered operations |
| Operation | Kind `initial`, `checkpoint`, `pressure`, `compaction` or `recovery`; artifact fields `invocation`, `prompt`, `beforeTranscript`, `transcript`, `reply` and `stdout` |
| Invocation JSON | `kind: native-cli`, run/runtime/version/native ID, absolute executable path and SHA-256, actual argv with native ID, positive PID, exit code, signal and timestamps; input, response and stdout hashes |
| Three transfers | Consecutive source/destination stage indexes; reviewed packet, delivered packet and actual product receipt references |
| Restart pair | `before` and `after` references to `{ runId, pid, at, view }`; `view` is the product's complete `ContinuityView` |
| Verifier command | `kind: independent-artifact-check`, run ID, executable, argv, cwd, artifact and verifier references |
| Verifier result | Actual PID, exit code, signal, start/finish timestamps, artifact/verifier SHA-256 and distinct boolean check results |

When consolidating prepared prompts or verification output into the evidence
root, update their **relative reference paths** consistently, including the
artifact and verifier references inside `verification-command.json`, and hash
the rewritten command record. Do not change native transcript bytes or reviewed
packets. The product packet digest hashes `JSON.stringify(packet)`; it is
distinct from the raw UTF-8 artifact-file hash.

The evaluator recognizes existing Codex JSONL, Claude conversation JSONL and
Gemini `ConversationRecord` JSON formats. Unsupported recording layouts remain
unverified; adding a parser requires evidence from an installed client. It
compares native events against the before transcript and invocation timestamps,
matches calls and results, and checks access-code/snapshot/canonical ownership.
Controller claims alone do not replace native scoped-read evidence.

For this initial collection contract, Codex/Claude JSONL must preserve the prior
raw prefix and Gemini must preserve its previous message sequence. Each next
`beforeTranscript` must equal the preceding `transcript` for the same native
session, including the final Codex return. History rewrites, Gemini JSONL
patches/rewinds and reused native message IDs are not accepted as fresh work;
support requires separately verified native-format evidence.

## Issue #112 completion remains open

- Define and integrate the protocol/core `HandoverCapsule` contract, including
  knowledge provenance, compaction state and a memory barrier identifier.
- Establish an explicit pre-compaction checkpoint and a scope/revision-bound
  memory acknowledgement. `WorkMemory.drain()` only waits for admitted promises;
  a failed backend capture can leave a durable pending outbox row after it
  returns. Idleness is not successful memory indexing.
- Verify external Knowledge/Obsidian provenance across actual provider hops.
- Collect genuine normal, compaction/long-session, mid-chain failure/resume and
  boundary-safety evidence using the current source and installed clients.
- Verify Gemini's native compaction completion evidence and installed Desktop
  behavior. Do not infer support from the presence of a compression command.

## Verification record

Local Linux verification on 2026-11-15, source v0.4.332 based on the published
v0.4.331 commit `078a81872cb00f88f4066923c8372465bf88edb9`:

- **261 tests passed across 19 suites; one platform-conditional case skipped.**
  This includes journal failures, actual host handovers/checkpoints, grants,
  bounded archives, observed memory, Native compaction projection, the new long
  synthetic chain, 35 evaluator/preflight cases and 16 workload-verifier cases.
  The skip is the existing unsupported-platform archive case on a supported
  POSIX platform; no failing test was disabled.
- All workspace TypeScript checks passed. Package and Cargo versions are
  consistent at v0.4.332. The ownership inventory was reviewed for exactly the
  three modified host implementation files; no classification was weakened.
- `pnpm check` passed repository lint, boundaries, ownership, public safety,
  schema freshness and all workspace typechecks, then stopped at
  `check-rust.mjs --build-daemon` because Cargo is unavailable in this environment.
  Its later full test/build stages were not reached. The focused suite above was
  run separately; the complete repository/CI gate is not claimed green.
- The correct normalizer passes 17 artifact checks. Deliberate wrong ordering,
  boolean quantities, incorrect limits, Unicode lowercasing, integer precision
  loss, interpreter monkeypatches, type-tag impersonation, excessive output and
  source/oracle mutation fail their relevant checks.
- Actual preflight found `codex-cli 0.167.0-alpha.4`; Gemini and Claude executables
  were unavailable. It returned `blocked` with zero inference calls. Installed
  compaction compatibility remains unverified, including for the available Codex.

No live inference result is claimed. CI fixture repairs previously deferred by
the owner remain outside this change. The PR remains a draft for review, with
the Rust/full-repository gate and installed-provider acceptance still open.
