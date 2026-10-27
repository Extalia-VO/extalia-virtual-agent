export { createAgentHost, type AgentHostOptions, type AgentHostRuntime, type WorktreeHostApi } from './service.js';
export {
  IntegrationQueue, WorktreeError, WorktreeManager,
  type DiffSummary, type GateResult, type IntegrationGate, type IntegrationProposal, type IntegrationStatus, type WorktreeOrphan, type WorktreeRecord, type WorktreeStatus,
} from './worktrees/index.js';
export { HostLockedError } from './lock.js';
export { createSecretStore, type SecretStore } from './secrets.js';
export { dataLayout, type DataLayout } from './paths.js';
export {
  createConnectService, resolveNodePath, ConnectError, displayPath, findOnPath,
  FORWARDER_SOURCE, FORWARDER_VERSION, forwarderPath, installForwarder,
  DEFAULT_HOOK_PORT, ensureToken, readEndpoint, readToken, tokenFile, endpointFile,
  GEMINI_EVENTS, GEMINI_HOOK_TIMEOUT_MS, geminiCommand, inspectGeminiSettings, planGeminiSettings, removeGeminiEntries,
  ANTIGRAVITY_EVENTS, ANTIGRAVITY_HOOK_TIMEOUT_SEC, antigravityCommand, inspectAntigravityHooks, planAntigravityHooks, removeAntigravityEntries,
  HERMES_EVENTS, HERMES_HOOK_PATH, hermesWebhookUrl, inspectHermesConfig, planHermesConfig, removeHermesBlock,
  type ConnectContext, type ConnectService, type RunCommand, type RunResult,
} from './connect/index.js';
export { DESKTOP_HOOK_PORT } from './hooks/files.js';
export { HOOK_PATH, startHookListener, type HookListener } from './hooks/http.js';
export { createHookIngest, type HookIngest, type HookIngestOptions } from './hooks/ingest.js';
export {
  EXTALIA_MCP_INSTRUCTION, EXTALIA_MCP_TOOLS, forwardMcpReport, handleMcpJsonRpc, normalizeMcpReport, runMcpStdioServer,
  type McpServerOptions, type McpToolDefinition,
} from './hooks/mcp.js';
export {
  DEFAULT_HERMES_DASHBOARD_URL, HermesDashboardClient, parseHermesDashboardUrl,
  type HermesDashboardOptions, type HermesDashboardRead, type HermesDashboardSession, type HermesTimelinePage,
} from './hermesDashboard.js';
export {
  MIGRATED_ENTRIES, MIGRATION_MARKER, MIGRATION_NOTE, forwarderShimSource, migrateLegacyDataDirectory, readMigrationMarker,
  type LegacyMigrationOptions, type LegacyMigrationResult, type MigrationMarker,
} from './migration.js';
export { PROFILE_SCHEMA, applyProfilePatch, createProfileStore, decodeProfile, emptyProfile, type ProfileStore } from './profile.js';
