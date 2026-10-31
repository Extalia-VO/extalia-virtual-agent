# Skill scanner source evidence (2026-10-30)

This is a source audit for [ADR 0023](../adr/0023-skill-scanner-adapter-pinning.md),
not an installed scanner pin, runtime report contract or platform certification.
No scanner, dependencies or worker environment was installed or executed.

- Official repository: [NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector).
  The [v2.13.2 release](https://github.com/NVIDIA/SkillSpector/releases/tag/v2.13.2)
  is dated October 28, 2026. GitHub displays its verified-signature badge;
  no local signature verification was performed.
- `git ls-remote` resolved `refs/tags/v2.13.2` to
  `abd82935b67f765a9541013c0866c6349251dcdf`, also exposed by the
  [official commit page](https://github.com/NVIDIA/SkillSpector/commit/abd82935b67f765a9541013c0866c6349251dcdf).
  This is an observed candidate source identity, not an Extalia-approved pin.
- The [tagged project metadata](https://raw.githubusercontent.com/NVIDIA/SkillSpector/v2.13.2/pyproject.toml)
  declares version `2.13.2`, Apache-2.0, Python `>=3.12,<3.15`, and an OS Independent
  classifier. These declarations do not establish license-artifact review or
  tested OS support. Attempts to fetch the tagged LICENSE page did not succeed;
  its bytes were not independently verified in this audit.
- The [tagged README](https://raw.githubusercontent.com/NVIDIA/SkillSpector/v2.13.2/README.md)
  documents JSON output and a no-LLM scan option. It also documents OSV dependency
  lookups and offline fallback. Turning off LLM analysis alone is not evidence of
  network isolation or complete offline coverage. No CLI arguments or JSON fields
  are adopted into production from documentation alone.

Before a real adapter can become ready, verify installed artifact/dependency
hashes and license notices; run benign/malicious/malformed/oversize fixtures in
an isolated environment; derive the version-bound report normalizer from actual
outputs; and demonstrate network/credential/resource isolation and complete
coverage. Bundle the supported Python/runtime environment under Rust supervision
as required by [ADR 0022](../adr/0022-python-worker-distribution.md).
The default inspector remains unavailable and imported skills remain quarantined.
