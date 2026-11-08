/** Bounded, host/profile-scoped inspection. No provider or daemon calls on read. */
export interface NativeActiveRun {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: 'chat' | 'planning' | 'preparing' | 'mission';
  cancellationRequested: boolean;
  missionId?: string;
  approvalId?: string;
}
export interface NativeStatusWorker {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: 'delegated' | 'mission-task';
  state: string;
  active: boolean;
  evidence: 'local-invocation' | 'recorded-task';
  label?: string;
  missionId?: string;
  taskId?: string;
}
export interface NativeStatusMission {
  id: string;
  sessionId: string;
  workspaceId: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'recovering';
  backend: 'typescript' | 'rust' | 'unknown';
  tasks: { id: string; taskId: string; title: string; state: string }[];
}
export interface NativeStatusBlocker {
  id: string;
  kind: 'planning' | 'preparation' | 'mission-recovery';
  sessionId: string;
  workspaceId: string;
  localActive: boolean;
  reason: 'local-active' | 'inspection-required' | 'host-restart' | 'execution-uncertain' | 'authority-unknown';
  missionId?: string;
  invocationId?: string;
}
export interface NativeStatusRecheck {
  status: 'checked' | 'partial' | 'unsupported' | 'unavailable';
  skippedActive: number;
  inspected: number;
  retired: number;
  retained: number;
  remaining: number;
}
export interface NativeStatus {
  schema: 'extalia.native-status.v1';
  sampledAt: string;
  /** Selection for new saved missions; existing missions retain their own backend. */
  backend: 'typescript' | 'rust';
  providerLoop: 'typescript';
  daemon: { state: 'off' | 'starting' | 'ready' | 'unavailable'; lastError?: string };
  active: NativeActiveRun[];
  workers: NativeStatusWorker[];
  missions: NativeStatusMission[];
  blockers: NativeStatusBlocker[];
  totals: { active: number; workers: number; missions: number; blockers: number };
  truncated: { active: boolean; workers: boolean; missions: boolean; blockers: boolean };
  recheck?: NativeStatusRecheck;
}
