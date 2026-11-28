import { createHash } from 'node:crypto';
import {
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  canonicalSnapshotJson,
  normalizeOwnedDataSnapshotSelection,
  sanitizeSnapshotValue,
  snapshotManifestDigestInput,
  summarizeSnapshotSectionCounts,
  verifyOwnedDataSnapshotIntegrity,
  type Connection,
  type OperatingProfile,
  type OwnedDataRestoreConflict,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotEntry,
  type OwnedDataSnapshotExportPreview,
  type OwnedDataSnapshotExportResult,
  type OwnedDataSnapshotManifest,
  type OwnedDataSnapshotSection,
  type OwnedDataSnapshotSelection,
  type Workspace,
} from '@extalia/core';
import type { GeneralScheduleCatalog, HostMissionRun, NativeCore, UserProfile } from '@extalia/platform';
import type { SessionRecord } from './sessions.js';

export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface OwnedDataHostSettings {
  workflow?: 'managed' | 'observe';
  setupComplete: boolean;
  setupVersion?: number;
  nativeCore?: NativeCore;
  profile: { id: string; name: string };
  connections: readonly Connection[];
  workspaces: readonly Workspace[];
}

export interface OwnedDataSnapshotDependencies {
  appVersion: string;
  hostKind: 'desktop' | 'bridge';
  now?: () => string;
  getProfile: () => Promise<UserProfile>;
  getHostSettings: () => OwnedDataHostSettings;
  listOperatingProfiles: () => readonly OperatingProfile[] | Promise<readonly OperatingProfile[]>;
  listSessions: () => Promise<readonly SessionRecord[]>;
  readSessionMessages: (sessionId: string) => Promise<unknown[]>;
  listMissions: (sessionId: string) => readonly HostMissionRun[];
  listSchedules: () => Promise<GeneralScheduleCatalog>;
}

