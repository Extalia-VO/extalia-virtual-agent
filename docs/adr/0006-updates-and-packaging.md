# ADR 0006: Updates and desktop packaging

Status: Accepted (resolves the packaging question left open in ADR 0002)

## Context

The product owner wants each client to keep itself current: the Web version is
installed with npm and should update through npm; the Desktop app should check
for an update when it starts, install it and restart. The PRD forbids blind
`git pull`/`npm update` on every launch and forbids restarting while agents are
working.

## Decision

**Desktop** is packaged with electron-builder (DMG + ZIP on macOS, NSIS on
Windows, AppImage + DEB on Linux) and published to GitHub Releases by a tag
workflow. `electron-updater` checks the release feed shortly after launch,
downloads a newer version in the background and, once it is downloaded and no
agent turn is running, announces a 10-second restart that the user can postpone
(the update then installs on quit). Development builds report updates as
unsupported. macOS auto-update requires a signed and notarized build.

**Web/CLI** is the npm package `extalia-vo` (command `extalia`). On start it
checks the registry in the background (cached for 12 hours, opt out with
`--no-update-check` or `EXTALIA_NO_UPDATE_CHECK=1`). `extalia update` runs
`npm i -g extalia-vo@latest --prefer-online`; the web UI offers the same as
"Update and restart", after which the Bridge relaunches itself and the page
reconnects. Installs from source report updates as unsupported.

Both share the `UpdateStatus` shape from `@extalia/platform`, so the UI shows one
banner for either.

## Consequences

- Release automation needs signing secrets for trusted macOS and Windows builds;
  unsigned builds still work for local testing.
- Publishing `extalia-vo` to npm is a maintainer decision (the package is marked
  private until then).
