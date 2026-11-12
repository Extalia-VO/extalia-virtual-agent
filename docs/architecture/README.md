# Architecture documentation

Start with [overview](overview.md); dependencies point `protocol ← core ← platform ← apps`.
Use the latest applicable [ADR](../adr/README.md) when an older baseline differs.

| Contract | Document |
| --- | --- |
| Events and validation | [Protocol](protocol.md) |
| Managed vs observed, runtime vs provider | [Runtime adapters](runtime-adapters.md) |
| Session lifecycle and storage | [Sessions](sessions.md), [storage inventory and reset](storage.md) |
| Host capabilities, IPC and profile data | [Platform](platform.md) |
| Mission ownership, persistence and recovery limits | [Native missions](native-missions.md) |
| Connections, hooks, consent and undo | [Agent app connections](agent-app-connections.md) |
| Observed tool image provenance | [Tool images](observed-tool-images.md) |
| Permissions and trust boundaries | [Security](security.md) |
| Scanner pin and platform-specific evidence | [Scanner evidence](skill-scanner-evidence.md) |

## Recorded evidence

These files describe their recorded versions; they are not a fresh audit run.

- [Deferred learning](deferred-learning-evidence.json)
- [Provider model discovery](native-provider-models-evidence.json)
- [Automatic skill loading](native-skill-loading-evidence.json)
- [Observed tool images](observed-tool-image-evidence.json)
- [SkillSpector integration](skillspector-integration-evidence.json) and
  [native scanner](skillspector-native-evidence.json)
- Provider completion: [selection](provider-completion-selection.json),
  [shared worker](provider-completion-benchmark.json),
  [one-shot](provider-completion-oneshot-benchmark.json),
  [Python candidate](provider-completion-python-benchmark.json);
  [measurement explanation](../bench/provider-completion.md)

See [module hubs](../modules/README.md) for feature status and source/test navigation.
