# ADR 0044: Relocated developer CPython bundle and supervised health probe

Status: Verified locally in v0.4.144 as an opt-in developer experiment, 2026-10-30.
Tracking: [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).
Extends ADRs [0022](0022-python-worker-distribution.md),
[0042](0042-owned-health-probe-supervision.md) and
[0043](0043-worker-bundle-artifact-observation.md).

## Build source and scope

Record five exact CPython 3.13.18/20261026 `install_only_stripped` source
candidates from the [official release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)
and its [API asset records](https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20261026).
`tooling/python-bundle/runtime-pins.json` binds target, URL, archive bytes and
SHA-256. The macOS ARM64 archive's bytes were downloaded and independently hashed
locally. Other entries are metadata-only candidates. No signature verification
or complete dependency/license/SBOM certification is implied.

Add explicit developer tooling, not an end-user downloader or production Python
package. Ordinary tests never download or need Python. Existing application
routes, scanner availability, grants and activation stay unchanged. This does
not create `workers/intelligence/`; its production dependency/ruff/pytest gate
remains open. Build/test fixtures remain excluded from release staging.

## Bounded archive materialization

Stream an explicitly requested download into an exclusively opened owned file,
with a network deadline and exact size/hash checks. Offline input uses the same
pin. Before decompression, hash the entire bounded archive through a fixed
buffer. A narrow streaming USTAR parser admits only regular files, directories
and internal file links; PAX/GNU, sparse, devices and FIFOs are refused. It
validates checksums, numeric sizes/modes, zero padding, two terminating zero
blocks and all trailing bytes. Fixed buffers and backpressure avoid retaining
complete uncompressed archives or entries.

Complete preflight and archive-graph validation precede payload writes. Reject
traversal, duplicate/case/prefix conflicts, links as ancestors, missing/escaping
targets, cycles, excessive chains and directory links. A second complete pinned
parse writes exclusively created regular files; aliases copy their known target
bytes. All source entries/headers are counted, including empty directories and
unsupported metadata. Source empty directories are not materialized unless
implied by a retained file. No source regular files or license notices are pruned.
Only normalized executable/read bits are retained, not ownership, special bits
or timestamps.

Caps: 64 MiB compressed archive, 512 MiB decompressed data, 16,384 headers,
8,192 source entries, 4,096 final files/directories, 8,192 final entries,
128 MiB/file and 512 MiB after link expansion. Recheck final directories/bytes
after adding the two fixed worker scripts, then enforce the 1 MiB manifest cap.

The measured archive has 90 license-path entries deeper than eight components,
with maximum depth eleven. To retain them, widen the unreleased manifest's
portable path limit from eight to sixteen components in TS/Rust/schema, keeping
512-character paths, component bounds and every other cap. Shared fixtures test
sixteen accepted/seventeen refused. This supersedes ADR 0043's depth-eight
implementation detail; older validators still fail closed on new deeper paths.

## Relocation and explicit native probe

Stage in a newly owned private temporary directory, then move the completed
payload to a different reserved parent. The original payload path is gone before
probing. Preserve the exact manifest pin and source record outside the payload.
Cleanup attempts both owned roots and propagates errors other than absence;
failure never overwrites a preexisting output directory.

The `test-fixtures`-gated `extalia-python-bundle-probe` requires explicit trusted
developer arguments. It bounds and opens the manifest as a no-follow/nonblocking
regular file on Unix, invokes the existing observer, checks exact interpreter,
script and version claims, then constructs fixed `-I -S -B` arguments. The fixed
entry script checks the actual CPython version before the stdlib reference
health exchange. The Rust supervisor clears the environment and owns deadlines,
cancellation, bounded pipes and successful direct-child reaping.

This harness accepts a digest from the operator's own reviewed staging run.
Matching an arbitrary external manifest/hash pair is not execution authority or
a binding to the source catalog. It is disconnected from the daemon API and
runtime; there is no general verified-bundle-to-production-launch conversion.
`launch_eligible` and physical settlement stay false. Trusted, quiescent root and
ancestor namespaces remain prerequisites; read-only files and relocation do not
establish immutable installation, launch-time binding or sandboxing.

## Verification and remaining work

Synthetic tests cover archive containment, unsupported formats, graph conflicts,
checksums, truncation, decompression/header/entry/file/alias limits, nonregular
archive input, empty directories, output ownership and offline-default behavior.
Rust subprocess regressions cover explicit opt-in and manifest refusal before
launch. A separately run native experiment stages the exact downloaded macOS
ARM64 candidate, relocates it, observes all final bytes and returns `Healthy`
with exit zero and no stderr. Its 1,659 files occupy 99,982,909 bytes; every
archive regular file/alias is retained. This is a fixed stdlib health result,
not certification of all native extensions or a scanner.

Remaining: cross-platform actual bundle/extension testing, Windows observation,
reviewed licenses/SBOM and signatures, build-time locked worker dependencies,
immutable installation and actual launch binding, process-tree containment,
OS filesystem/network/memory/resource sandboxing, scanner report/attestation
integration and installer composition. Keep V2-16 open and production scanner
unavailable. Developer reproduction commands are in
[the staging guide](../../tooling/python-bundle/README.md).
