# ADR 0068: Pinned SkillSpector inspection and explicit skill activation

Status: Accepted; verified macOS 14+ ARM64 preview (0.4.240, 2026-11-09)

## Context

ADR 0023 specified a mandatory scanner gate, but the installed adapter always
reported unavailable. Imported and user-requested generated candidates could be
stored but not activated. Inspection ran synchronously with the core store lock,
which cannot be held during a real Python scan. The existing production path also
lacked a transition from inspected instructions to explicit user approval.

## Decision

Ship NVIDIA SkillSpector 2.13.4 at commit
`54824463814a0be01360792523ec7245a69190fc`, with exact hashed Python dependencies,
source/license notices and a relocatable CPython 3.13.18 runtime. Build tools are
maintainer-only; users need no system Python, uv or first-use package download.
The initial verified launcher is macOS 14+ ARM64; other platforms report unavailable until
their required confinement is implemented and tested.

A distinct one-shot scanner contract extends production behavior without turning
the probe-only health protocol from ADRs 0041–0044 into execution authority. Rust
checks the complete bundle against a manifest digest embedded in its own binary.
A runtime environment variable can locate a development bundle but cannot supply
or change its trusted digest. Pairing records tie each staged daemon to its exact
bundle; they are build/distribution checks, not runtime executable authority.

Sign native scanner files before generating the final manifest and compiling the
daemon. Desktop excludes only that verified scanner resource from later native
re-signing and verifies its hashes and signatures during packaging. A notarized
release needs Developer ID signatures on these files first; ad-hoc signatures
never satisfy that requirement. CLI packages include their matching bundle.

Imports and explicit `skill.rescan` actions use one bounded scanner worker queue.
Begin inspection under the core store lock, release it for the actual process,
then reacquire it and verify the single-use ticket, profile, tree, scanner, policy
and revision state before recording results. Ordinary details reads do not scan.
Mission heartbeats, cancellation, knowledge and registry reads remain responsive.
A completed scan cannot resurrect a revoked revision or replace newer evidence.

On macOS, the native owner uses a fixed sandbox profile, exact verified
interpreter/script, isolated Python arguments, a credential-free environment and
private scratch directory. Network and process forking are denied; read access
is limited to the bundle, candidate and required system libraries. Exact ancestor
directory metadata grants allow descriptor walks without granting descendant reads;
volume aliases do not bypass the input boundary. CPU, output,
file size and descriptor limits are enforced. Darwin does not support the intended
address-space limit: the Rust owner instead samples the owned child's resident
memory, refusing on an unavailable or invalid measurement and killing/reaping it
above the configured budget. This is a sampled watchdog, with observation latency
and possible overshoot, not a kernel hard virtual-memory cap. The 60-second wall
watchdog initiates termination; uninterruptible operating-system I/O can delay
reaping. The owner retains its slot until reaped, and startup quarantines unfinished
inspections after a daemon restart. No descendant
settlement claim comes from a process group alone; the sandbox forbids forks.

The worker invokes the pinned scanner with LLM analysis disabled. It neither
executes skill code nor fetches source URLs. It normalizes actual upstream output,
keeps the highest finding severity, and requires complete coverage with consistent
analyzer/component accounting and no exclusions or suppressed findings. Denied
OSV lookups or other uninspected work remain incomplete. Failures, timeouts,
invalid output, changed bytes and incomplete coverage cannot attest a clean scan.

Policy v2 permits a separate manual approval route for verified Markdown-only,
non-executable, declarative packages with no requested permissions and no unresolved
relationships. Clean/low scans may wait for approval; medium findings additionally
need a stored user review bound to the current inspection and tree. Packages that
need code/tool evaluation retain that requirement. No evaluation success is
invented, no automatic eligibility is granted, and no scan activates a revision.
User approval remains bound to the exact tree/permission digests and expiry;
activation rechecks scanner, policy, integrity and approval.

The Skill Security Center uses the existing lazy profile daemon independently of
the mission backend preference. New installations can import skills without an
experimental mission flag. Previously quarantined candidates have an explicit
rescan action. The UI shows scan progress, coverage, severity and scanner identity;
opening a book or viewing details does not approve, activate or rescan anything.

## Validation

Use isolated profiles and a real pinned bundle for benign, malicious, malformed
and oversized inputs; verify actual approval/activation and refusal without it.
Exercise cancellation/resource failures, bundle/report tampering, stale tickets,
revocation during inspection, stored-candidate rescans and unrelated daemon work.
Record platform-specific runtime and packaging evidence separately. The complete
workspace gate and native integration evidence must pass before this ADR is marked
verified. No real user profile, credentials, agent configuration or existing vault
is used for validation.


Recorded evidence: [native confinement and lifecycle](../architecture/skillspector-native-evidence.json),
[upstream fixture execution](../../tooling/skillspector/fixture-evidence.json), and
[production-host UI, explicit learning and packaged workflow](../architecture/skillspector-integration-evidence.json).
The final ARM64 preview DMG was mounted read-only: its actual daemon scanned
imports and generated proposals, refused activation before approval, and required
a separate activation after approval. Deep signature/architecture verification
and clean-toolchain Desktop launches with and without the daemon passed.
Only normalized inspection summaries and report hashes are retained; this update
does not expose or persist upstream raw finding reports.

Workspace validation at 0.4.240: `pnpm check` passed, including 7,759 TypeScript
tests and 501 Rust tests, lint, type checks, Clippy and builds. The later CLI smoke
output/deadline adjustments are validated separately against the packed installation.

The CLI platform tarball also preserved the complete scanner inventory and daemon
binding. An isolated temporary-prefix npm installation passed version, doctor,
launcher and daemon checks without a developer toolchain on PATH.
