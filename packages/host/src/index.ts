export { createAgentHost, type AgentHostOptions, type AgentHostRuntime, type WorktreeHostApi } from './service.js';
export {
  IntegrationQueue, WorktreeError, WorktreeManager,
  type DiffSummary, type GateResult, type IntegrationGate, type IntegrationProposal, type IntegrationStatus, type WorktreeOrphan, type WorktreeRecord, type WorktreeStatus,
} from './worktrees/index.js';
export { HostLockedError } from './lock.js';
export { createSecretStore, type SecretStore } from './secrets.js';
export { dataLayout, type DataLayout } from './paths.js';
export {
  createConnectService, preferStableNodePath, resolveNodePath, ConnectError, displayPath, findOnPath,
  FORWARDER_SOURCE, FORWARDER_VERSION, FORWARD_LAUNCHER_SOURCE, FORWARD_LAUNCHER_VERSION,
  forwarderPath, forwarderStatus, forwardLauncherPath, forwardLauncherStatus, installForwarder, installForwardLauncher,
  nodePathFile, readRecordedNodePath, writeRecordedNodePath,
  DEFAULT_HOOK_PORT, ensureToken, readEndpoint, readToken, tokenFile, endpointFile,
  GEMINI_EVENTS, GEMINI_HOOK_TIMEOUT_MS, geminiCommand, inspectGeminiSettings, planGeminiSettings, removeGeminiEntries,
  ANTIGRAVITY_EVENTS, ANTIGRAVITY_HOOK_TIMEOUT_SEC, antigravityCommand, inspectAntigravityHooks, planAntigravityHooks, removeAntigravityEntries,
  HERMES_EVENTS, HERMES_HOOK_PATH, hermesWebhookUrl, inspectHermesConfig, planHermesConfig, removeHermesBlock,
  type ConnectContext, type ConnectService, type RunCommand, type RunResult,
} from './connect/index.js';
export { DESKTOP_HOOK_PORT } from './hooks/files.js';
export { previewCodexPermissionHookSetup, previewCodexPermissionHookUndo, applyCodexPermissionHookSetup, undoCodexPermissionHookSetup, type CodexPermissionHookSetupOptions, type CodexPermissionHookUndoOptions } from './connect/codexPermissionHookSetup.js';
export { awaitObservedReply, isObservedReplyRequest, type ObservedReplyRequest, type ObservedReplyResult, type ObservedReplyClientOptions } from './observedReplyClient.js';
export { pollObservedInbox, isObservedInboxRequest } from './observedInboxClient.js';
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
export { runObservedCliArchiveReader } from './observedCliArchiveReader.js';
export {
  GeneralScheduleManager, ScheduleStoreCorruptionError, ScheduleStoreDowngradeError, buildScheduledSessionOptions,
  type GeneralScheduleHostCallbacks, type GeneralScheduleManagerOptions, type ScheduleDeferredDispatch,
  type ScheduleDispatchReceipt, type ScheduleExecutionTarget, type ScheduleMigrationDiagnostics,
  type ScheduleRetryContext, type TurnBindingInput, type TurnSettlementDetails, type TurnSettlementMatch, type VerificationDetails,
} from './schedules.js';
export {
  ScheduleStore, SCHEDULE_STORE_SCHEMA_VERSION,
  buildAutomaticOccurrenceKey, buildManualOccurrenceKey,
  type AdmitScheduleOccurrenceInput, type AdmitScheduleOccurrenceResult,
  type LegacyMigrationResult as ScheduleLegacyMigrationResult,
  type RecordDeliveryInput, type StoredScheduleCatalogState,
} from './scheduleStore.js';
export * from './serviceManager.js';
