# ADR 0023: Skill scanner adapter pinning

Status: Accepted (2026-10-21; the owner accepted the recommended option). The scanner pin itself stays open until its source, licence, version and OS support are verified.

Current host ingress enforcement is tightened in [ADR 0049](0049-mandatory-external-skill-ingress.md):
legacy consent cannot bypass scanning; external catalogs and reads require fresh
registry verification. This does not make the production scanner available.

## Context

FR-16 makes inspection by the scanner the PRD names (NVIDIA SkillSpector) mandatory before
any imported, generated or modified skill becomes active, and requires confirming its CLI
and report format against a pinned upstream version; the blueprint (§7, §13) forbids
assuming flags or a JSON schema. Today skills load unscanned (`packages/host/src/skills.ts`;
gap map FR-16, W0 containment in progress separately).

**What could be checked on 2026-10-21 (web search and summarising page fetches; nothing was
installed or run, so every item below is UNVERIFIED):**

| Item | Public information found | Status |
| --- | --- | --- |
| Existence/source | NVIDIA documentation page "Scanning agent skills" ([docs.nvidia.com/skills/scanning-agent-skills](https://docs.nvidia.com/skills/scanning-agent-skills)) points to a repository [github.com/NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector); third-party coverage exists ([Help Net Security, 2026-08-03](https://www.helpnetsecurity.com/2026/08/03/skillspector-open-source-agent-skill-security-scanner/)) | UNVERIFIED (not cloned) |
| Licence | Repository page reportedly shows Apache-2.0 | UNVERIFIED |
| Version/releases | No tagged releases were visible on the repository page | UNVERIFIED; pinning by tag may be impossible |
| Runtime | Python, reportedly 3.12+; install from source into a virtual environment | UNVERIFIED |
| CLI and output | Documentation describes a scan command with terminal, JSON, Markdown and SARIF output and documented exit codes; the JSON per-finding shape is said to be defined by source code rather than a schema file | UNVERIFIED; **no flag or field is adopted by this ADR** |
| Network/LLM | Static analysis by default; an optional LLM pass needs a provider key; dependency lookups may use the network with an offline fallback | UNVERIFIED |
| macOS/Windows/Linux support | No explicit support matrix found; a Docker image is mentioned | UNVERIFIED |

The owner must confirm all of the above from the official source before W3 depends on it.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| **Pinned adapter behind a `SkillInspector` port, fail closed** | Matches FR-16 and blueprint §7; scanner replaceable; absent scanner is safe | Skill import is blocked until the scanner is installed and verified |
| Call whatever version is on `PATH` | Simple | Unreproducible; flags/output may change silently. Rejected |
| Vendor the scanner source into this repository | Full control | Licence and maintenance burden; still needs Python. Not now |
| Proceed without a scanner (manual review only) | Unblocks W3 | Violates FR-16/AC-16/AC-26. Rejected; break-glass stays disabled by default |

## Recommended decision

1. **Port first.** `SkillInspector` in `extalia-core`; the scanner adapter runs inside the
   Python worker (ADR 0022) under the daemon. Until a verified pin exists, the only adapter
   returns `scanner-unavailable` and every non-built-in package stays `QUARANTINED`.
2. **Pin** an exact upstream commit (or release, if one appears) plus the hash of the
   installed artifacts in `workers/intelligence/uv.lock`; record the scanner's self-reported
   version **and** the pin in every attestation, with policy version, SHA-256 of the
   immutable package tree, coverage, exit status and redacted report reference.
3. **Contract from evidence:** the integration PR runs the pinned version against committed
   fixture skills (benign, malicious, malformed, oversize), captures its actual arguments and
   output, and derives an Extalia-owned report schema from them. Required fields must be
   present; unknown fields are tolerated but recorded; the normalizer maps to Extalia
   verdicts. Arguments are fixed constants from that evidence; no model or user input
   reaches the command line.
4. **Fail closed** on: scanner absent, pin/hash mismatch, timeout, non-success exit code
   meaning "error", unparseable or schema-invalid output, incomplete coverage, package hash
   changed during the scan (hash before, after, and before activation), changed scanner pin or
   policy version (attestations invalidated, rescan). High/critical → `BLOCKED`; medium →
   `REVIEW_REQUIRED`; low → policy decides. A clean scan is necessary, never sufficient.
5. **Isolation:** no credentials, no LLM pass, no network by default (dependency lookups
   offline; if that reduces coverage it is recorded as incomplete, not clean); resource limits
   per ADR 0022.
6. **When absent:** chat and missions are unaffected; built-in skills shipped with the app
   remain available (owner to confirm); user, workspace, generated and imported skills stay
   quarantined with a visible reason.

## Consequences

- W3 cannot activate any non-built-in skill until the owner confirms the scanner facts and
  the pin PR lands.
- Scanner upgrades are deliberate PRs with refreshed fixtures and mass rescans.

## Open questions for the owner

The [2026-10-30 source audit](../architecture/skill-scanner-evidence.md) records
an observed official release/tag identity and tagged runtime/network declarations.
It does not verify an installed artifact, report contract, isolation or platform
support, and does not close the pin or activate a scanner.

1. Confirm the official source, licence compatibility, version to pin, and supported OSes
   (especially macOS and Windows).
2. Are built-in skills exempt (shipped and reviewed with the release), or scanned at build
   time with the attestation shipped?
3. Is the optional LLM pass ever allowed, and with which key, given "no secrets in prompts"?
4. Fallback if the scanner is not usable on an OS: block skill import there (proposal) or
   accept a different pinned inspector?
