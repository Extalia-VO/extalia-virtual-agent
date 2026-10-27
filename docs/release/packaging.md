# Packaging the daemon (self-contained installers)

Owner decision 9 ([gap map §4](../product/prd-v1.1-gap-map.md)): whoever installs Extalia
needs nothing else. Extalia Desktop bundles Node (Electron) and the Rust daemon
([ADR 0021](../adr/0021-rust-integration-strategy.md)); the CLI brings the daemon through
per-platform npm packages. Only contributors install Rust, Python or Node.

## Release targets

| Rust target | Node `platform-arch` | Desktop | CLI package | Release runner |
| --- | --- | --- | --- | --- |
| `aarch64-apple-darwin` | `darwin-arm64` | macOS arm64 | `@extalia/daemon-darwin-arm64` | `macos-latest` |
| `x86_64-apple-darwin` | `darwin-x64` | macOS x64 | `@extalia/daemon-darwin-x64` | `macos-latest` (cross) |
| `x86_64-pc-windows-msvc` | `win32-x64` | Windows x64 | `@extalia/daemon-win32-x64` | `windows-latest` |
| `x86_64-unknown-linux-gnu` | `linux-x64` | Linux x64 | `@extalia/daemon-linux-x64` | `ubuntu-22.04` |
| `aarch64-unknown-linux-gnu` | `linux-arm64` | — | `@extalia/daemon-linux-arm64` | `ubuntu-22.04-arm` |

The list lives in `tooling/daemon.mjs` (`DAEMON_TARGETS`). Linux binaries are linked on
Ubuntu 22.04: **glibc 2.35 is the floor**, and the release job fails if a binary needs a
newer symbol version. Their npm packages declare `libc: ["glibc"]`, so musl systems skip them.

## Artifact layout

- **Build:** `node tooling/build-daemon.mjs [--target <triple>] [--desktop-targets] [--out <dir>]`
  runs `cargo build --release --locked -p extalia-daemon --target <triple>` with symbols
  stripped, checks the executable's OS and architecture, ad-hoc signs a macOS binary that has
  no valid signature, prints size and SHA-256 and, for this machine's target, requires a
  `hello` answer with the lockstep version. `--from <file>` stages a prebuilt binary instead
  (release CI, no Rust needed).
