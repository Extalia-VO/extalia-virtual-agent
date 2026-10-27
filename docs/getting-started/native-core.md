# Native core (preview)

The Rust native core is an optional preview. It is off by default, and Extalia
keeps using the TypeScript runtime unless you turn it on. Behaviour and the
switch itself may change before the core becomes the default.

## What it is

The native core is `extalia-daemon`, a small Rust process. For native missions it
keeps the mission and task records and the event journal, and it decides each
worker tool call. Extalia starts the daemon when the first daemon-routed mission
needs it and stops it with the host. Its data lives in `state/core.sqlite` in
the data folder of each profile.

Model calls and tools still run in the TypeScript host.

## Turn it on

Set `nativeCore` in `config/extalia.json`, inside your Extalia data folder
(`~/.extalia-vo` by default):

```json
{
  "nativeCore": "rust"
}
```

Or set the environment variable before you start Extalia:

```bash
EXTALIA_NATIVE_CORE=rust extalia
```

The environment variable takes precedence over the file, so
`EXTALIA_NATIVE_CORE=typescript` switches back for one run. Extalia reads the
setting when the host starts, so restart it after you change the file.

## What changes

- New saved native missions, the ones with history on, run on the daemon.
- Missions that already exist, and missions with history off, stay on the
  TypeScript path.
- The Knowledge page (your profile's note vault, indexed by the daemon) appears only with the native core on; with the TypeScript core it stays hidden.

## Knowledge vault

The Knowledge page indexes a folder of Markdown notes. By default this is
`vaults/default` inside your data folder. In **Settings → Knowledge vault** you
can choose another folder instead, for example an existing Obsidian vault
(Desktop opens a folder picker; the web app takes the full path). The folder
must already exist and cannot be a symbolic link, the whole disk, your home
folder, or a folder inside (or around) the Extalia data folder. Changing it
restarts the native core and rebuilds the index; it is refused while agent work
is running. Extalia never deletes or rewrites your notes: it edits automatically
only notes marked `managed_by: extalia`, and it leaves `.obsidian` and other
hidden folders untouched. While the native core runs, edits made outside
Extalia are indexed automatically after a short pause (native file watching on
macOS and Windows, a light polling scan elsewhere). If the chosen folder goes
missing, the vault shows as unavailable until you choose it again or switch
back to the default; Extalia does not fall back to another folder.

## Nothing to install in the Desktop app

The Desktop app bundles `extalia-daemon` for macOS (arm64 and x64), Windows x64
and Linux x64. You do not need Rust, Python or Node.js to use it.

The `extalia` command gets the daemon from per-platform npm packages. Release CI
builds those packages, but they are not published yet, so a CLI install cannot
get the daemon from npm yet.

## When the daemon is unavailable

Extalia does not fall back to the TypeScript policy when the daemon fails. If
the daemon is missing, crashes, times out or sends a malformed reply:

- Every worker tool call is denied with the reason `policy_unavailable`,
  including read-only tools.
- Running missions move to `recovering`.
- New missions are refused.

After a restart, work that may have been in flight is marked `unknown`, and the
mission stays `recovering`. Nothing is replayed. If a second Extalia process
already holds the daemon lock, Extalia reports it and does not retry.

The reasoning behind this is in
[ADR 0026](../adr/0026-permission-enforcement-point.md).

## Benchmarks

The measured results are in [docs/benchmarks](../benchmarks/README.md):

- [native-core-2026-10-22.md](../benchmarks/native-core-2026-10-22.md) compares
  the TypeScript mission journal with the Rust daemon. It also lists proposed
  thresholds for turning the core on by default. These are proposals, not
  decisions.
- [native-core-2026-10-22-totals.md](../benchmarks/native-core-2026-10-22-totals.md)
  shows the same comparison after the per-mission running totals change.

To run the benchmark:

```bash
node tooling/bench/native-core.mjs --quick   # smoke run, under 10 s on the reference machine
node tooling/bench/native-core.mjs           # full run, about one minute
```

The benchmark needs the Rust toolchain unless you pass `--daemon <path>`.
Timings depend on the machine they run on.

## For contributors

Building the daemon needs the Rust toolchain pinned in `rust-toolchain.toml`.
Extalia finds a development build in `target/debug` or `target/release`, or
uses the binary named by `EXTALIA_DAEMON_PATH`. See
[Packaging the daemon](../release/packaging.md) for the release build.

## Where to go next

- [Packaging the daemon](../release/packaging.md)
- [Benchmarks](../benchmarks/README.md)
- [Getting started](README.md)
