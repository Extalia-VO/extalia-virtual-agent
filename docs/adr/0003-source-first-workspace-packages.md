# ADR 0003: Workspace packages export TypeScript source

Status: Accepted

## Context

The monorepo has domain packages consumed by a Vite app, an Electron shell, a
CLI and tests. Building every package before every app adds steps and stale
output.

## Decision

Internal packages (`packages/*`) export their TypeScript source
(`"exports": { ".": "./src/index.ts" }`). Apps bundle them: Vite for Web,
esbuild for the Desktop main/preload scripts and the CLI. Vitest runs the source
directly. Each package type-checks itself with `tsc --noEmit`.

## Consequences

- No package build step during development; changes are visible immediately.
- Packages must stay bundler-friendly ES modules with explicit `.js` import
  extensions inside packages.
- Packages published to npm later (CLI, SDK, protocol) will add a build that
  emits JavaScript and declarations, with a `files` allowlist (PRD §29.3).
