# Contributing & Governance Guidelines

## 1. Project Governance Structure

Extalia adopts an open, transparent, yet structured governance model to ensure stability and architectural integrity:

- **Project Lead:** Establishes overarching product vision, approves architectural changes, and assigns maintainer responsibilities.
- **Core Maintainers:** Perform core code reviews, maintain repository security standards, and manage release pipelines.
- **Area Maintainers:** Oversee specific domains (Renderer, Protocol, Runtime Adapters, Importers, UI).
- **Contributors:** Open issues, submit PRs, enhance documentation, and build ecosystem plugins.

---

## 2. Contribution Workflow

1. **Issue First:** Every pull request must link to an existing tracked issue.
2. **Conventional Commits:** All git commits must adhere to Conventional Commits:
   - `feat(scope): ...`
   - `fix(scope): ...`
   - `docs(scope): ...`
   - `refactor(scope): ...`
   - `test(scope): ...`
3. **Local Quality Verification:** Ensure all linters, type checks, and test suites pass locally before submitting PRs:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   ```
4. **Generalization Invariant:** Never introduce hardcoded user paths, personal usernames, or private project identifiers into core repositories. All features must be fully configurable via settings or public APIs.
