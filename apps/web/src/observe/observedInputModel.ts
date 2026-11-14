import type { AgentHostApi, ObservedUserInputRequest, ObservedUserInputStatus, SessionSummary } from '@extalia/platform';

export interface ObservedInputEntry {
  source: string;
  phase: 'loading' | 'ready' | 'unavailable' | 'private';
  requests: ObservedUserInputRequest[];
  baselined: boolean;
}
export interface ObservedInputDraft { choices: Record<string, string>; texts: Record<string, string> }
export interface ObservedInputView {
  entries: Record<string, ObservedInputEntry>;
  drafts: Record<string, ObservedInputDraft>;
  busy?: string;
  uncertain: ReadonlySet<string>;
}
export const observedInputKey = (sessionId: string, source: string, request: Pick<ObservedUserInputRequest, 'id' | 'revision'>) => JSON.stringify([sessionId, source, request.id, request.revision]);
export const observedInputSource = (session: SessionSummary) => JSON.stringify([session.observation?.sourceId, session.observation?.nativeSessionId]);
export function watchedInputSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter(session => session.control === 'observed' && session.observation?.sourceId === 'codex'
    && session.observation.watching && session.observation.status === 'watching').slice(0, 32);
}
export function observedInputAnswers(request: ObservedUserInputRequest, draft?: ObservedInputDraft): Record<string, string> {
  return Object.fromEntries(request.questions.map(question => [question.id, question.options.length === 0 || draft?.choices[question.id] === 'other'
    ? draft?.texts[question.id] ?? '' : question.options[Number(draft?.choices[question.id] ?? -1)] ?? '']));
}
export function validObservedInput(value: ObservedUserInputStatus, sessionId: string): boolean {
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32_000;
  if (!value || value.sessionId !== sessionId || !['ready', 'unavailable', 'private'].includes(value.state) || !Array.isArray(value.requests) || value.requests.length > 32) return false;
  const ids = new Set<string>();
  return value.requests.every(request => {
    if (!request || !text(request.id) || ids.has(request.id) || !text(request.revision) || !['codex-async', 'codex-native'].includes(request.origin)
      || !['pending', 'queued', 'submitted', 'unknown'].includes(request.state) || typeof request.canAnswer !== 'boolean'
      || request.deliveryRoute !== undefined && !['native-answer', 'native-steer', 'native-start', 'queue'].includes(request.deliveryRoute)
      || request.identityVerified !== undefined && typeof request.identityVerified !== 'boolean'
      || request.identityVerified === false && request.canAnswer
      || !Array.isArray(request.questions) || !request.questions.length || request.questions.length > 32) return false;
    ids.add(request.id); const questionIds = new Set<string>();
    return request.questions.every(question => {
      if (!question || !text(question.id) || questionIds.has(question.id) || typeof question.title !== 'string' || question.title.length > 32_000
        || typeof question.allowOther !== 'boolean' || typeof question.isSecret !== 'boolean' || !Array.isArray(question.options)
        || question.options.length > 64 || !question.options.every(text)
        || (question.optionDescriptions !== undefined && (!Array.isArray(question.optionDescriptions)
          || question.optionDescriptions.length !== question.options.length
          || !question.optionDescriptions.every(description => typeof description === 'string' && description.length <= 8192)))) return false;
      questionIds.add(question.id); return true;
    });
  });
}

// The physical read limit also covers an old provider whose transport is still settling.
let reading = 0;
let answering = false;
const readQueue: Array<() => void> = [];
function boundedRead(operation: () => Promise<void>): Promise<void> {
  return new Promise(resolve => {
    const run = () => {
      reading++;
      void operation().finally(() => { reading--; resolve(); readQueue.shift()?.(); });
    };
    if (reading < 2) run(); else readQueue.push(run);
  });
}

