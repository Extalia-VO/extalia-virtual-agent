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

## English installer experience

Installer copy is centralized in `INSTALLER_COPY` in `apps/web/src/i18n.ts` and
stays English independently of the app language.

- **macOS:** the DMG has branded Standard/Retina artwork, an Applications link and
  an Installation Guide. Users can drag the app to Applications or open it for
  guided installation. A packaged app launched outside Applications shows a
  dedicated installer window with three Office photographs, automatic five-second
  crossfades, pause and slide controls, keyboard navigation and reduced-motion
  support. Images focus on the Office at the center right and fade into the title
  background on every edge. Installing uses Electron's native move/copy operation;
  replacing an existing app requires confirmation and a running copy is refused.
  Successful installation relaunches the installed app. Opening without installing
  restarts normal app boot, with no temporary installer profile carried over.
  The initial Finder icon view reserves only those three visible items. Generated
  `.background.tiff`, `.background.png`, `.VolumeIcon.icns` and `.DS_Store`
  support icons receive positions outside the 900×620 artwork, so enabling
  Finder's hidden-file display does not place them over the title. Their bytes
  remain available for the background, disk icon and layout; no Finder preference
  is changed. This is an initial icon-view layout, not removal from a manually
  sorted/list view. Rebuild the DMG to apply it to an existing installer.
- **Windows:** an English assisted NSIS wizard includes a welcome page, destination
  selection, desktop/Start menu shortcuts and an explicit finish/launch choice.
  Existing profile preservation and updater behavior remain in place.
- **Linux x64:** the release also contains `Extalia-VERSION-linux-x64-setup.run`,
  an offline per-user wizard using native Zenity/KDialog folder choosers or terminal
  prompts. The terminal offers the default destination or an editable path.
  An existing empty user-owned destination is accepted; failed installation
  restores it, including unexpected files added before commit. Run it with
  `bash Extalia-VERSION-linux-x64-setup.run`; `--cli` forces terminal mode and
  `--yes` installs without prompting or launching. It installs the bundled
  AppImage, icon and application-menu entry without sudo, rejects unsafe/overlapping
  destinations and running copies, verifies payload integrity and replaces only
  files owned by its installation manifest. Existing AppImage/deb downloads remain.
  AppImage runtime dependencies still apply. Downloaded updater payloads need a
  private, verified handoff receipt before the managed AppImage can be replaced;
  manual setup accepts verified updater replacements and preserves profile data.
  The `.run` has no uninstall command; removal remains manual. Debian package
  installation/removal follows the distribution package manager.

`pnpm --filter @extalia/desktop build` copies the local photographs and bundles
installer-only code. `pnpm --filter @extalia/desktop installer:art` regenerates the
committed PNG/BMP/SVG artwork in an isolated Electron profile. The `beforePack`
hook verifies the artwork/copy/identity/photo hashes and generates English NSIS
and guide files. On macOS it also adds metadata-only DMG positions after config
validation, before artifact signing or update hashes are computed. This uses the
pinned dmg-builder 26.15.3 adapter's `position` support, which its enclosing JSON
schema does not expose; dependency upgrades must reverify native DMG metadata.
The Linux post-build hook creates the self-contained `.run` from
its matching AppImage; release validation verifies that relationship before upload.

For visual review, build Desktop, then run
`pnpm --filter @extalia/desktop exec electron . --installer-preview`. This mode uses
throwaway application, Chromium and home directories, does not start agents, and
cannot install or replace an app. The preview install button only displays a
preview status. Native installation is tested with substituted operations and
temporary directories; native Windows/Linux desktop validation belongs on their
respective release runners. These features do not change signing, notarization,
architecture checks or release publication gates.

