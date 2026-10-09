# Getting started

## Use Extalia

Agents need a host that can reach your files and run commands, so Extalia runs
in one of two ways:

- **Desktop app** (macOS, Windows, Linux): download it from GitHub Releases. It
  checks for updates when it starts, downloads them in the background and
  restarts into the new version when no agent is working.
- **Web client through the `extalia` command**:

  ```bash
  npm i -g extalia-vo
  extalia
  ```

  This starts a local Bridge on `127.0.0.1` and opens the web UI. Update with
  `extalia update` (it runs `npm i -g extalia-vo@latest --prefer-online`) or the
  "Update and restart" button in the app.

On first start a short setup asks for:

1. **A model connection**: OpenAI, Anthropic, OpenRouter, 9Router, OmniRoute,
   Ollama or any OpenAI-compatible endpoint, with its API key (kept in your OS
   credential store) or an environment variable. Choose who provides memory and
   skills: Extalia, the provider where it has its own (OmniRoute), or off.
2. **A workspace**: the project folder the agent works in, and whether file
   edits and commands need your approval (they do by default).

Then open Chat and describe the task. The agent reads and searches the project,
asks before it edits files or runs commands, and reports every step.

### Try it without an API key

`tooling/mock-provider.mjs` is a scripted OpenAI-compatible endpoint that plays
a tiny agent (it creates `hello.txt` and shows it):

```bash
node tooling/mock-provider.mjs --port 4319
```

In setup choose **Custom endpoint**, base URL `http://127.0.0.1:4319/v1`, model
`mock-agent`, no key.

## Develop Extalia

Requirements: Node.js 22.12 or newer (`.node-version` pins 24), pnpm 12
(`corepack enable` picks the version from `package.json`), Git. No account, API
key or private file is needed.

```bash
git clone https://github.com/Extalia-VO/extalia-virtual-agent.git
cd extalia-virtual-agent
pnpm install
pnpm dev            # Web UI only, at http://127.0.0.1:5180 (no agent host)
pnpm dev:desktop    # Desktop shell with the agent host
pnpm build && node apps/cli/dist/extalia.mjs start   # Web UI through the Bridge
```

The first Desktop start downloads the Electron binary once (Electron fetches it
on first run rather than during install). Use `EXTALIA_HOME=/tmp/extalia-dev`
to keep development data apart from your own; `EXTALIA_SECRET_STORE=file`
avoids the OS keychain while testing.

## Checks

```bash
pnpm check          # lint, boundaries, public safety, typecheck, tests, build, versions
pnpm test           # unit and integration tests
pnpm test:desktop   # Electron smoke test (needs a display; use xvfb-run on Linux)
```

## Where to go next

- [Architecture overview](../architecture/overview.md)
- [Runtimes, providers and observed agents](../architecture/runtime-adapters.md)
- [Contributing](../../CONTRIBUTING.md)
- [Roadmap](../wiki/Roadmap-and-Phases.md)
