import type { Skill } from './skills.js';

/** Skills that ship with Extalia. User and workspace skills with the same name replace them. */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    name: 'code-review',
    description: 'Review the current changes for correctness bugs first, then clarity; report findings with file:line.',
    source: 'builtin',
    body: `# Code review

1. Find the changes: run \`git status\` and \`git diff\` (add \`--staged\` for staged work). If the user named files or a commit, review those instead.
2. Read each changed file around the edits, not only the diff, so you understand the surrounding code and its callers.
3. Look for correctness problems first: wrong logic, missed edge cases (empty, null, very large, concurrent), broken error handling, security issues such as unchecked input or leaked credentials, and behavior that no longer matches tests or documentation.
4. Then note clarity problems: confusing names, duplicated logic, dead code, missing or misleading comments.
5. Report findings ordered by severity. For each give \`path:line\`, what is wrong, why it matters, and a concrete fix. Say plainly when you are unsure.
6. Do not change files unless the user asks you to. If you find nothing serious, say so briefly.`,
  },
  {
    name: 'write-tests',
    description: 'Add focused tests next to the existing ones, run them, and fix failures.',
    source: 'builtin',
    body: `# Write tests

1. Find how the project tests today: the test runner in the package manifest or build files, existing test folders, naming and helper conventions.
2. Decide what to cover: the behavior that was asked for or just changed, its edge cases, and its error paths. Prefer a few focused tests over many shallow ones.
3. Add the tests next to the existing ones, in the same style. Use temporary directories and fakes instead of the network, real credentials or the user's home directory.
4. Run only the new or affected tests first, then the wider suite if it is fast.
5. When a test fails, decide whether the test or the code is wrong. Fix the code when it is a real bug and say so; never weaken an assertion just to make it pass.
6. Finish with what you added, the command you ran and its result.`,
  },
  {
    name: 'explain-codebase',
    description: 'Map the structure, entry points and data flow of a codebase; cite files.',
    source: 'builtin',
    body: `# Explain a codebase

1. Start from the top: README, package or build manifests, and the top-level folders (list them with limited depth).
2. Identify the entry points: executables, servers, app roots, exported library modules, and how they are started.
3. Follow the main data flow for one or two typical operations, from input to output, reading the files involved.
4. Note the important boundaries: modules or packages, external services, storage, configuration and where secrets come from.
5. Explain it in that order: purpose, layout, entry points, data flow, then anything surprising. Cite files as \`path\` or \`path:line\` so the reader can follow along.
6. Keep it proportional to the question; say what you did not look at.`,
  },
  {
    name: 'plan-feature',
    description: 'Turn a feature request into a short plan, research it (in parallel with workers when useful), then build and verify it step by step.',
    source: 'builtin',
    body: `# Plan and build a feature

1. Restate the goal in one or two sentences and list what is unclear. Ask the user only about choices that change the result; otherwise pick the conventional option and say so.
2. Research before planning. When several independent questions need answers (where a concept lives, how similar features work, which tests cover the area), hand them to workers with \`delegate_task\` in one response so they run together; use the quick tier for lookups and standard or complex for analysis.
3. Write a short plan: the files to change, the order, and how each step will be verified.
4. Implement one step at a time with focused edits that follow the project's style. Run the relevant checks after each meaningful step instead of only at the end.
5. Update or add tests and documentation that describe the new behavior.
6. Finish with what changed, how it was verified, and any follow-up the user should know about.`,
  },
  {
    name: 'debug-issue',
    description: 'Reproduce a bug, find the root cause, fix it and add a regression test.',
    source: 'builtin',
    body: `# Debug an issue

1. Reproduce it first: run the failing command or test, or write the smallest script that shows the problem. Keep the exact error output.
2. Read the error from the bottom up: the first frame in the project's own code is usually the place to start.
3. Form one hypothesis at a time and test it cheaply (a focused log line, a narrower test, a smaller input). Narrow the search by halving the suspect range instead of reading everything.
4. Fix the root cause, not the symptom. If a quick workaround is all that is possible now, say so explicitly.
5. Add a regression test that fails without the fix and passes with it, then run the related tests.
6. Remove temporary logging and report: the cause, the fix, the test, and anything you could not confirm.`,
  },
  {
    name: 'refactor-safely',
    description: 'Restructure code without changing behavior, in small verified steps.',
    source: 'builtin',
    body: `# Refactor safely

1. Make sure behavior is pinned down: find the tests that cover the code, and add characterization tests where coverage is missing.
2. Change one thing at a time (rename, extract, move, inline) and run the tests after each step.
3. Keep public interfaces stable unless the user asked to change them; when they change, update every caller in the same step.
4. Do not mix refactoring with behavior changes or formatting churn; it hides mistakes in review.
5. Report the steps you took and confirm the test results before and after.`,
  },
  {
    name: 'security-review',
    description: 'Check code for common security problems and report them by severity with concrete fixes.',
    source: 'builtin',
    body: `# Security review

1. Map the trust boundaries: where outside input enters (requests, files, environment, command arguments) and where it ends up (queries, shells, file paths, HTML, logs).
2. Check those paths for injection (SQL, shell, template), path traversal, unsafe deserialization, missing authorization checks, and cross-site scripting.
3. Look for secrets in code or logs, weak randomness for tokens, and overly broad permissions or CORS rules.
4. Review dependency manifests for packages pinned to outdated or unmaintained versions; when the project has an audit command, run it.
5. Report each finding with \`path:line\`, how it could be exploited, its severity, and a concrete fix. Do not print real secrets you come across; name the file instead.`,
  },
  {
    name: 'commit-changes',
    description: 'Review the working tree, run the checks, and commit with a clear Conventional Commit message.',
    source: 'builtin',
    body: `# Commit changes

1. Inspect \`git status\` and \`git diff\`. Make sure nothing unrelated, generated or secret (environment files, keys, large binaries) is included.
2. Run the project's checks (tests, lint, typecheck) and fix failures before committing.
3. Stage only the files that belong to the change.
4. Write a Conventional Commit message: \`type(scope): summary\` in the imperative, under 72 characters, with a short body explaining why when it is not obvious.
5. Commit. Never push, force-push or rewrite history unless the user explicitly asks for it.`,
  },
  {
    name: 'update-docs',
    description: 'Bring README and docs in line with the current code; keep them short and accurate.',
    source: 'builtin',
    body: `# Update documentation

1. Find the documentation that describes the changed behavior: README, docs folder, comments on public interfaces, changelog.
2. Compare it with the code as it is now; run commands from the docs when it is cheap to check them.
3. Fix what is wrong or missing. Prefer short, concrete text and working examples over long explanations.
4. Add a changelog entry when the project keeps one.
5. List what you updated and anything that still needs a decision from the user.`,
  },
];