/** One UI owner for all watched sessions, drafts and explicit answer dispatch. */
export function createObservedInputControl(agents: AgentHostApi | undefined) {
  const read = agents?.observedUserInputStatus, send = agents?.answerObservedUserInput;
  let view: ObservedInputView = { entries: {}, drafts: {}, uncertain: new Set() };
  let active = false, generation = 0, round: Promise<void> | undefined, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sources = new Map<string, string>();
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const receipts = new Map<string, ObservedUserInputRequest['state']>();
  const binding = () => agents?.observedUserInputStatus === read && agents?.answerObservedUserInput === send;
  function update(next: ObservedInputView) { view = next; listeners.forEach(listener => listener()); }
  function mask(entry: ObservedInputEntry, phase: 'unavailable' | 'private'): ObservedInputEntry {
    return { ...entry, phase, requests: phase === 'private' ? [] : entry.requests.map(request => ({ ...request, canAnswer: false })) };
  }
  function receive(id: string, status: ObservedUserInputStatus) {
    if (!validObservedInput(status, id)) throw new Error('Invalid observed input status');
    const old = view.entries[id]; if (!old) return;
    if (status.state === 'private') versions.set(id, (versions.get(id) ?? 0) + 1);
    const entry = status.state === 'ready' ? { ...old, phase: 'ready' as const, baselined: true, requests: status.requests.map(request => {
      const receipt = receipts.get(observedInputKey(id, old.source, request));
      return receipt && request.state === 'pending' ? { ...request, state: receipt, canAnswer: false } : { ...request, canAnswer: !!send && request.canAnswer };
    }) }
      : mask(old, status.state);
    const allowed = new Set(entry.requests.map(request => observedInputKey(id, entry.source, request)));
    const drafts = Object.fromEntries(Object.entries(view.drafts).filter(([key]) => {
      const owner = JSON.parse(key) as string[]; return owner[0] !== id || allowed.has(key);
    }));
    // A turn finishing can change the delivery handle while the user types.
    // Keep only an unsubmitted draft for the exact same source and questions;
    // submission still requires the freshly advertised revision.
    if (status.state === 'ready') for (const request of entry.requests) {
      const previous = old.requests.find(item => item.id === request.id);
      if (!previous || previous.origin !== 'codex-async' || request.origin !== previous.origin
        || !previous.deliveryRoute || !request.deliveryRoute || previous.identityVerified === false || request.identityVerified === false
        || previous.state !== 'pending' || request.state !== 'pending' || JSON.stringify(previous.questions) !== JSON.stringify(request.questions)) continue;
      const before = observedInputKey(id, old.source, previous), after = observedInputKey(id, entry.source, request);
      if (before !== after && view.drafts[before] && !view.uncertain.has(before) && view.busy !== before) drafts[after] = view.drafts[before];
    }
    update({ ...view, entries: { ...view.entries, [id]: entry }, drafts });
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (active && read && sources.size) timer = setTimeout(() => { void refresh(); }, 2_000);
  }
  function refresh(): Promise<void> {
    if (!active || !read) return Promise.resolve();
    if (!binding()) {
      generation++;
      update({ ...view, entries: Object.fromEntries(Object.entries(view.entries).map(([id, entry]) => [id, mask(entry, 'unavailable')])) });
      return Promise.resolve();
    }
    if (round) { again = true; return round; }
    const epoch = generation;
    const entries = [...sources];
    round = Promise.all(entries.map(([id, source]) => boundedRead(async () => {
      if (!active || epoch !== generation || !binding() || sources.get(id) !== source) return;
      const version = versions.get(id) ?? 0;
      try {
        const result = await read.call(agents, id);
        if (active && epoch === generation && binding() && sources.get(id) === source && (versions.get(id) ?? 0) === version) receive(id, result);
      } catch {
        if (active && epoch === generation && binding() && sources.get(id) === source && (versions.get(id) ?? 0) === version && view.entries[id]) {
          update({ ...view, entries: { ...view.entries, [id]: mask(view.entries[id]!, 'unavailable') } });
        }
      }
    }))).then(() => undefined).finally(() => {
      round = undefined;
      if (active && again) { again = false; void refresh(); } else schedule();
    });
    return round;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    setSessions(sessions: readonly SessionSummary[]) {
      const next = new Map(watchedInputSessions(sessions).map(session => [session.id, observedInputSource(session)]));
      if (JSON.stringify([...next]) === JSON.stringify([...sources])) return;
      for (const id of new Set([...sources.keys(), ...next.keys()])) {
        if (sources.get(id) !== next.get(id)) versions.set(id, (versions.get(id) ?? 0) + 1);
      }
      generation++; sources = next;
      const entries = Object.fromEntries([...sources].map(([id, source]) => [id, view.entries[id]?.source === source ? view.entries[id]!
        : { source, phase: read ? 'loading' as const : 'unavailable' as const, requests: [], baselined: false }]));
      const drafts = Object.fromEntries(Object.entries(view.drafts).filter(([key]) => {
        const [id, source] = JSON.parse(key) as string[]; return id !== undefined && sources.get(id) === source;
      }));
      update({ ...view, entries, drafts });
      if (active) void refresh();
    },
    start() { active = true; void refresh(); return () => {
      active = false; generation++;
      for (const id of sources.keys()) versions.set(id, (versions.get(id) ?? 0) + 1);
      if (timer) clearTimeout(timer);
      update({ entries: {}, drafts: {}, uncertain: new Set() }); sources = new Map();
    }; },
    refresh,
    setDraft(key: string, draft: ObservedInputDraft) {
      if (!Object.entries(view.entries).some(([id, entry]) => entry.requests.some(request => observedInputKey(id, entry.source, request) === key))) return;
      update({ ...view, drafts: { ...view.drafts, [key]: draft } });
    },
    async answer(sessionId: string, request: ObservedUserInputRequest) {
      const entry = view.entries[sessionId];
      if (!active || !send || !binding() || answering || view.busy || entry?.phase !== 'ready' || sources.get(sessionId) !== entry.source) return;
      const current = entry.requests.find(candidate => candidate.id === request.id && candidate.revision === request.revision);
      const key = observedInputKey(sessionId, entry.source, request);
      if (!current || current.state !== 'pending' || !current.canAnswer || view.uncertain.has(key)) return;
      const answers = observedInputAnswers(current, view.drafts[key]);
      if (current.questions.some(question => !answers[question.id]?.trim() || (question.options.length && !question.allowOther && !question.options.includes(answers[question.id]!)))) return;
      const version = (versions.get(sessionId) ?? 0) + 1; versions.set(sessionId, version);
      answering = true;
      update({ ...view, busy: key });
      try {
        const status = await send.call(agents, sessionId, { requestId: current.id, revision: current.revision, answers });
        if (!active || !binding() || sources.get(sessionId) !== entry.source || versions.get(sessionId) !== version) {
          if (active) update({ ...view, uncertain: new Set(view.uncertain).add(key) });
          return;
        }
        if (validObservedInput(status, sessionId)) {
          const result = status.requests.find(item => item.id === current.id && item.revision === current.revision);
          if (result && result.state !== 'pending') receipts.set(key, result.state);
        }
        receive(sessionId, status);
        // A receipt alone never means consumed. A pending/absent response cannot authorize an automatic retry.
        const result = status.requests.find(item => item.id === current.id && item.revision === current.revision);
        if (status.state !== 'ready' || !result || result.state === 'pending' || result.state === 'unknown') {
          update({ ...view, uncertain: new Set(view.uncertain).add(key) });
        }
      } catch {
        if (active && binding() && sources.get(sessionId) === entry.source && versions.get(sessionId) === version) update({ ...view, uncertain: new Set(view.uncertain).add(key),
          entries: { ...view.entries, [sessionId]: mask(view.entries[sessionId]!, 'unavailable') } });
      } finally {
        answering = false;
        if (active && view.busy === key) update({ ...view, busy: undefined });
        if (active) void refresh();
      }
    },
  };
}
export type ObservedInputControl = ReturnType<typeof createObservedInputControl>;

/** Startup baselines and revision identities contain no question or answer text. */
export function createObservedInputNoticeTracker() {
  const seen = new Set<string>(), baselined = new Set<string>();
  return (entries: ObservedInputView['entries']) => {
    const fresh: Array<{ kind: 'observed-input'; sessionId: string; requestId: string }> = [];
    for (const [sessionId, entry] of Object.entries(entries)) {
      if (entry.phase !== 'ready') continue;
      const source = JSON.stringify([sessionId, entry.source]), baseline = baselined.has(source);
      for (const request of entry.requests) {
        const key = observedInputKey(sessionId, entry.source, request);
        if (seen.has(key)) continue;
        seen.add(key);
        if (baseline && request.identityVerified !== false && request.state === 'pending') fresh.push({ kind: 'observed-input', sessionId, requestId: request.id });
      }
      baselined.add(source);
    }
    return fresh;
  };
}
