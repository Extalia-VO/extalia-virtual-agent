# Live CLI handover acceptance

On 2026-11-12, Extalia source v0.4.288 completed a controlled
Codex → Gemini → Claude → Codex chain with live inference through an existing
configured router.

| Runtime | Version | Configured model route |
| --- | --- | --- |
| Codex CLI | 0.167.1 | cx/gpt-6.1-sol |
| Gemini CLI | 0.68.0 | ag/gemini-3.8-flash-low |
| Claude Code | 2.1.311 | ag/claude-sonnet-4-6 |

The test used a temporary project, separate application profiles and one
Extalia workspace. It prepared an inventory-normalization specification in
four stages. Original constraints included offline operation, Python standard
library, stable row order, first-duplicate retention and a 73-record limit.
A generated decision marker distinguished the original context. Gemini and
Claude each added a new marker and substantive progress.

## Delivery and observed results

The runner imported actual CLI transcripts into Extalia. At each transfer it
called the normal reviewed handover API with a linked observed destination.
The existing manual-export route produced the packet. The QA runner delivered
those exact bytes through the destination CLI's supported resume command.
The original task was introduced once, at the first Codex turn.

All recipients recovered the original decision marker, limit and normalization
rule. Claude retained Gemini's marker and all three edge cases. The final
Codex response retained both later markers, all three edge cases and all three
Claude test cases. The completed checklist advanced through four stages.
Codex returned to its original native session ID. All three source sessions
remained linked to one canonical work record with three transfer receipts.

The host was restarted after the Gemini stage and again after the final return.
The canonical identity, receipts and archived progress survived.

## Recovery when a packet is shortened

The first final-consolidation attempt correctly identified that the packet
shortened Claude's test-case entry. The receiver declined to invent the missing
cases. A follow-up in the same Codex session enabled the two scoped archive
tools in its temporary MCP configuration. Explicit tool permission was needed
because that profile's non-interactive policy denied approval requests.

The real Codex MCP client completed one manifest read and two evidence reads
through the actual Extalia hook server. It then recovered every original test
case and completed consolidation without receiving the original task again.
An incorrect explicit caller ID was rejected. Omitting that optional field
allowed the server's configured caller binding to apply.

The final response also identified inconsistencies in a generated test case
and retained the original text as source evidence. Context retention does not
establish that every intermediate proposal is correct.

## Scope and remaining acceptance

This run exercises live CLI harnesses, reviewed export, official resume paths,
actual transcript import, scoped MCP retrieval and model comprehension of the
declared checkpoints. The router's configured and reported model identities
were recorded.

Desktop window controls and automatic UI dispatch were outside this run.
Manual-ready receipts retain their normal meaning. The separately observed
CLI delivery and replies do not change them into native transport receipts.
No context-window compaction was triggered. The test generated a specification
and did not validate source edits, executable tests or whole-device performance.

Only temporary application configuration was changed. The runtime processes
and local test host were closed after verification.

Local evidence is retained under `output/live-handover-chain/`, including
`result.json`, the final specification, redacted original archives and CLI
outputs. Those local artifacts are excluded from source control.

The official [Codex resume workflow](https://learn.chatgpt.com/docs/non-interactive-mode),
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[Gemini headless interface](https://geminicli.com/docs/cli/headless/) and
[Claude programmatic interface](https://code.claude.com/docs/en/headless)
describe the CLI interfaces used.