export interface OwnedDataSnapshotService {
  previewExport(selection: OwnedDataSnapshotSelection): Promise<OwnedDataSnapshotExportPreview>;
  exportSnapshot(selection: OwnedDataSnapshotSelection): Promise<OwnedDataSnapshotExportResult>;
  previewRestore(bundleJson: string): Promise<OwnedDataRestorePreview>;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissionUnverified(payload: Record<string, unknown>): boolean {
  if (payload.state !== 'completed') return true;
  if (!Array.isArray(payload.tasks)) return true;
  return payload.tasks.some(task => !isPlainRecord(task) || task.state !== 'completed' || task.verification !== 'verified');
}

function hasExistingProfileSettings(userProfile: UserProfile, hostSettings: OwnedDataHostSettings): boolean {
  const updatedMs = Date.parse(userProfile.updatedAt);
  return (Number.isFinite(updatedMs) && updatedMs > 0)
    || Boolean(userProfile.displayName)
    || Object.keys(userProfile.preferences).length > 0
    || Boolean(userProfile.clientState && Object.keys(userProfile.clientState).length > 0)
    || hostSettings.setupComplete
    || hostSettings.connections.length > 0;
}

function toConnectionDescriptor(connection: Connection): { descriptor: Record<string, unknown>; omittedCredentialCount: number } {
  const omittedCredentialCount = connection.credential.kind !== 'none' ? 1 : 0;
  return {
    omittedCredentialCount,
    descriptor: {
      id: connection.id,
      name: connection.name,
      preset: connection.preset,
      api: connection.api,
      url: connection.baseUrl,
      model: connection.model,
      features: { ...connection.features },
      ...(connection.effort !== undefined ? { effort: connection.effort } : {}),
      ...(connection.inputTokenLimit !== undefined ? { inputTokenLimit: connection.inputTokenLimit } : {}),
      ...(connection.contextOptimization !== undefined ? { contextOptimization: structuredClone(connection.contextOptimization) } : {}),
      orchestration: structuredClone(connection.orchestration),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    },
  };
}

function toWorkspacePayload(workspace: Workspace): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    mode: workspace.mode ?? 'managed',
    profileId: workspace.profileId,
    runtimeKind: workspace.runtimeId ?? 'extalia-native',
    ...(workspace.runtimeId !== undefined ? { runtimeId: workspace.runtimeId } : {}),
    ...(workspace.runtimeProfileId !== undefined ? { runtimeProfileId: workspace.runtimeProfileId } : {}),
    ...(workspace.runtimeModel !== undefined ? { runtimeModel: workspace.runtimeModel } : {}),
    ...(workspace.projectLocation !== undefined ? { projectLocation: workspace.projectLocation } : {}),
    ...(workspace.additionalProjectLocations !== undefined ? { additionalProjectLocations: [...workspace.additionalProjectLocations] } : {}),
    ...(workspace.providerProfileId !== undefined ? { providerProfileId: workspace.providerProfileId } : {}),
    ...(workspace.missionConnectionIds !== undefined ? { missionConnectionIds: [...workspace.missionConnectionIds] } : {}),
    ...(workspace.defaultAgentId !== undefined ? { defaultAgentId: workspace.defaultAgentId } : {}),
    ...(workspace.operatingProfileId !== undefined ? { operatingProfileId: workspace.operatingProfileId } : {}),
    ...(workspace.operatingProfileOverrides !== undefined ? { operatingProfileOverrides: structuredClone(workspace.operatingProfileOverrides) } : {}),
    ...(workspace.permissions !== undefined ? { permissions: { ...workspace.permissions } } : {}),
    ...(workspace.crossWorkspaceAccess !== undefined ? { crossWorkspaceAccess: workspace.crossWorkspaceAccess } : {}),
    ...(workspace.team !== undefined ? { team: structuredClone(workspace.team) } : {}),
    ...(workspace.integrationGate !== undefined ? { integrationGate: structuredClone(workspace.integrationGate) } : {}),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function toSessionPayload(session: SessionRecord, messages: unknown[]): Record<string, unknown> {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    connectionId: session.connectionId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ...(session.projectLocation !== undefined ? { projectLocation: session.projectLocation } : {}),
    ...(session.continuedFrom !== undefined ? { continuedFrom: structuredClone(session.continuedFrom) } : {}),
    ...(session.runtime !== undefined ? { runtime: structuredClone(session.runtime) } : {}),
    ...(session.options !== undefined ? { options: structuredClone(session.options) } : {}),
    ...(session.operatingProfile !== undefined ? { operatingProfile: structuredClone(session.operatingProfile) } : {}),
    ...(session.team !== undefined ? { team: structuredClone(session.team) } : {}),
    ...(session.agentName !== undefined ? { agentName: session.agentName } : {}),
    ...(session.agentGender !== undefined ? { agentGender: session.agentGender } : {}),
    ...(session.context !== undefined ? { context: structuredClone(session.context) } : {}),
    ...(session.workspaceFileScopes !== undefined ? { workspaceFileScopes: structuredClone(session.workspaceFileScopes) } : {}),
    ...(session.workspaceFileRoot !== undefined ? { workspaceFileRoot: session.workspaceFileRoot } : {}),
    messages,
  };
}

function buildEntry(
  section: OwnedDataSnapshotSection,
  id: string,
  rawPayload: unknown,
): { entry: OwnedDataSnapshotEntry; omittedSecretFields: number } {
  const sanitized = sanitizeSnapshotValue(rawPayload);
  const payload = isPlainRecord(sanitized.value) ? sanitized.value : {};
  const sha256 = sha256Hex(canonicalSnapshotJson(payload));
  return {
    entry: { section, id, sha256, payload },
    omittedSecretFields: sanitized.omittedSecretFields,
  };
}