- **Desktop:** staged at `apps/desktop/build-resources/daemon/<os>-<arch>/` (git-ignored;
  `<os>` is electron-builder's `mac`/`win`/`linux`). `extraResources` copies
  `build-resources/daemon/${os}-${arch}` to `daemon/`, so the packaged app has
  `<process.resourcesPath>/daemon/extalia-daemon` (`.exe` on Windows). electron-builder packs
  each macOS arch separately, so each pack picks its own binary; a universal build would lipo
  the two. `pnpm dist:dir` builds the host target, `pnpm dist` every arch the OS packages.
- **Missing binary:** electron-builder skips a missing source with a warning and the app still
  starts (the daemon flag is off by default and a missing binary is ignored). The `afterPack`
  hook (`apps/desktop/scripts/after-pack.mjs`) checks the packaged binary's OS/arch and, with
  `EXTALIA_REQUIRE_DAEMON=1` (release and CI), fails the build when it is missing or wrong.
- **CLI:** `node apps/cli/npm/generate.mjs --binaries <dir> [--cli]` turns
  `<dir>/<platform>-<arch>/extalia-daemon[.exe]` into five packages
  `@extalia/daemon-<platform>-<arch>` (`os`/`cpu`, `bin/extalia-daemon`, `index.js` exporting
  the absolute binary path; templates in `apps/cli/npm/platform/`). `--cli` also writes a
  publish-ready `extalia-vo/` that lists all five as `optionalDependencies` at the lockstep
  version. Versions come from the root `package.json`; `check-versions`/`bump-version` keep any
  manifest that pins `@extalia/daemon-*` in lockstep.
- **Development:** `<repo>/target/{debug,release}/extalia-daemon`, or `EXTALIA_DAEMON_PATH`.
- **Python worker (W3, [ADR 0022](../adr/0022-python-worker-distribution.md)):** joins the same
  way, staged at `build-resources/python/<os>-<arch>/` and copied to `<resources>/python/`.

The published CLI lists its matching platform packages; the contributor manifest does not
need them because workspace development resolves a local daemon. The `extalia-vo` package
and all five `@extalia/daemon-*` packages were first published at v0.4.109. Users install
`npm install -g extalia-vo@latest`, rather than a daemon alone. Contributors keep using
`pnpm install`: npm's resolver can fail on the pnpm-linked tree when a local npm install
is run inside the checkout. An isolated global-prefix install of the public v0.4.109
package passes on Node 26.12.0 with npm 12.2.1, including CLI, daemon and Web startup.

## macOS release modes

`mac.hardenedRuntime: true`. electron-builder's signer walks the whole bundle, including
`Contents/Resources/daemon/`, so the daemon is signed with the app's Developer ID identity,
hardened runtime and the inherited entitlements, and notarized with the app; `mac.binaries` is
not needed. `EXTALIA_MAC_RELEASE_MODE` accepts `preview` (the free beta default)
or `notarized`. Set the same-named GitHub repository variable to choose the
release mode; unknown values fail before packaging.

**Preview:** no Apple Developer subscription or certificate is used. The packager
explicitly ad-hoc signs the complete app (`mac.identity=-`), disables notarization
and records `extaliaMacReleaseMode=preview` in its packaged manifest. Both
architectures' DMG and ZIP apps must have a valid ad-hoc signature and pass
`codesign --verify --deep --strict`. This does not identify a developer or grant
Apple trust. The release includes a preview notice, excludes the macOS automatic
update feed and block maps, and refuses to replace a draft that already has a
signed macOS update feed. Preview apps update by manually downloading a new build.

A user who trusts the official download may need to approve opening it through
**System Settings → Privacy & Security → Open Anyway** after the first launch
attempt. See [Apple's instructions](https://support.apple.com/en-gb/102445).
No build or installer changes Gatekeeper settings or removes quarantine metadata.

**Notarized:** requires `MAC_CSC_LINK` (a Developer ID Application
certificate with its private key, exported as base64 `.p12`), `MAC_CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Configure these through
GitHub's repository secrets; never put them in files tracked by Git. The release gate
requires Developer ID signing and notarization in this mode, and rejects missing
credentials before packaging. Each app must also pass Gatekeeper and have a
stapled notarization ticket. On Windows electron-builder signs every `.exe` that `extraResources`
copies, so `daemon\extalia-daemon.exe` is signed with the app when `WIN_CSC_LINK` is set. Linux
ships the plain binary.

The macOS v0.4.109 arm64 DMG was inspected read-only after a tester reported a damaged or
unverified app warning: its embedded app has `Signature=adhoc`, no team identifier,
fails `codesign --verify --deep --strict` and Gatekeeper assessment, and has no stapled
notarization ticket. The unpacked-app runtime smoke did not detect this distribution
failure. The replacement preview repairs app integrity but still has an unidentified
developer. Removing that warning requires a Developer ID signed and notarized build.

## Shared public scene assets

`apps/web/public-assets/models.json` registers 16 project-authored scene models
with hashes, sizes, MIT license and provenance, plus 12 retained Blender avatar
exports under their separate RenderHub Extended Use License. Two physical body
files serve the four existing appearance variants; ten detailed hair exports
retain the original fallback. Default Web, Desktop and CLI builds use this same
28-model inventory, including on a clean checkout. Unregistered avatar files do
not enter the default Vite graph even when installed on the build machine; only
an explicit development server with `--mode local-assets` may load them. Its output
is not a production packaging mode.

`tooling/public-models.mjs` validates sources and output content, and CLI/Desktop
packaging validates the copied UI again. The built UI carries `models.json` and
`OFFICE_ASSETS_LICENSE.md`, `AVATAR_SOURCE_LICENSE.md` and third-party notices;
every registered model must be present, with no unknown,
modified or inlined models. See the [public inventory](../../apps/web/public-assets/README.md).

## Release workflow

`.github/workflows/release.yml`: the `daemon` matrix builds the five targets and uploads
`daemon-<triple>` artifacts. The Desktop `build` jobs download them, stage their OS's arches
with `build-daemon.mjs --from`, package with `EXTALIA_REQUIRE_DAEMON=1` and run the packaged
smoke before uploading release assets. The macOS release gate also verifies both
architectures' distributed DMGs and ZIP app bundles: correct executable architecture
and strict deep signature verification in both modes, plus Developer ID/team,
Gatekeeper and stapled-ticket validation in notarized mode. A failed check or smoke
prevents that job from uploading installers or update metadata to the draft.

`npm-packages` generates the six npm folders, runs the CLI clean-machine smoke and
uploads the packed tarballs as a workflow artifact. This workflow does not automatically
publish to npm. For a manual release, inspect that artifact, remove the staged CLI
manifest's `private` flag, publish the five platform packages before `extalia-vo`, and
verify their registry hashes and an isolated install. npm can expose a temporary
`0.0.0-stage` holding version while reviewing a new package; verify that the intended
version is available before announcing it.

## Clean-machine gate

Both smokes run their subjects in an environment built by `cleanMachineEnv()`
(`tooling/daemon.mjs`): `PATH` is an empty temporary folder (plus the Windows system folders),
`HOME` is a fresh folder (hiding `~/.cargo`, `~/.rustup` and user Python installs), and only
display/temp variables survive. The scripts first assert that none of `cargo`, `rustc`,
`rustup`, `python`, `python3`, `pip`, `uv`, `node`, `npm`, `npx`, `pnpm` resolves.

- **Desktop** (`pnpm --filter @extalia/desktop smoke:packaged`, after `dist:dir`): the packaged
  daemon answers `hello` with the app's version (temporary `--data-dir`), and the packaged app
  passes `--smoke-test` with the daemon present and again with the `daemon/` folder moved away.
- **CLI** (`node tooling/clean-machine-smoke.mjs --npm <dir>`): packs `extalia-vo` and this
  machine's platform package, installs them with `npm install -g` into a temporary prefix, runs
  `extalia version` and `extalia doctor` (Node by absolute path; the installed launcher with
  Node as the only command on `PATH`), resolves the platform package from the installed CLI
  and requires its daemon to answer `hello`.

Enforcement: CI's `package-smoke` job runs both on Linux for every pull request; the release
workflow runs the Desktop smoke on macOS, Windows and Linux and the CLI smoke on Linux. A red
job blocks publishing the draft release.

Local check (macOS arm64):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @extalia/desktop dist:dir
pnpm --filter @extalia/desktop smoke:packaged
```
