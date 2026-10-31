# Developer-only CPython bundle staging

This is an opt-in build experiment for ADR 0044, not an installer or a scanner.
It never runs during application startup or ordinary tests. System Python is
not used. Five exact source candidates are recorded in `runtime-pins.json`;
only macOS ARM64 has been staged and probed locally. The other entries are
source metadata, not platform support claims. Windows observation remains
unsupported by ADR 0043.

The official 20261026 release supplies CPython 3.13.18 `install_only_stripped`
archives. The source catalog records exact URLs, byte sizes and SHA-256 digests
from the official Releases API. These are development candidates; release
signatures, complete license/SBOM review and production approval remain open.
The native archive's downloaded bytes were independently hashed locally.

To stage an explicitly downloaded candidate into a previously absent directory:

```sh
node tooling/python-bundle/build.mjs --target macos-aarch64 --download --out "$PWD/output/python-candidate"
```

For offline/repeated builds, replace `--download` with
`--archive /absolute/path/to/the-pinned-archive.tar.gz`. Both variants verify
exact archive size and SHA-256 before decompressing. No download occurs unless
`--download` is explicitly selected. Existing output is never overwritten.

The strict streaming reader supports the measured USTAR format only. It refuses
PAX/GNU/sparse/device/FIFO forms, malformed checksums/padding, traversal, duplicate
or case-conflicting paths and escaping/missing/cyclic/directory link targets.
File link targets are materialized as regular copies; no filesystem links are
created. Ownership, timestamps and special mode bits are not restored. Empty
source directories are validated/count-limited but not created unless implied
by a retained file. Every regular source file and license notice is retained.

Two full hash-checked passes precede completed staging. Limits cover compressed
and decompressed bytes, headers, source entries, paths, alias expansion and the
final ADR 0043 manifest, including the fixed health scripts. Paths allow sixteen
components after measuring license paths at depth eleven; 512-character path,
4,096-file/directory, 128-MiB-file, 512-MiB-payload and 1-MiB-manifest limits stay.
The payload is moved to a new parent, and its original path is removed before
any probe. Failure attempts cleanup of both newly owned directories.

Build the feature-gated developer probe (it is excluded from release staging):

```sh
cargo build -p extalia-daemon --locked --features test-fixtures --bin extalia-python-bundle-probe
target/debug/extalia-python-bundle-probe --trusted-development-probe "$PWD/output/python-candidate/payload" "$PWD/output/python-candidate/bundle-manifest.json" '<manifest_sha256 from source-record.json>'
```

On Windows the executable has `.exe`; the current observer intentionally refuses
that platform. Obtain the digest from your own reviewed staging run. An arbitrary
external manifest/hash pair is never executable authority. The explicit trusted
harness observes the bundle, checks fixed paths/version claims, and runs only
`-I -S -B worker/probe.py` under the Rust owner. The script verifies the actual
CPython version before the existing stdlib health fixture. Accept only a healthy
response and successful direct-child reaping; both `launch_eligible` and
`physical_settlement_verified` remain false.

All paths and their ancestor namespaces must be trusted and quiescent. Read-only
permissions, content observation and relocation are not immutable installation,
atomic launch binding, OS sandboxing or descendant containment. No app route,
production resource copy, scanner capability or activation behavior is enabled.