export function createOwnedDataSnapshotService(deps: OwnedDataSnapshotDependencies): OwnedDataSnapshotService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function buildBundle(rawSelection: OwnedDataSnapshotSelection): Promise<{
    bundle: OwnedDataSnapshotBundle;
    omittedSecretFields: number;
    warnings: string[];
  }> {
    const selection = normalizeOwnedDataSnapshotSelection(rawSelection);
    const workspaceFilter = selection.workspaceIds ? new Set(selection.workspaceIds) : undefined;
    const sessionFilter = selection.sessionIds ? new Set(selection.sessionIds) : undefined;
    const missionFilter = selection.missionIds ? new Set(selection.missionIds) : undefined;

    const hostSettings = deps.getHostSettings();
    const entries: OwnedDataSnapshotEntry[] = [];
    const warnings: string[] = [];
    let omittedSecretFields = 0;
    let cachedSessions: readonly SessionRecord[] | undefined;

    const getSessions = async (): Promise<readonly SessionRecord[]> => {
      if (!cachedSessions) cachedSessions = await deps.listSessions();
      return cachedSessions;
    };

    for (const section of selection.sections) {
      if (section === 'settings') {
        const userProfile = await deps.getProfile();
        const sortedConnections = [...hostSettings.connections].sort((a, b) => compareId(a.id, b.id));
        const connectionDescriptors: Record<string, unknown>[] = [];
        for (const connection of sortedConnections) {
          const { descriptor, omittedCredentialCount } = toConnectionDescriptor(connection);
          omittedSecretFields += omittedCredentialCount;
          connectionDescriptors.push(descriptor);
        }
        const rawSettings = {
          profileId: hostSettings.profile.id,
          profileName: hostSettings.profile.name,
          ...(userProfile.displayName !== undefined ? { displayName: userProfile.displayName } : {}),
          preferences: { ...userProfile.preferences },
          ...(userProfile.clientState !== undefined ? { clientState: { ...userProfile.clientState } } : {}),
          workflow: hostSettings.workflow ?? 'managed',
          setupComplete: hostSettings.setupComplete,
          ...(hostSettings.setupVersion !== undefined ? { setupVersion: hostSettings.setupVersion } : {}),
          ...(hostSettings.nativeCore !== undefined ? { nativeCore: hostSettings.nativeCore } : {}),
          connections: connectionDescriptors,
        };
        const built = buildEntry('settings', 'profile', rawSettings);
        entries.push(built.entry);
        omittedSecretFields += built.omittedSecretFields;
        continue;
      }

      if (section === 'workspaces') {
        const workspaces = hostSettings.workspaces
          .filter(workspace => !workspaceFilter || workspaceFilter.has(workspace.id))
          .sort((a, b) => compareId(a.id, b.id));
        for (const workspace of workspaces) {
          const built = buildEntry('workspaces', workspace.id, toWorkspacePayload(workspace));
          entries.push(built.entry);
          omittedSecretFields += built.omittedSecretFields;
        }
        continue;
      }

      if (section === 'operatingProfiles') {
        const profiles = [...(await deps.listOperatingProfiles())].sort((a, b) => compareId(a.id, b.id));
        for (const profile of profiles) {
          const built = buildEntry('operatingProfiles', profile.id, structuredClone(profile));
          entries.push(built.entry);
          omittedSecretFields += built.omittedSecretFields;
        }
        continue;
      }

      if (section === 'sessions') {
        const sessions = (await getSessions())
          .filter(session => {
            if (sessionFilter && !sessionFilter.has(session.id)) return false;
            if (workspaceFilter && (session.workspaceId === null || !workspaceFilter.has(session.workspaceId))) return false;
            return true;
          })
          .sort((a, b) => compareId(a.id, b.id));
        for (const session of sessions) {
          let messages: unknown[];
          try {
            const loaded = await deps.readSessionMessages(session.id);
            messages = Array.isArray(loaded) ? loaded : [];
          } catch {
            messages = [];
            warnings.push(`Session "${session.id}" message log was unreadable and omitted from the snapshot.`);
          }
          const built = buildEntry('sessions', session.id, toSessionPayload(session, messages));
          entries.push(built.entry);
          omittedSecretFields += built.omittedSecretFields;
        }
        continue;
      }

      if (section === 'missions') {
        const sessions = await getSessions();
        const missionMap = new Map<string, HostMissionRun>();
        for (const session of sessions) {
          for (const run of deps.listMissions(session.id)) {
            if (!missionMap.has(run.id)) missionMap.set(run.id, run);
          }
        }
        const missions = [...missionMap.values()]
          .filter(run => {
            if (missionFilter && !missionFilter.has(run.id)) return false;
            if (workspaceFilter && !workspaceFilter.has(run.workspaceId)) return false;
            return true;
          })
          .sort((a, b) => compareId(a.id, b.id));
        let unverifiedCount = 0;
        for (const run of missions) {
          const cloned = structuredClone(run);
          const built = buildEntry('missions', run.id, cloned);
          if (isMissionUnverified(built.entry.payload)) unverifiedCount += 1;
          entries.push(built.entry);
          omittedSecretFields += built.omittedSecretFields;
        }
        if (unverifiedCount > 0) {
          warnings.push(`${unverifiedCount} mission(s) are failed, incomplete, or unverified; their unverified status is preserved.`);
        }
        continue;
      }

      if (section === 'schedules') {
        const catalog = await deps.listSchedules();
        const schedules = catalog.schedules
          .filter(schedule => !workspaceFilter || workspaceFilter.has(schedule.workspaceId))
          .sort((a, b) => compareId(a.id, b.id));
        for (const schedule of schedules) {
          const timeZone = schedule.trigger.kind === 'cron' && schedule.trigger.timeZone
            ? schedule.trigger.timeZone
            : catalog.timeZone;
          const rawSchedule = {
            id: schedule.id,
            name: schedule.name,
            workspaceId: schedule.workspaceId,
            trigger: structuredClone(schedule.trigger),
            ...(timeZone ? { timeZone } : {}),
            enabled: schedule.enabled,
            missedRunPolicy: schedule.missedPolicy,
            revision: schedule.revision,
            prompt: schedule.prompt,
            sessionTarget: structuredClone(schedule.sessionTarget),
            assignment: structuredClone(schedule.assignment),
            state: schedule.state,
            createdAt: schedule.createdAt,
            updatedAt: schedule.updatedAt,
          };
          const built = buildEntry('schedules', schedule.id, rawSchedule);
          entries.push(built.entry);
          omittedSecretFields += built.omittedSecretFields;
        }
      }
    }

    const appVersion = deps.appVersion.trim().slice(0, 64) || '0.0.0';
    const manifestHeader = {
      format: OWNED_DATA_SNAPSHOT_FORMAT,
      schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
      selection,
    } as const;
    const manifest: OwnedDataSnapshotManifest = {
      ...manifestHeader,
      provenance: {
        appVersion,
        exportedAt: now(),
        format: OWNED_DATA_SNAPSHOT_FORMAT,
        schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
        hostKind: deps.hostKind,
      },
      entryCount: entries.length,
      manifestSha256: sha256Hex(snapshotManifestDigestInput(manifestHeader, entries)),
      secretCanaryChecked: true,
    };

    return {
      bundle: { manifest, entries },
      omittedSecretFields,
      warnings,
    };
  }

  return {
    async previewExport(selection) {
      const { bundle, warnings } = await buildBundle(selection);
      const bundleJson = JSON.stringify(bundle, null, 2);
      return {
        selection: bundle.manifest.selection,
        totalEntries: bundle.entries.length,
        sectionCounts: summarizeSnapshotSectionCounts(bundle.entries),
        estimatedBytes: Buffer.byteLength(bundleJson, 'utf8'),
        excludesSecrets: true,
        excludesVendorSources: true,
        warnings,
      };
    },

    async exportSnapshot(selection) {
      const { bundle, omittedSecretFields } = await buildBundle(selection);
      const integrity = verifyOwnedDataSnapshotIntegrity(bundle, sha256Hex);
      if (!integrity.ok || integrity.secretFreeVerified !== true || integrity.checksumVerified !== true) {
        throw new Error(integrity.conflicts[0]?.detail ?? 'Owned-data snapshot failed integrity or secret-free verification.');
      }
      const bundleJson = JSON.stringify(bundle, null, 2);
      const byteLength = Buffer.byteLength(bundleJson, 'utf8');
      const sha256 = sha256Hex(bundleJson);
      return { bundle, bundleJson, sha256, byteLength, omittedSecretFields };
    },

    async previewRestore(bundleJson) {
      if (typeof bundleJson !== 'string') {
        return {
          valid: false,
          dryRunOnly: true,
          entryCount: 0,
          sectionCounts: {},
          wouldAdd: 0,
          wouldCollide: 0,
          checksumVerified: false,
          secretFreeVerified: false,
          conflicts: [{ kind: 'corrupt-archive', detail: 'Snapshot archive must be a JSON string.' }],
          warnings: [],
        };
      }

      if (Buffer.byteLength(bundleJson, 'utf8') > MAX_SNAPSHOT_BYTES) {
        return {
          valid: false,
          dryRunOnly: true,
          entryCount: 0,
          sectionCounts: {},
          wouldAdd: 0,
          wouldCollide: 0,
          checksumVerified: false,
          secretFreeVerified: false,
          conflicts: [{
            kind: 'corrupt-archive',
            detail: `Snapshot archive exceeds maximum size of ${MAX_SNAPSHOT_BYTES} bytes.`,
          }],
          warnings: [],
        };
      }

      const verification = verifyOwnedDataSnapshotIntegrity(bundleJson, sha256Hex);
      const conflicts: OwnedDataRestoreConflict[] = [...verification.conflicts];
      const bundle = verification.bundle;

      if (!bundle) {
        return {
          valid: false,
          dryRunOnly: true,
          ...(verification.schemaVersion !== undefined ? { schemaVersion: verification.schemaVersion } : {}),
          entryCount: 0,
          sectionCounts: {},
          wouldAdd: 0,
          wouldCollide: 0,
          checksumVerified: verification.checksumVerified,
          secretFreeVerified: verification.secretFreeVerified,
          conflicts,
          warnings: [],
        };
      }

      const hostSettings = deps.getHostSettings();
      const userProfile = await deps.getProfile();
      const operatingProfiles = await deps.listOperatingProfiles();
      const sessions = await deps.listSessions();
      const scheduleCatalog = await deps.listSchedules();

      const liveWorkspaceIds = new Set(hostSettings.workspaces.map(item => item.id));
      const liveOperatingProfileIds = new Set(operatingProfiles.map(item => item.id));
      const liveSessionIds = new Set(sessions.map(item => item.id));
      const liveMissionIds = new Set<string>();
      for (const session of sessions) {
        for (const run of deps.listMissions(session.id)) liveMissionIds.add(run.id);
      }
      const liveScheduleIds = new Set(scheduleCatalog.schedules.map(item => item.id));
      const profileExists = hasExistingProfileSettings(userProfile, hostSettings);

      const snapshotWorkspaceIds = new Set(
        bundle.entries.filter(entry => entry.section === 'workspaces').map(entry => entry.id),
      );

      const warnings: string[] = [];
      let wouldAdd = 0;
      let wouldCollide = 0;
      let unverifiedMissions = 0;

      for (const entry of bundle.entries) {
        if (entry.section === 'settings') {
          if (profileExists) {
            wouldCollide += 1;
            warnings.push('Profile preferences already exist on this host; review before applying settings.');
          } else {
            wouldAdd += 1;
          }
        } else {
          const liveSet = entry.section === 'workspaces'
            ? liveWorkspaceIds
            : entry.section === 'operatingProfiles'
              ? liveOperatingProfileIds
              : entry.section === 'sessions'
                ? liveSessionIds
                : entry.section === 'missions'
                  ? liveMissionIds
                  : liveScheduleIds;
          if (liveSet.has(entry.id)) {
            wouldCollide += 1;
            conflicts.push({
              kind: 'id-collision',
              section: entry.section,
              id: entry.id,
              detail: `${entry.section} entry "${entry.id}" collides with an existing record on this host.`,
            });
          } else {
            wouldAdd += 1;
          }
        }

        if (entry.section === 'sessions' || entry.section === 'missions' || entry.section === 'schedules') {
          const workspaceId = entry.payload.workspaceId;
          if (typeof workspaceId === 'string' && workspaceId.length > 0) {
            if (!liveWorkspaceIds.has(workspaceId) && !snapshotWorkspaceIds.has(workspaceId)) {
              conflicts.push({
                kind: 'missing-dependency',
                section: entry.section,
                id: entry.id,
                detail: `${entry.section} entry "${entry.id}" references missing workspace "${workspaceId}".`,
              });
            }
          }
        }

        if (entry.section === 'missions' && isMissionUnverified(entry.payload)) {
          unverifiedMissions += 1;
        }
      }

      if (unverifiedMissions > 0) {
        warnings.push(`${unverifiedMissions} mission(s) in the snapshot are failed, incomplete, or unverified; unverified status is preserved.`);
      }

      return {
        valid: conflicts.length === 0,
        dryRunOnly: true,
        schemaVersion: bundle.manifest.schemaVersion,
        entryCount: bundle.entries.length,
        sectionCounts: summarizeSnapshotSectionCounts(bundle.entries),
        wouldAdd,
        wouldCollide,
        checksumVerified: verification.checksumVerified,
        secretFreeVerified: verification.secretFreeVerified,
        conflicts,
        warnings,
      };
    },
  };
}
