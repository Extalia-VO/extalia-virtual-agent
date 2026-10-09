# ADR 0005: Extalia Native runtime for API-only connections

Status: Accepted

## Context

Users who only have an API key or a model router (OpenAI, Anthropic, OpenRouter,
9Router, OmniRoute, Ollama, any OpenAI-compatible endpoint) had no way to run a
tool-using agent from Extalia: a provider answers model requests, it does not
read files, edit code or run commands. Agent runtimes such as Hermes Agent,
Claude Code or Codex bring their own loop, tools, memory and skills.

## Decision

Extalia ships its own agent loop, the **Extalia Native** runtime:

- `@extalia/runtime` (pure TypeScript): the provider-neutral loop, model
  providers and the permission policy. Two wire formats cover the presets:
  OpenAI-compatible Chat Completions (streaming tool calls, implemented with
  `fetch`) and the Anthropic Messages API (through the official
  `@anthropic-ai/sdk`). Assistant turns keep the provider's own content so it is
  replayed unchanged; for Anthropic this keeps reasoning blocks valid and
  follows the rules for server-side refusal fallbacks, which are enabled with
  `fallbacks: "default"` only when talking to api.anthropic.com directly.
- `@extalia/host` (Node): workspace-bounded tools (list, read, search, write,
  edit files; run commands in the project root without credential environment
  variables), the OS credential store, sessions, memory and skills, exposed
  through the `AgentHostApi` contract. Desktop runs it in the main process; the
  Web client reaches it through the local Bridge started by the `extalia`
  command.
- Every step is an Extalia Protocol event, so Chat, Console and the Office treat
  native sessions like any other managed session.
- Writes and commands follow the workspace permissions (ask by default). The
  user can allow an action once or for the rest of the session.

### Memory and skills belong to one owner

Each connection chooses who provides memory and skills: `extalia`, `provider`
(only for presets that have their own, such as OmniRoute) or `off`. When
Extalia's memory is used with OmniRoute, requests carry
`x-omniroute-no-memory: true` so the two never inject overlapping memory. Runtimes
with their own memory and skills (Hermes Agent, Claude Code, Codex) keep them;
Extalia does not add its own there.

## Consequences

- API-only users get a working coding agent; runtime users keep theirs.
- Extalia now maintains tools and a loop; their behavior is covered by unit and
  end-to-end tests against scripted endpoints (`tooling/mock-provider.mjs`).
- Long sessions are sent in full; context compaction is future work.
