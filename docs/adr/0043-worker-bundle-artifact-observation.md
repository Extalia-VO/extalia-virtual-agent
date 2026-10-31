# ADR 0043: Pinned worker bundle inventory and content observation

Status: Verified locally in v0.4.143 for contract and filesystem observation, 2026-10-30.
Tracking: [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).
Prerequisite for [ADR 0022](0022-python-worker-distribution.md); extends
[ADR 0042](0042-owned-health-probe-supervision.md) without enabling a launcher.

## Manifest and independent pin

Add `worker-bundle-manifest.schema.json` with TypeScript/Rust validation and a
shared corpus. Schema version 1 declares a target OS/architecture, bounded
runtime/worker version claims, exactly `health`, interpreter and entry-script
relative paths, and a sorted file inventory. Each file has a fixed role, size
and lowercase SHA-256. Exactly one interpreter and one entry script must match
their references and be nonempty. Support files may be empty. No arguments,
environment, commands, scanner capability or download endpoint can be supplied.

Paths have at most eight components of 64 ASCII characters and 512 characters
total. Dot/dot-dot, separators other than slash, drive/UNC forms, trailing dots,
device names (including extensions), case-folded file collisions, incompatible
ancestor-directory spelling and file/directory prefix collisions are refused.
Leading-dot filenames other than dot/dot-dot remain permitted. Inventories are
strictly sorted by ASCII path, never silently normalized or deduplicated.

Raw manifest input is capped at 1 MiB before hashing/parsing; inventory size at
4,096 files, each at most 128 MiB and 512 MiB total. Structural JSON Schema does
not prove ordering, cross-field references, aggregate size or source integrity;
its validator-only annotations and fixture `schemaGap` entries identify those
checks explicitly. TypeScript accepts decoded JSON claims. Rust's raw struct
decoder additionally rejects duplicate members, including escaped key aliases.
JSON integers retain semantic numeric spellings such as `1e0`.

The observer requires an expected SHA-256 as a separate caller argument. It
hashes the exact bounded manifest bytes before decoding; no reserialization or
canonicalization changes the pinned object. Caller composition must establish
that pin's trusted provenance; supplying a digest does not prove its source.
The manifest is outside the payload root, avoiding a self-referential inventory.
No release pins or actual CPython/scanner artifacts are introduced here.

## Read-only observations and platform boundary

`extalia_daemon::worker_bundle::observe_bundle` returns counts, bytes, the
manifest digest and version/target claims. It returns no executable paths,
command configuration or approval; `launch_eligible()` is always false. There
is no conversion to `ProbeConfig`, RPC, host/UI route or runtime consumer.
Unknown/mismatched data has coarse fixed refusal codes, without raw paths,
file contents, parser errors or OS diagnostics.

Use exact-pinned `sha2` 0.11.1 for streaming SHA-256, rather than the core's
whole-buffer record-identity implementation. Unix access uses exact-pinned
`rustix` 1.1.6. Open the supplied absolute root as a directory without following
a final symlink. The caller owns its ancestor namespace; ancestor path resolution
is an OS operation, not a sandbox boundary.

Children are accessed relative to pinned directory descriptors, one component
at a time. Check no-follow metadata, reject non-file/directory entries, then
open with `NOFOLLOW`, `NONBLOCK`, `NOCTTY` and `CLOEXEC`; directories also require
`DIRECTORY`. Compare opened device/inode/mode/link count/size to the named entry.
Regular files must have one hard link. Hash through a fixed 64 KiB buffer,
detect early EOF or extra bytes, and check handle and named-entry metadata again.
Exact inventory checks reject missing/extra files and unlisted empty directories.
At most 4,096 derived directories and 8,192 total entries may be observed.
A second descriptor-relative enumeration compares identities and metadata,
including change/modify timestamps, and the root pathname is checked again.

These are observations over **trusted, quiescent staging trees**. They detect
ordinary mutations; they are not an atomic snapshot or hostile-filesystem
containment. A device swapped between metadata and open can be opened before
identity rejection, although its content is not read; `NOCTTY` prevents acquiring
a controlling terminal. Concurrent hostile namespace writers are outside the
side-effect-free trust boundary. Filesystem syscalls are not hard time bounded.
No success may be reused as launch-time or immutable-installation evidence.

Non-Unix observation returns `UnsupportedPlatform`, without pretending that
length comparisons prove Windows identity or that reparse points/hardlinks were
checked. Pure manifest validation supports all declared target labels; actual
Windows handle/reparse verification remains open. Target mismatch is refused
before touching the payload tree.

## Verification and remaining gates

117 structured fixtures compare TS, generated schema and Rust verdicts, with
explicit structural-schema gaps. Eight local Rust tests cover pin/byte limits,
raw duplicates and numeric forms, native target checks, exact inventory, content
tampering, size/missing/extra entries, symlinks/hardlinks/socket entries and
deterministic mutation between passes. A Linux-only FIFO regression and a
non-Unix unsupported-observer regression run on their respective CI platforms;
they are not claimed as local platform certification. Fixtures use owned
temporary directories and synthetic bytes, not a real Python installation.

The [RustCrypto digest API](https://docs.rs/sha2/0.11.1/sha2/),
[descriptor-relative opens](https://docs.rs/rustix/1.1.6/rustix/fs/fn.openat.html)
and [directory iteration](https://docs.rs/rustix/1.1.6/rustix/fs/struct.Dir.html)
provide the primitives; their use does not establish artifact authenticity.

Remaining: reviewed CPython/dependency source pins, licenses/SBOM, materialized
relocatable bundles, signatures, executable/ABI/runtime probes, immutable
installation and launch-time binding, Windows checks, process-tree containment,
OS sandbox/resource/network enforcement, scanner report and attestation binding,
and packaged platform certification. The proposed eventual Python recipe is
fixed `-I -S -B <entry-script>`, not manifest-supplied arguments. Synthetic bytes
passing these checks prove neither a working Python runtime nor permission to run.
