import type { AgentHostApi, ObservedCodexApprovalDecision, ObservedCodexApprovalRequest, ObservedCodexInputRequest, ObservedCodexStatus } from '@extalia/platform';

export interface ObservedCodexView {
  phase: 'loading' | 'ready' | 'unsupported' | 'error';
  status?: ObservedCodexStatus;
  busy?: 'connect' | 'disconnect' | 'send' | 'answer' | 'approve';
  draft: string;
}

/** Transport data is untrusted even when an older host exposes the method name. */
function validStatus(status: ObservedCodexStatus, sessionId: string): boolean {
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (!status || status.sessionId !== sessionId || !['connected', 'disconnected', 'unavailable'].includes(status.state)
    || typeof status.canSend !== 'boolean' || typeof status.canAnswer !== 'boolean' || !Array.isArray(status.requests)
    || (status.state === 'connected' && (!text(status.connectionId) || !text(status.threadId)))
    || (status.activeTurnId !== undefined && !text(status.activeTurnId))
    || (status.problem !== undefined && typeof status.problem !== 'string')
    || (status.canApprove !== undefined && typeof status.canApprove !== 'boolean')
    || (status.approvals !== undefined && (!Array.isArray(status.approvals) || status.approvals.length > 32 || !status.approvals.every(approval => {
      if (!approval || !text(approval.id) || !text(approval.turnId) || !text(approval.itemId) || !['pending', 'submitted'].includes(approval.state)
        || !Array.isArray(approval.availableDecisions) || !approval.availableDecisions.length || approval.availableDecisions.some(decision => !['accept', 'decline', 'cancel'].includes(decision))) return false;
      if (approval.kind === 'commandExecution') return ['command', 'writeStdin', 'humanCommand'].includes(approval.commandKind)
        && (typeof approval.command === 'string' || !!approval.networkApprovalContext || !!approval.commandActions?.length);
      if (approval.kind === 'fileChange') return Array.isArray(approval.changes) && approval.changes.length > 0
        && approval.changes.every(change => change && text(change.path) && typeof change.diff === 'string' && ['add', 'update', 'delete'].includes(change.kind?.type));
      return approval.kind === 'permissions' && approval.scope === 'turn' && !!approval.permissions && typeof approval.permissions === 'object'
        && approval.availableDecisions.every(decision => decision !== 'cancel');
    })))
    || (status.delivery !== undefined && !['submitted', 'resolved', 'unknown'].includes(status.delivery))) return false;
  const requestIds = new Set<string>();
  return status.requests.every(request => {
    if (!request || !text(request.id) || requestIds.has(request.id) || !text(request.turnId) || !text(request.itemId)
      || !['pending', 'submitted'].includes(request.state) || !Array.isArray(request.questions)) return false;
    requestIds.add(request.id);
    const questionIds = new Set<string>();
    return request.questions.every(question => {
      if (!question || !text(question.id) || questionIds.has(question.id) || typeof question.header !== 'string' || typeof question.question !== 'string'
        || typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean' || !Array.isArray(question.options)) return false;
      questionIds.add(question.id);
      return question.options.every(option => !!option && text(option.label) && typeof option.description === 'string');
    });
  });
}

/** A session-bound owner: mutations invalidate reads and disposal invalidates every response. */
export function createObservedCodexControl(agents: AgentHostApi, sessionId: string) {
  const supported = !!(agents.observedCodexStatus && agents.connectObservedCodex && agents.disconnectObservedCodex
    && agents.sendObservedCodexMessage && agents.answerObservedCodexInput);
  let view: ObservedCodexView = { phase: supported ? 'loading' : 'unsupported', draft: '' };
  let active = false;
  let epoch = 0;
  let reading = false;
  let draftGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const submitted = new Set<string>();
  const listeners = new Set<() => void>();
  const requestKey = (connectionId: string, request: { id: string }) => `${connectionId}:${request.id}`;
  function update(next: ObservedCodexView) {
    view = next;
    if (active && view.status?.state === 'connected') {
      timer ??= setInterval(() => { void refresh(); }, 2_000);
    } else if (timer !== undefined) {
      clearInterval(timer); timer = undefined;
    }
    listeners.forEach(listener => listener());
  }
  function receive(status: ObservedCodexStatus) {
    // A foreign/malformed status must never enable controls for this session.
    if (!validStatus(status, sessionId)) throw new Error('Invalid observed Codex status');
    const connected = status.state === 'connected';
    const requests = connected ? status.requests.map(request => submitted.has(requestKey(status.connectionId!, request))
      ? { ...request, state: 'submitted' as const } : request) : [];
    const approvals = connected ? (status.approvals ?? []).map(request => submitted.has(requestKey(status.connectionId!, request))
      ? { ...request, state: 'submitted' as const } : request) : [];
    update({ ...view, phase: 'ready', busy: undefined, status: { ...status, requests, approvals,
      canApprove: connected && !!status.canApprove && !!agents.answerObservedCodexApproval,
      canSend: connected && status.canSend, canAnswer: connected && status.canAnswer } });
  }
  async function refresh() {
    if (!active || !supported || view.busy || reading) return;
    reading = true;
    const generation = ++epoch;
    try {
      const status = await agents.observedCodexStatus!(sessionId);
      if (active && generation === epoch) receive(status);
    } catch {
      if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: undefined });
    } finally {
      if (generation === epoch) reading = false;
    }
  }
  async function mutate(action: NonNullable<ObservedCodexView['busy']>, operation: () => Promise<ObservedCodexStatus>, after?: (status: ObservedCodexStatus) => void) {
    if (!active || !supported || view.busy) return;
    const generation = ++epoch;
    reading = false;
    update({ ...view, busy: action });
    try {
      const status = await operation();
      if (!active || generation !== epoch) return;
      // Validate before clearing any draft or recording a submitted answer.
      receive(status);
      after?.(status);
    } catch {
      if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: undefined });
    }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() { active = true; void refresh(); return () => {
      active = false; ++epoch; reading = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    }; },
    refresh,
    setDraft(draft: string) { ++draftGeneration; update({ ...view, draft }); },
    connect(socketPath: string) {
      if (!socketPath.trim() || view.status?.state === 'connected') return Promise.resolve();
      return mutate('connect', () => agents.connectObservedCodex!(sessionId, socketPath.trim()));
    },
    disconnect() {
      const connectionId = view.status?.connectionId;
      if (!connectionId || view.status?.state !== 'connected') return Promise.resolve();
      return mutate('disconnect', () => agents.disconnectObservedCodex!(sessionId, connectionId));
    },
    send() {
      const status = view.status;
      if (status?.state !== 'connected' || !status.canSend || !status.connectionId || !view.draft.trim()) return Promise.resolve();
      const draft = view.draft;
      const generation = draftGeneration;
      return mutate('send', () => agents.sendObservedCodexMessage!(sessionId, {
        connectionId: status.connectionId!, text: draft, ...(status.activeTurnId ? { activeTurnId: status.activeTurnId } : {}),
      }), result => {
        if (result.state === 'connected' && result.connectionId === status.connectionId && result.delivery !== 'unknown' && draftGeneration === generation) update({ ...view, draft: '' });
      });
    },
    answer(request: ObservedCodexInputRequest, answers: Record<string, string>) {
      const status = view.status;
      const current = status?.requests.find(candidate => candidate.id === request.id);
      if (status?.state !== 'connected' || !status.canAnswer || !status.connectionId || !current || current.state !== 'pending'
        || JSON.stringify(current) !== JSON.stringify(request) || submitted.has(requestKey(status.connectionId, request))
        || !request.questions.length || request.questions.some(question => !answers[question.id]?.trim()
          || (question.options.length > 0 && !question.isOther && !question.options.some(option => option.label === answers[question.id])))) return Promise.resolve();
      const key = requestKey(status.connectionId, request);
      return mutate('answer', () => agents.answerObservedCodexInput!(sessionId, {
        connectionId: status.connectionId!, requestId: request.id, answers,
      }), result => {
        if (result.state !== 'connected' || result.connectionId !== status.connectionId || result.delivery === 'unknown') return;
        submitted.add(key);
        if (view.status) receive(view.status);
      });
    },
    approve(request: ObservedCodexApprovalRequest, decision: ObservedCodexApprovalDecision) {
      const status = view.status, current = status?.approvals?.find(candidate => candidate.id === request.id);
      if (status?.state !== 'connected' || !status.canApprove || !status.connectionId || !current || current.state !== 'pending'
        || JSON.stringify(current) !== JSON.stringify(request) || !current.availableDecisions.includes(decision)
        || submitted.has(requestKey(status.connectionId, request))) return Promise.resolve();
      const key = requestKey(status.connectionId, request);
      return mutate('approve', () => agents.answerObservedCodexApproval!(sessionId, { connectionId: status.connectionId!, requestId: request.id, decision }), result => {
        if (result.state !== 'connected' || result.connectionId !== status.connectionId || result.delivery === 'unknown') return;
        submitted.add(key); if (view.status) receive(view.status);
      });
    },
  };
}
export type ObservedCodexControl = ReturnType<typeof createObservedCodexControl>;