Local audit v0.4.292 (2026-11-12): the real isolated macOS Electron installer
preview and Desktop startup smoke pass, including installer photographs, keyboard
controls, reduced motion, preserved preview-only installation, all floor views
and no renderer/model errors. Four browser cases check actual folder components
with synthetic native pickers or authenticated-host browsing in EN/light desktop
and ID/dark phone views. Full repository checks pass (9,312 TypeScript tests,
58 prerequisite skips; 576 Rust tests and builds); sixteen additional
picker regressions pass. Linux shell/PTY installation and rollback tests run in
temporary macOS homes with mocked Zenity/KDialog, and Windows evidence covers NSIS
configuration/templates. This does not certify a native Windows/Linux GUI install
or a new DMG release; no real user profile or installed app was changed.

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
attempt, or remove the quarantine attribute in Terminal:
`xattr -dr com.apple.quarantine /Applications/Extalia.app`.
See [Apple's instructions](https://support.apple.com/en-gb/102445).
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

The **v0.4.288** snapshot of `apps/web/public-assets/models.json`, reconciled on
2026-11-12, registers **133 models**, totaling **152,104,948 GLB bytes** (about
145 MiB before packaging compression): 18 project-authored scene models,
12 retained body/hair exports, 8 additional detailed hairs, 32 fitted
outfits/wardrobe pieces, 45 campus vehicles and 18 plants/trees. Declared-license
counts are MIT 18, RenderHub Extended Use 49, CC-BY-4.0 57, CC-BY-NC-SA-4.0 4,
CC-BY-NC-4.0 1 and Sketchfab Standard 4. These classifications and validation are
technical inventory records, not a blanket grant of commercial or redistribution
rights. The earlier 2026-10-31 inventory (106 models / 417,978,116 bytes) preceded
later greenery additions and texture/vehicle optimizations; it is not the current
package-size estimate. Asset bytes do not measure decoded memory or startup time.

Two physical body files serve the four existing appearance variants; ten detailed
hair exports retain the original fallback. Fitted original garments and staff
uniforms retain the component licenses documented in the inventory and notices.
Default Web, Desktop and CLI builds use the same complete inventory, including
on a clean checkout. `EXTALIA_COMMERCIAL_ASSETS_ONLY=1` filters the runtime car
catalog but **does not remove files from the package**; the five registered
non-commercial cars remain in the output. Excluding their bytes requires changing
the source inventory/catalog and rebuilding, followed by output verification.

Unregistered avatar files do not enter the default Vite graph even when installed
on the build machine; only an explicit development server with `--mode local-assets`
may load them. It is not a production packaging mode. Source archives, private
review manifests and temporary garment-review entry pages are not public assets.

`tooling/public-models.mjs` validates sources and output content, and CLI/Desktop
packaging validates the copied UI again. The built UI carries `models.json`,
`source-garments.json` (exact reviewed source-garment receipts),
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
  and requires its daemon to answer `hello`. Paired scanner packages additionally
  verify the installed daemon/bundle binding and full payload inventory; their cold
  handshake budget is 90 seconds, while daemon-only packages retain 15 seconds.
  npm per-file notices are suppressed so large scanner inventories cannot overflow
  the smoke runner's bounded log buffer.

Enforcement: CI's `package-smoke` job runs both on Linux for every pull request; the release
workflow runs the Desktop smoke on macOS, Windows and Linux and the CLI smoke on Linux. A red
job blocks publishing the draft release.

Local check (macOS arm64):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @extalia/desktop dist:dir
pnpm --filter @extalia/desktop smoke:packaged
```


## Bundled SkillSpector inspection

The verified scanner target is macOS 14+ ARM64. Its daemon and Python bundle are
one release pair. Other targets explicitly report scanner execution unavailable;
they must not substitute system Python or install dependencies on first use.

Build the scanner with the pinned source, runtime and wheel hashes described in
[the bundle guide](../../tooling/skillspector/README.md), then stage the daemon:

```sh
node tooling/build-daemon.mjs --target darwin-arm64 \
  --scanner-bundle /absolute/output/skillspector --require-scanner \
  --out /absolute/output/daemon-artifacts
node apps/cli/npm/generate.mjs --binaries /absolute/output/daemon-artifacts \
  --out /absolute/output/npm --cli --require-scanner-target darwin-arm64
```

Native scanner files must be signed **before** the final manifest is generated
and its digest compiled into the Rust daemon. The `scanner-binding.json` staging
record binds the daemon hash to the complete scanner manifest. Desktop copies the
bundle to `Contents/Resources/skillspector`, beside `daemon/extalia-daemon`; the
CLI platform package places `skillspector` beside `bin`. Both assembly paths
verify the pair. After this explicit staging, invoke electron-builder directly; the
convenience `dist` scripts rebuild daemons without a scanner argument and refuse to
replace an already paired artifact. Desktop verifies copied payload hashes/signatures before and
after app signing and narrowly excludes that scanner directory from re-signing.
The daemon trusts its compiled manifest digest, never a pairing record alone.

Local ad-hoc bundles support preview installers. A notarized release is refused
unless scanner native files already have Developer ID signatures with the selected
identity. Supplying only app-signing credentials does not upgrade an ad-hoc scanner
bundle. Release CI currently builds this scanner pair on native macOS ARM64; no
Windows/Linux scanner readiness is implied by the daemon build matrix.

Validate the final packaged pair with a temporary profile: benign import and
explicit learning must produce complete inspection and await user approval;
activation before approval must fail. After explicit approval and activation,
verified reads must work. Malicious, incomplete and modified packages must remain
unavailable. The scanner uses bundled Python with provider credentials removed,
LLM analysis disabled and network/process-launch denial. Ordinary repository tests
cover contracts without downloading runtimes or scanning a real user profile.
