# Security policy

## Supported versions

Extalia is pre-alpha. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue, discussion or pull request for a suspected vulnerability.

Include what you found, how to reproduce it, the affected version or commit,
and the impact you expect. Maintainers aim to acknowledge reports within five
working days and will keep you informed until a fix is released. Credit is
given in the release notes unless you ask otherwise.

## Scope

Of particular interest:

- escaping a workspace boundary (filesystem, terminal, Git);
- the Desktop shell: renderer isolation, IPC, navigation, the app protocol;
- the local Bridge and its authentication (once released);
- importers and observers: reading outside their declared sources, executing
  imported content, leaking credentials;
- credential handling, exports and diagnostics that expose secrets;
- supply-chain issues in dependencies or release automation.

The security model is described in
[docs/architecture/security.md](docs/architecture/security.md).
