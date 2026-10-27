# ADR 0022: Python worker distribution and protocol

Status: Accepted (2026-10-21). Revised the same day: the owner chose **self-contained installers** —
end users never install Python, Rust, Node or npm themselves — so option A replaces B.

## Context

The blueprint makes Python an on-demand worker for the skill scanner, embeddings, pattern
analysis and evaluation, never required for chat or orchestration and never a global
Python dependency (blueprint §1–§2, §5; PRD §4.1, §14.2). The repository has no Python
runtime (only Blender asset scripts in `tooling/`). The first concrete need is the skill
scanner in W3: the scanner the PRD names appears to be a Python 3.12+ project, which is
**unverified** ([ADR 0023](0023-skill-scanner-adapter-pinning.md)). Gap-map decision 7
asks: embedded runtime or `uv`-managed on first use.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| A. Embedded Python shipped in the app | Works offline; version fixed at release | Larger installers on every OS even for users who never import skills; many extra files to sign/notarize on macOS; security updates require an app release |
| **B. `uv`-managed on first use** | Nothing shipped until needed; `uv.lock` with hashes and an exact Python version give reproducible environments; installed per user under `<data>/workers/` | Needs network and explicit consent at first use; downloads executable code (must be pinned and hash-verified); `uv` itself must be pinned |
| C. System Python | No download | Version drift; blueprint forbids requiring a global Python. Rejected |
| D. Containers | Strong isolation | Not always available on desktops; heavy. Optional later sandbox backend only |

## Decision

1. **Option A, built reproducibly.** The release ships a pinned, relocatable CPython build
   (exact version and checksum) with a pre-built worker environment inside the Desktop
   `extraResources` for each OS/architecture. `uv` and `workers/intelligence/uv.lock`
   (hashes) are **build-time** tools in CI that produce that environment; nothing is
   downloaded on the user's machine. Every native file is signed/notarized with the app on
   macOS. Security fixes in Python or a locked package ship as an app update.
   Large optional assets that are not needed for core features (for example local embedding
   models in W5/W6) may be an opt-in pack; anything a feature needs to work is bundled.
2. **Never required for chat or orchestration.** Missing or broken worker means: chat,
   missions, observers work; skill inspection reports `scanner-unavailable` and packages stay
   quarantined (fail closed, ADR 0023).
3. **Owner of the process:** the Rust daemon starts, supervises and stops workers; worker
   output is data. Workers never write approvals or activation state.
4. **Protocol v1:** NDJSON over stdio, one JSON object per line, bounded line length; startup
   handshake (`schema_version`, worker version, operations); requests carry `request_id`,
   `operation`, `deadline_ms`, `schema_version`, `payload`; responses carry `result` or
   `error` (code + safe message); cancellation request then kill after a grace period; exit
   code recorded; stderr is logs only, bounded and redacted; schemas live in
   `@extalia/protocol` like the daemon contract. Large inputs are passed as paths inside a
   per-job staging directory, never arbitrary paths; operations are a fixed allow-list, never
   model-supplied commands.
5. **Resource limits and sandbox:** per-job time, memory and output limits; one worker per
   operation class with a concurrency cap; environment allow-list (no provider credentials);
   network off unless the operation and the user allow it. OS mechanisms (POSIX rlimits,
   Windows Job Objects, macOS sandboxing) are chosen and tested per OS in W3; where a limit
   cannot be enforced for an operation that needs it, the operation fails closed.
6. Started on demand, stopped when idle (no always-on Python; AC-27).

## Consequences

- Installers grow by the Python runtime plus worker packages (size measured and published in
  the packaging PR); in exchange skill inspection works offline right after install.
- Release CI builds and signs one worker bundle per OS/architecture.
- Supply-chain review of `uv`, the Python build and every locked package becomes part of the
  release checklist (SBOM).
- `pnpm check` gains `ruff` and `pytest` only when `workers/intelligence/` exists.

## Open questions for the owner

1. Which optional assets (if any, e.g. embedding models) may stay an opt-in pack because of size.
2. Per-OS sandbox expectations for the scanner (static analysis of untrusted files) vs future
   evaluation workers that execute code (W6, likely stricter or disabled where unenforceable).
