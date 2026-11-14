import { EFFORTS, RUNTIME_IDS, type Effort } from '@extalia/core';
import { isModelId, type AgentHostApi, type ModelChoices } from '@extalia/platform';

export const OBSERVED_MODEL_CHOICES_POLL_MS = 10_000;
export const OBSERVED_MODEL_CHOICES_LIMIT = 2000;

export interface ObservedModelChoicesView {
  phase: 'loading' | 'ready' | 'unavailable' | 'unsupported';
  refreshing: boolean;
  choices?: ModelChoices;
}

/** Copy only the bounded catalog fields used by the observed prompt pickers. */
export function validateObservedModelChoices(value: ModelChoices): ModelChoices {
  if (!value || !RUNTIME_IDS.includes(value.runtime)
    || !Array.isArray(value.models) || value.models.length > OBSERVED_MODEL_CHOICES_LIMIT || !value.models.every(isModelId)
    || !Array.isArray(value.efforts) || value.efforts.length > EFFORTS.length || !value.efforts.every(effort => EFFORTS.includes(effort))
    || value.defaultModel !== undefined && !isModelId(value.defaultModel)
    || value.defaultEffort !== undefined && !EFFORTS.includes(value.defaultEffort)) throw new Error('Invalid source model choices');
  const modelEffortsEntries: Array<[string, Effort[]]> = [];
  if (value.modelEfforts !== undefined) {
    if (!value.modelEfforts || typeof value.modelEfforts !== 'object' || Array.isArray(value.modelEfforts)) {
      throw new Error('Invalid source model choices');
    }
    for (const [model, levels] of Object.entries(value.modelEfforts).slice(0, OBSERVED_MODEL_CHOICES_LIMIT)) {
      if (!isModelId(model) || !Array.isArray(levels) || levels.length > EFFORTS.length || !levels.every(effort => EFFORTS.includes(effort))) {
        throw new Error('Invalid source model choices');
      }
      modelEffortsEntries.push([model, [...new Set(levels)]]);
    }
  }
  const selection = value.observedSelection;
  if (selection && (typeof selection.canSetSettings !== 'boolean'
    || selection.model !== undefined && !isModelId(selection.model)
    || selection.effort !== undefined && !EFFORTS.includes(selection.effort)
    || selection.connectionId !== undefined && (typeof selection.connectionId !== 'string' || !selection.connectionId || selection.connectionId.length > 256)
    || selection.settingsRevision !== undefined && (!Number.isSafeInteger(selection.settingsRevision) || selection.settingsRevision < 0)
    || selection.uncertain !== undefined && typeof selection.uncertain !== 'boolean'
    || selection.canSetSettings && (!selection.connectionId || selection.settingsRevision === undefined || selection.uncertain))) throw new Error('Invalid observed settings');
  return { runtime: value.runtime, models: [...new Set(value.models)], efforts: [...new Set(value.efforts)],
    ...(modelEffortsEntries.length ? { modelEfforts: Object.fromEntries(modelEffortsEntries) } : {}),
    ...(selection ? { observedSelection: { canSetSettings: selection.canSetSettings,
      ...(selection.model ? { model: selection.model } : {}), ...(selection.effort ? { effort: selection.effort } : {}),
      ...(selection.connectionId ? { connectionId: selection.connectionId } : {}),
      ...(selection.settingsRevision !== undefined ? { settingsRevision: selection.settingsRevision } : {}),
      ...(selection.uncertain ? { uncertain: true } : {}) } } : {}),
    ...(value.defaultModel !== undefined ? { defaultModel: value.defaultModel } : {}),
    ...(value.defaultEffort !== undefined ? { defaultEffort: value.defaultEffort } : {}) };
}

/** Owns read-only picker snapshots for one host capability and observed session. */
export function createObservedModelChoicesControl(api: Pick<AgentHostApi, 'modelChoices'>, sessionId: string) {
  const read = typeof api.modelChoices === 'function' ? api.modelChoices : undefined;
  let view: ObservedModelChoicesView = { phase: read ? 'loading' : 'unsupported', refreshing: false };
  let active = false, disabled = false, visible = true, epoch = 0, reading = false, refreshPending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const enabled = () => active && !disabled && visible;
  const bound = () => api.modelChoices === read;
  const emptyView = (): ObservedModelChoicesView => ({ phase: !read ? 'unsupported' : bound() ? 'loading' : 'unavailable', refreshing: false });
  const update = (next: ObservedModelChoicesView) => { view = next; listeners.forEach(listener => listener()); };
  function clearTimer() { clearInterval(timer); timer = undefined; }
  function schedule() {
    clearTimer();
    if (enabled() && read && bound()) timer = setInterval(() => { void refresh(); }, OBSERVED_MODEL_CHOICES_POLL_MS);
  }
  function invalidate() {
    ++epoch; refreshPending = false; clearTimer(); update(emptyView());
  }
  async function refresh(): Promise<void> {
    if (!enabled() || !read) return;
    if (!bound()) { invalidate(); return; }
    if (reading) return;
    const generation = epoch;
    reading = true;
    update({ ...view, refreshing: true });
    try {
      const result = await read.call(api, '', sessionId);
      if (!enabled() || generation !== epoch) return;
      if (!bound()) { invalidate(); return; }
      update({ phase: 'ready', choices: validateObservedModelChoices(result), refreshing: false });
    } catch {
      if (enabled() && generation === epoch) update({ phase: 'unavailable', refreshing: false });
    } finally {
      reading = false;
      if (refreshPending && enabled()) {
        refreshPending = false;
        void refresh();
      }
    }
  }
  function resume() {
    schedule();
    if (reading) refreshPending = enabled();
    else void refresh();
  }
  return {
    hasCapability: !!read,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      if (!active) { active = true; resume(); }
      return () => { active = false; invalidate(); };
    },
    refresh,
    /** Call when actual source model/effort evidence changes, not on unrelated session updates. */
    invalidateSource(): Promise<void> {
      invalidate();
      if (!enabled() || !read) return Promise.resolve();
      const settled = new Promise<void>(resolve => {
        const listener = () => {
          if (!enabled() || !bound() || view.phase !== 'loading') { listeners.delete(listener); resolve(); }
        };
        listeners.add(listener);
      });
      resume();
      return settled;
    },
    setDisabled(next: boolean) {
      if (disabled === next) return;
      disabled = next; invalidate(); resume();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next; invalidate(); resume();
    },
  };
}
export type ObservedModelChoicesControl = ReturnType<typeof createObservedModelChoicesControl>;
