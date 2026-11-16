# Security, privacy and permissions

Current source baseline: **v0.4.288**. The detailed reference is the
[security model](../architecture/security.md), with
[platform contracts](../architecture/platform.md) and
[connection safety](../architecture/agent-app-connections.md).

## Implemented boundaries

| Surface | Enforced scope or limitation |
| --- | --- |
| Native file tools | Selected folders, canonical paths, credential-file refusal and two-sided cross-workspace policies; edits retain user approval rules |
| Native commands | Unavailable without a verified workspace-isolated executor; confirmation alone does not provide isolation |
| Files/Git views | Read-only inspection; no generic commit/push action in these views |
| Mission writes | Explicit write tasks use isolated Git worktrees; production integration tests are not run and Apply refuses proposals |
| Model credentials | Host-side OS credential store or user-only fallback file; environment references are resolved by the host, not returned to the UI |
| External skills | Quarantined immutable revision, required current scanner evidence, separate review/approval/activation; missing or incomplete evidence refuses use |
| Observed control | Exact source/transport capability only; hooks/transcripts and displayed waiting status do not authorize answers or actions |
| External app configuration | Preview, user approval, backup and undo before connection changes; tests use temporary homes |

Provider, catalog and scanner network paths have their own contracts. This is
not a universal network-approval sandbox or a generic terminal/Git permission
system. A declared skill permission is a ceiling, never a tool grant. General
executable plugin isolation remains planned.

## Imported content and privacy

History/Knowledge sources are read as data and do not grant policy or execution
rights. Importers preserve their outside sources; retained events, previews,
exports and diagnostic surfaces apply their documented bounds and redaction.
Redaction is not a guarantee that arbitrary user-authored content has no secrets.

The Bridge uses authenticated loopback requests and Host/Origin checks. Only one
host owns a profile at a time. Web/Office code does not receive provider keys.
No telemetry is collected. User data is not public repository content.

## Scanner and acceptance limits

Pinned SkillSpector 2.13.4 and bundled Python have execution/isolation evidence
for macOS 14+ ARM64. Other scanner platforms remain unavailable/fail-closed.
Ordinary documents read as task data are not automatically activated skills.
A security scan does not establish skill correctness or measured quality.

Complete descendant/writer ownership, physical reconciliation, exact effect-time
grants and broader cross-profile ACL acceptance remain open. See
[Skills](../modules/skills.md), [Native](../modules/native-agent.md) and
[PRD acceptance](../product/prd-v2-acceptance-map.md).
