# Live native Antigravity handover acceptance

On 2026-11-12, source v0.4.290 completed a controlled **Codex → Antigravity → original Codex** roundtrip. The actual Extalia React handover UI was connected to an isolated real host. Antigravity used its installed native RPC; Codex continued through the official CLI resume route. The original task was introduced once, and its work context was not manually pasted into a destination harness.

## Task and observed results

The task produced a Python CSV-normalization implementation, executable tests and usage documentation in a controlled project. Codex first supplied the implementation and recorded decisions. Antigravity continued that work and added fourteen tests. Returning Codex retained those artifacts and completed the documentation and progress record.

| Check | Observed evidence |
| --- | --- |
| Original implementation | Preserved byte-for-byte across the accepted roundtrip. |
| Antigravity test contribution | Fourteen tests, retained unchanged on return to Codex. |
| Independent verification | Fourteen tests passed; the final Codex run also reported fourteen passing tests. |
| Original decisions | Retained in the final work state. |
| Remaining work | Final progress record marked complete with no remaining tasks. |
| Conversation identity | Codex resumed its original native session; Antigravity retained its created native session. |
| Work identity | Both transfers belonged to one canonical work record. |
| Native creation recovery | The accepted UI operation issued one native creation call; registration resumed using that same operation and native ID. |
| Final host restart | The saved result records `finalHostRestartVerified: true`; native counters remained one creation and two Antigravity submissions, with no replay. |

The Antigravity transfer receipt was `submitted`; the return Codex CLI receipt was `queued`. These remain transport states. Acceptance also checked retained files, decisions and test results rather than treating either receipt or a native idle event as proof of completed work.

The two native Antigravity submissions were the inert readiness bootstrap and the reviewed task packet. The final restart check retained the original conversation identities and work record without another native creation or submission.

## Creation and workspace evidence

An earlier native helper probe showed that setting the helper process cwd did **not** bind the new conversation to that folder. The accepted path therefore supplied workspace URIs through the declared native `StartCascade` API and checked the returned ID, native metadata and native trajectory against the controlled folder.

Native creation and readiness completed before Extalia finished registering its observation. Explicit recovery reused the original creation operation and attached that same conversation after project attribution was corrected. It did not create a replacement or resend the original task. Earlier capability-probe sessions are separate QA artifacts and are not included in the accepted operation's one-creation count.

The readiness bootstrap was separate from the reviewed work transfer. It requested only `READY` and forbade tools or file changes. The later transfer used the reviewed capsule, and its execution was correlated with the native client message ID. Workspace attribution came from authenticated metadata, not a forged transcript cwd or a path mentioned in prompt text.

## UI and fixture verification

These checks supplement the real roundtrip; they do not establish additional live model capability:

- **Harness picker:** twelve simulated-host scenarios covered existing-session and explicit-creation flows across English/Indonesian, light/dark and laptop/mobile variants. Creation occurred only after its action, unavailable detected adapters stayed disabled, and technical settings remained in Advanced. No horizontal dialog overflow was found.
- **Observe:** twelve simulated-host scenarios covered English/Indonesian, light/dark and wide/laptop/mobile layouts. They checked grouping/search, session switches, draft retention through hooks, Tools and message/file tabs, independent scrolling and retained reading position. Folder-only sessions remained explicitly unlinked.
- **Real local HTTP fixture:** the public host factory exercised native-shaped RPCs and real temporary brain transcripts without cwd metadata. It verified correct workspace attribution, replay-safe registration, exact packet delivery and canonical continuity. Lost-acknowledgement recovery inspected the original ID; a missing ID stayed uncertain without another creation request.

Explicit **Inspect native connection** recovery is separate from automatic retry. Its native reads must re-attest the registered ID/workspace, exact saved client message IDs after their baselines, and an idle trajectory. Successful reconciliation can release a delivery fence or rebind a rotated native endpoint while leaving the original unknown receipt unchanged. It does not repeat the prompt. These uncertainty/rotation cases have dedicated fixture tests; the accepted live roundtrip's final restart did not itself require an uncertain-message reconciliation.

## Context and compaction limits

This Codex/Antigravity roundtrip did **not** fill a physical context window or trigger native Antigravity/Codex compaction. Installed Desktop packaging and attachment to an existing Desktop process were not tested by this isolated UI/host run. No additional live Claude calls were made for this later acceptance after the scope changed to Codex/Antigravity.

A separate controlled Gemini CLI probe used a reduced native compression threshold. Native compression was observed in the same session, with reported token counts **1,531 → 845**. The decision marker and edge cases were retained. The initial answer omitted some schema/checklist fields; a later recall answer paraphrased their meaning. Exact full-schema equality remained false, so this is partial preservation evidence, not universal safe-compaction acceptance or a total-cost saving measurement.

Native Extalia compaction, physical maximum-window behavior, tool-call/result integrity under pressure and equivalent cross-runtime acceptance remain open. See the [shared-work memory status](../product/shared-work-memory-status.md).

The native journal has an explicit current capacity of 128 creation and 512 submission entries. It refuses further operations at capacity instead of discarding idempotency evidence. Supported archival is still open; the live roundtrip did not exercise capacity exhaustion.

## Local evidence

The authoritative roundtrip receipt is `output/antigravity-handover-qa/result.json`. It records two transfer receipts, original-session return, artifact hashes, registration recovery, the three fourteen-test results, `finalHostRestartVerified` and `nativeSubmissionCountAfterRestart`. Runtime inputs, transcripts and native identifiers remain in local QA artifacts rather than this public document.

Simulated UI matrices are documented in `output/playwright/handover-harness-cards/REPORT.md` and `output/playwright/observe-refresh/REPORT.md`. The Gemini probe and strict recall assessment are recorded in `output/ui-handover-work/compaction-probe-gemini-ui-chain-result.json` and `compaction-probe-gemini-ui-chain-recall-result.json`. These output directories are excluded from source control.
