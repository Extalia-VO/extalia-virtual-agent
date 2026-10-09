# System Architecture

## 1. Core Architectural Principle

The 3D virtual office must never directly couple to any specific agent runtime (Hermes, Codex, Claude Code, Gemini, etc.) or AI provider API.

```text
Runtime / Provider
       ↓
Runtime Adapter
       ↓
Extalia Protocol (Normalized Events)
       ↓
Session / Task / Agent State Store
       ↓
UI Layers (Office 3D | Chat | Console | Tasks | Terminal)
```

The rendering engine and UI only ingest normalized, versioned Extalia events.

---

## 2. Platform Abstraction

Extalia targets Desktop (macOS arm64/x64, Windows x64, Linux x64) and modern Web browsers (Chromium, Firefox, WebKit).

Platform features are accessed via unified capability interfaces rather than platform checks (`if (isElectron)`):

```typescript
interface PlatformCapabilities {
  filesystem?: FileSystemCapability;
  terminal?: TerminalCapability;
  git?: GitCapability;
  secureStorage?: SecureStorageCapability;
  notifications?: NotificationCapability;
  updater?: UpdateCapability;
}
```

- **Desktop:** Directly accesses local capabilities natively via safe platform bridges.
- **Web:** Connects via authenticated localhost loopback to the **Extalia Bridge** for native terminal, filesystem, and local runtime support.

---

## 3. Monorepo Organization

```text
extalia/
├── apps/
│   ├── desktop/            # Electron / Tauri Desktop application
│   ├── web/                # Standalone Web application
│   └── cli/                # Terminal interface and bridge launcher
│
├── packages/
│   ├── core/               # Domain logic, entity models
│   ├── protocol/           # Event definitions, schemas, serialization
│   ├── runtime/            # Runtime adapter contracts & lifecycle
│   ├── event-bus/          # Typed pub/sub event routing
│   ├── platform/           # Cross-platform capability interfaces
│   ├── workspace/          # Project folders and workspace states
│   ├── sessions/           # Multi-session store, persistence, history
│   ├── renderer/           # Three.js / R3F spatial rendering engine
│   ├── office/             # Room semantics, lighting, spatial allocation
│   ├── avatars/            # Avatar models, kinematics, animations
│   ├── ui/                 # Shared UI components, Design tokens
│   ├── console/            # Agent console, inspection, steering
│   ├── importer-core/      # Session import normalization & deduplication
│   └── sdk/                # Public extension SDK
│
├── plugins/                # Official and community plugins
├── docs/                   # Architectural specs & ADRs
└── .github/                # CI/CD, issue templates, workflows
```

---

## 4. Normalized Extalia Protocol

All agent lifecycle events adhere to a typed, versioned protocol schema:

```typescript
type ExtaliaEvent =
  | AgentCreated
  | AgentStarted
  | AgentStopped
  | AgentStateChanged
  | PromptSubmitted
  | ModelStreaming
  | ToolStarted
  | ToolOutput
  | ToolCompleted
  | CommandStarted
  | CommandCompleted
  | SubagentSpawned
  | TaskCreated
  | TaskAssigned
  | TaskProgress
  | TaskCompleted
  | ApprovalRequested
  | ApprovalGranted
  | GitStatus
  | GitCommit;
```
