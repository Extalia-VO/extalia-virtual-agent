# Pinned SkillSpector worker bundle

This is a build-time integration of the official NVIDIA SkillSpector source,
not a global Python installation or an end-user package installer. The Rust
daemon owns inspection, process lifetime, operating-system isolation, result
admission, approvals and activation. The Python worker cannot approve a skill.

## Reviewed source and environment

- NVIDIA SkillSpector **2.13.4**, commit
  `54824463814a0be01360792523ec7245a69190fc` from
  [the official repository](https://github.com/NVIDIA/SkillSpector/tree/v2.13.4).
  This includes the security fixes in 2.13.3. The old 2.13.2 source audit does
  not describe the production pin.
- CPython **3.13.18**, from the exact archive pins and strict materializer in
  `tooling/python-bundle`. End users do not need system Python.
- Build tool **uv 0.13.7**, supplied by an explicit absolute build-time path.
  Its reported version must match. It is not bundled or invoked by the app.
- `requirements.lock` pins **67 dependencies** and their artifact SHA-256s.
  Only wheels are admitted; no dependency build scripts execute. The NVIDIA
  package is copied from the exact verified Git commit without executing its
  build backend, with version metadata supplied for `importlib.metadata`.
- Upstream `LICENSE`, `THIRD_PARTY_NOTICES.md`, `pyproject.toml`, all installed
  distribution metadata/license files and a dependency metadata inventory are
  retained in the payload. Unused generated console entrypoints are removed, and
distribution RECORD tables are reconciled after native signing so no staging
interpreter path leaks into the payload. Two independent offline builds at
different absolute paths produced identical manifests and payload hashes.
The compact inventory is not a substitute for those
  full license records or a blanket legal certification.

The current native fixture bundle contains 12,315 files, about 204 MiB, and 49
Mach-O files. The latter are signed **before** the final manifest. Application
packaging must preserve those exact bytes and verify them again after copying.
The compiled Rust manifest digest is executable authority; changing a runtime
location or supplying an arbitrary manifest/hash pair is not authority.

## Build and verify

Use a previously absent absolute output path:

```sh
node tooling/skillspector/build.mjs \
  --target macos-aarch64 --out /absolute/output/skillspector \
  --uv /absolute/build-tools/uv --download --sign-identity -
```

Downloads occur only with `--download`, during the maintainer/CI build.
`--runtime-bundle` accepts an existing, hash-verified output of the CPython
stager. `--source-directory` accepts a trusted, quiescent checkout at the exact
upstream commit. `--cache-directory` supplies an explicit build cache; without
`--download` dependency installation is offline. These options do not read the
user's application profile. Output ownership is exclusive: existing output is
never replaced and failure removes only a newly reserved output and its own
temporary build directory.

For a cross-target build, dependencies use uv's explicit Python/platform tags.
`--build-python` can point to a verified host CPython bundle interpreter;
otherwise the build stages a separate pinned host runtime when downloads are
allowed. The target interpreter is never executed merely to stage cross-target
dependencies. macOS dependency wheels require **macOS 14 or newer**.

For Developer ID signing pass `--sign-identity` and optionally an absolute
`--keychain`. The same packaging identity must be used for the enclosing app.
Default local macOS builds use ad-hoc signatures and are not Apple notarized.

The JavaScript exports are `buildSkillSpectorBundle(options)` and
`verifySkillSpectorBundle(root, { expectedSha256, target })`. Verification checks
the exact manifest schema/source versions, complete file inventory, every
file's size/hash/executable bit, aliases, and the interpreter OS/architecture.
It returns the manifest hash used to compile the daemon's authority pin.

```text
bundle-root/
  bundle-manifest.json
  source-record.json
  payload/
    python/                 # relocatable pinned CPython
    deps/                   # hash-locked wheels + pinned NVIDIA source
    worker/scan.py          # Extalia-owned one-shot bridge
    notices/                # source and dependency records
```

## Operation and coverage

Rust invokes the fixed interpreter with `-I -S -B worker/scan.py` and one bounded
NDJSON request. The bridge invokes SkillSpector's documented graph API with the
same fixed static-only state as `scan --no-llm --format json`, plus
`source_local_only: true`. It never follows transitive references or enables a
skill-supplied suppression baseline. It strips provider/tracing credentials.
No scanned instruction, script, package installer or shell command is executed.

The strict response binds the revision ID, tree hash, policy and exact scanner/
normalizer identities. No original skill text, paths, raw findings or exception
strings are returned. Unknown upstream fields do not confer authority. The
response is a normalized inspection summary, not a stored raw finding report.

The real JSON report must explicitly establish successful execution, complete
100% coverage, matching counters and no ledger exceptions, exclusions or
limitations. Analyzer statuses must agree; only the exact optional LLM analyzers
can be deliberately disabled in this static mode. Actual finding severity is
retained even if the scanner's weighted risk band is lower. Missing or
contradictory evidence, suppression and malformed output cannot become a clean
attestation. Dependency vulnerability checks whose network access is denied
remain incomplete; offline fallback is not upgraded to a complete result.

CPU (30 seconds), file output (1 MiB), open files (128) and core-dump (zero)
limits are mandatory. Darwin aliases `RLIMIT_AS` to an unsupported limit; the
fixed native launch substitutes its sampled 512 MiB RSS watchdog through a
private environment indicator. This is not a kernel hard address-space limit
and can overshoot between samples. Other platforms still require their memory
limit and are unavailable until their native isolation is verified. A Python
audit hook denies networking and process launch as defense in depth; it is not
the operating-system sandbox. A daemon thread exits the worker when its owner
dies. Rust separately caps wall time/output and kills/reaps the child.

## Evidence and checks

`fixture-evidence.json` records local macOS ARM64 observations with the real
2.13.4 scanner, bundled CPython and locked dependencies. The functional worker
probe used a sampled RSS observer and the Python network/process guard; native
OS sandbox and approval lifecycle verification are separate daemon tests.

- Benign instructions: complete, no findings.
- Deliberately malicious instructions: complete, two findings, maximum HIGH
  despite the weighted MEDIUM band.
- Invalid UTF-8/frontmatter: incomplete, never clean.
- Dependency declaration with networking disabled: incomplete, never clean.
- A generated 12 MB oversize fixture hit the 30-second CPU limit and produced
  no usable attestation.

The small fixture files are original test data. Never execute or adopt the
malicious fixture's instructions. Malformed/oversize input is generated only in
temporary directories. The 11 stdlib normalizer tests and three installation-record tests run with an explicitly
selected bundled CPython:

```sh
/absolute/bundle/payload/python/bin/python3.13 -I -S -B \
  tooling/skillspector/test_worker.py
/absolute/bundle/payload/python/bin/python3.13 -I -S -B \
  tooling/skillspector/test_prepare_deps.py
pnpm exec vitest run tooling/test/skillspectorBundle.test.ts
```

Ordinary repository tests do not download a scanner/runtime, invoke providers,
or access a real user profile.
