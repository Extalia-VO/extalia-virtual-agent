# Security, Privacy & Permission Boundaries

Security and local privacy are foundational architectural pillars for Extalia.

---

## 1. Zero Credential Exposure

- **Public Repository Sanity:** Core source code, configuration templates, and sample assets must never contain API keys, router URLs, personal tokens, or private paths.
- **Local Key Storage:** Desktop credentials are stored securely via OS Keychain / Credential Vault (via keytar or platform API).
- **Web Bundles:** Web builds must never embed API secrets. Remote connections require user-provided tokens passed directly in local session state or mediated by the local Extalia Bridge.

---

## 2. Workspace Sandboxing

Agent filesystem, terminal, and git permissions are strictly bounded by workspace policies:

| Capability | Policy Boundary | Default Rule |
|---|---|---|
| **Filesystem Read** | Inside Workspace Root | Allowed |
| **Filesystem Write** | Inside Workspace Root | Prompt / Allowed |
| **Filesystem Access** | Outside Workspace Root | **DENIED** |
| **Terminal Execution** | Inside Workspace Root | Confirmation Prompt |
| **Git Commit** | Local Repository | Allowed |
| **Git Push** | Remote Upstream | Confirmation Prompt |
| **Network Egress** | External URLs | Explicit Approval |
| **Environment Secrets** | OS Environment / Keys | **DENIED** |

---

## 3. Skill & Plugin Capability Manifests

Plugins and skills cannot request unrestricted privileges. Each must declare an explicit capability manifest:

```yaml
name: project-git-controller
version: 1.0.0
permissions:
  - git.status
  - git.commit
  - git.branch
denied:
  - git.push-force
  - fs.delete-outside-workspace
```

---

## 4. Importer Safety & Secret Redaction

Historical session imports (from Codex, Claude Code, Hermes Agent) adhere to strict safety invariants:
1. **Read-Only Ingestion:** Source repositories and directories are never modified or purged.
2. **Secret Redaction:** High-entropy tokens, passwords, private keys, and authorization headers are sanitized and masked prior to ingestion.
3. **No Automatic Code Execution:** Imported scripts and commands are ingested as inert historical records, never automatically re-executed upon import.
