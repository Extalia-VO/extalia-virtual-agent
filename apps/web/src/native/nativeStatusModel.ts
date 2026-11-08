import type { AgentHostApi, NativeStatus } from '@extalia/platform';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown) => value === undefined || text(value);
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: Record<string, unknown>) => text(value.id) && text(value.sessionId) && text(value.workspaceId);

/** Treat older/malformed peers as unavailable; never infer a healthy empty snapshot. */
export function isNativeStatus(value: unknown): value is NativeStatus {
  if (!record(value) || value.schema !== 'extalia.native-status.v1' || !text(value.sampledAt) || !Number.isFinite(Date.parse(value.sampledAt))
    || !oneOf(value.backend, ['typescript', 'rust']) || value.providerLoop !== 'typescript'
    || !record(value.daemon) || !oneOf(value.daemon.state, ['off', 'starting', 'ready', 'unavailable']) || !optionalText(value.daemon.lastError)
    || !record(value.totals) || !record(value.truncated)) return false;
  for (const key of ['active', 'workers', 'missions', 'blockers'] as const) {
    const entries = value[key];
    if (!Array.isArray(entries) || !count(value.totals[key]) || value.totals[key] < entries.length
      || typeof value.truncated[key] !== 'boolean' || value.truncated[key] !== (value.totals[key] > entries.length)) return false;
  }
  if (!(value.active as unknown[]).every(item => record(item) && identity(item) && oneOf(item.kind, ['chat', 'planning', 'preparing', 'mission'])
    && typeof item.cancellationRequested === 'boolean' && optionalText(item.missionId) && optionalText(item.approvalId))) return false;
  if (!(value.workers as unknown[]).every(item => record(item) && identity(item) && oneOf(item.kind, ['delegated', 'mission-task'])
    && text(item.state) && typeof item.active === 'boolean' && oneOf(item.evidence, ['local-invocation', 'recorded-task'])
    && optionalText(item.label) && optionalText(item.missionId) && optionalText(item.taskId))) return false;
  if (!(value.missions as unknown[]).every(item => record(item) && identity(item) && typeof item.title === 'string'
    && oneOf(item.state, ['running', 'completed', 'failed', 'cancelled', 'recovering']) && oneOf(item.backend, ['typescript', 'rust', 'unknown'])
    && Array.isArray(item.tasks) && item.tasks.every(task => record(task) && text(task.id) && text(task.taskId) && typeof task.title === 'string' && text(task.state)))) return false;
  if (!(value.blockers as unknown[]).every(item => record(item) && identity(item) && oneOf(item.kind, ['planning', 'preparation', 'mission-recovery'])
    && typeof item.localActive === 'boolean' && oneOf(item.reason, ['local-active', 'inspection-required', 'host-restart', 'execution-uncertain', 'authority-unknown'])
    && optionalText(item.missionId) && optionalText(item.invocationId))) return false;
  return value.recheck === undefined || (record(value.recheck) && oneOf(value.recheck.status, ['checked', 'partial', 'unsupported', 'unavailable']) && ['skippedActive', 'inspected', 'retired', 'retained', 'remaining'].every(key => count((value.recheck as Record<string, unknown>)[key])));
}

export type NativeStatusView = { phase: 'loading' | 'refreshing' | 'ready' | 'unsupported' | 'unavailable' | 'stale'; data?: NativeStatus; error?: 'read' | 'malformed' | 'timeout' | 'changed' };

/** Reject stale callbacks before requesting cancellation; the host verifies the same run id atomically. */
export function cancelNativeStatusOperation(agents: Pick<AgentHostApi, 'cancel'>, current: () => NativeStatusView, sessionId: string, runId: string) {
  const view = current();
  if (view.phase !== 'ready' || !view.data?.active.some(run => run.id === runId && run.sessionId === sessionId)) return false;
  return agents.cancel(sessionId, runId);
}

function unsupportedStatus(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : '').replace(/^Error invoking remote method '[^']*': /, '').replace(/^(?:[A-Z]\w*)?Error: /, '').trim();
  return ['Unknown method.', 'Unknown agent host method.', 'This host does not support this action.'].includes(message);
}

/** One actual transport request at a time, including after timeout. Disposed owners ignore all replies. */
export function createNativeStatusMonitor({ read, onChange, pollMs = 4_000, timeoutMs = 8_000 }: {
  read?: (() => Promise<unknown>) | undefined; onChange(view: NativeStatusView): void; pollMs?: number; timeoutMs?: number;
}) {
  let disposed = false;
  let pending = false;
  let queued = false;
  let revision = 0;
  let data: NativeStatus | undefined;
  let view: NativeStatusView = { phase: read ? 'loading' : 'unsupported' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (next: NativeStatusView) => { view = next; onChange(next); };
  const fail = (error: 'read' | 'malformed' | 'timeout') => emit({ phase: data ? 'stale' : 'unavailable', ...(data ? { data } : {}), error });
  const refresh = (operation = read) => {
    if (disposed || pending || !operation) return false;
    pending = true;
    const startedRevision = revision;
    if (data) emit({ phase: 'refreshing', data });
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; if (!disposed) fail('timeout'); }, timeoutMs);
    void Promise.resolve().then(() => disposed ? undefined : operation()).then(next => {
      if (disposed || timedOut || startedRevision !== revision) return;
      if (!isNativeStatus(next)) { fail('malformed'); return; }
      data = next;
      emit({ phase: 'ready', data });
    }, failure => {
      if (!disposed && !timedOut && startedRevision === revision) {
        if (unsupportedStatus(failure)) emit({ phase: 'unsupported', ...(data ? { data } : {}) });
        else fail('read');
      }
    }).finally(() => {
      clearTimeout(timer); pending = false;
      if (queued && !disposed) { queued = false; refresh(); }
    });
    return true;
  };
  emit(view);
  const interval = read ? setInterval(() => { if (view.phase !== 'unsupported') refresh(); }, pollMs) : undefined;
  refresh();
  return {
    refresh,
    current: () => view,
    invalidate() {
      if (disposed || !read) return;
      revision++;
      if (pending) queued = true;
      emit({ phase: data ? 'stale' : 'loading', ...(data ? { data, error: 'changed' as const } : {}) });
    },
    dispose() { disposed = true; clearInterval(interval); clearTimeout(timer); },
  };
}
