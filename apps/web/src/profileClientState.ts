import type { AgentHostApi, ProfileClientState, UserProfilePatch } from '@extalia/platform';

type ClientPatch = NonNullable<UserProfilePatch['clientState']>;
type Field = keyof ProfileClientState;
type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CLIENT_STATE_KEYS = {
  lastWorkspaceId: 'extalia.landing.v2',
  officeLights: 'extalia.office.lights',
  approvalNotifications: 'extalia.approvalNotifications',
  earlierOpen: 'extalia.office.earlierOpen',
} as const satisfies Record<Field, string>;
const LEGACY_LANDING_KEY = 'extalia.mode.v1';
const fields = Object.keys(CLIENT_STATE_KEYS) as Field[];
const fieldFor = (key: string): Field | undefined => fields.find(field => CLIENT_STATE_KEYS[field] === key);
const browserStorage = (): CacheStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

function valid(field: Field, value: unknown): boolean {
  if (field === 'lastWorkspaceId') return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
  if (field === 'officeLights') return value === 'auto' || value === 'on' || value === 'off';
  if (field === 'approvalNotifications') return value === 'on' || value === 'off';
  return value === '0' || value === '1';
}
function encode(field: Field, value: string): string {
  return field === 'lastWorkspaceId' ? JSON.stringify({ workspaceId: value }) : value;
}
function decode(field: Field, value: string): string | undefined {
  if (field === 'lastWorkspaceId') {
    try {
      const raw: unknown = JSON.parse(value);
      const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).workspaceId : undefined;
      return valid(field, id) ? id as string : undefined;
    } catch { return undefined; }
  }
  return valid(field, value) ? value : undefined;
}

export interface ProfileClientBinding {
  hydrate(value: ProfileClientState | undefined): void;
  /** Wait for admitted saves; primarily useful for deterministic callers and tests. */
  flush(): Promise<void>;
  /** Drop queued work; a save already entered on its original host may still settle. */
  dispose(): void;
}

/** Host-backed settings with a browser cache only; the static build keeps device storage. */
export function createProfileClientStateStore(cache: () => CacheStorage | undefined = browserStorage) {
  const listeners = new Set<() => void>();
  const fallback = new Map<string, string>();
  interface Binding {
    save: AgentHostApi['saveProfile']; active: boolean; hydrated: boolean;
    state: ProfileClientState; pending: ClientPatch; running?: Promise<void>; warned: boolean;
  }
  let bound: Binding | undefined;
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* A view observer cannot change persistence authority. */ } } };
  const mirror = (key: string, value: string | null) => {
    if (value === null) fallback.delete(key); else fallback.set(key, value);
    try { const target = cache(); if (value === null) target?.removeItem(key); else target?.setItem(key, value); } catch { /* A cache failure never changes host authority. */ }
  };
  const isCurrent = (binding: Binding) => bound === binding && binding.active;
  const drain = (binding: Binding): Promise<void> => {
    if (binding.running) return binding.running;
    const run = Promise.resolve().then(async () => {
      while (isCurrent(binding) && binding.hydrated && Object.keys(binding.pending).length) {
        const patch = binding.pending; binding.pending = {};
        try { await binding.save({ clientState: patch }); }
        catch {
          // No implicit retry into a replaced/deleted host. Report a bounded,
          // content-free warning; a later explicit change can save again.
          if (isCurrent(binding) && !binding.warned) {
            binding.warned = true;
            console.warn('Extalia could not save interface state to the profile.');
          }
        }
      }
    });
    binding.running = run;
    void run.finally(() => {
      if (binding.running === run) binding.running = undefined;
      if (isCurrent(binding) && binding.hydrated && Object.keys(binding.pending).length) void drain(binding);
    });
    return run;
  };
  function change(field: Field, value: string | null): void {
    const binding = bound;
    if (!binding || !binding.hydrated || !isCurrent(binding)) return;
    if ((binding.state[field] ?? null) === value) return;
    if (value === null) delete binding.state[field];
    else (binding.state as Record<Field, string>)[field] = value;
    (binding.pending as Record<Field, string | null>)[field] = value;
    mirror(CLIENT_STATE_KEYS[field], value === null ? null : encode(field, value));
    notify();
    void drain(binding);
  }
  const storage: CacheStorage = {
    getItem(key) {
      if (bound) {
        const field = fieldFor(key), value = field ? bound.state[field] : undefined;
        return field && value !== undefined ? encode(field, value) : null;
      }
      try { const target = cache(); return target ? target.getItem(key) : fallback.get(key) ?? null; } catch { return fallback.get(key) ?? null; }
    },
    setItem(key, value) {
      if (bound) {
        const field = fieldFor(key);
        if (!field) return;
        const parsed = decode(field, value);
        if (parsed !== undefined) change(field, parsed);
        // `{}` is the existing landing-memory representation of no workspace.
        else if (field === 'lastWorkspaceId' && value === '{}') change(field, null);
      } else { mirror(key, value); notify(); }
    },
    removeItem(key) {
      if (bound) { const field = fieldFor(key); if (field) change(field, null); }
      else { mirror(key, null); notify(); }
    },
  };
  return {
    storage,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attach(save: AgentHostApi['saveProfile']): ProfileClientBinding {
      if (bound) { bound.active = false; bound.pending = {}; }
      const binding: Binding = { save, active: true, hydrated: false, state: {}, pending: {}, warned: false };
      bound = binding;
      notify();
      return {
        hydrate(value) {
          if (!isCurrent(binding)) return;
          const state: ProfileClientState = {};
          for (const field of fields) {
            const entry = value?.[field];
            if (valid(field, entry)) (state as Record<Field, string>)[field] = entry!;
          }
          binding.state = state; binding.hydrated = true;
          for (const field of fields) {
            const entry = state[field];
            mirror(CLIENT_STATE_KEYS[field], entry === undefined ? null : encode(field, entry));
          }
          mirror(LEGACY_LANDING_KEY, null);
          notify();
        },
        flush: () => drain(binding),
        dispose() {
          binding.active = false; binding.pending = {};
          if (bound === binding) { bound = undefined; notify(); }
        },
      };
    },
  };
}

const clientState = createProfileClientStateStore();
export const profileClientStateStorage = clientState.storage;
export const subscribeProfileClientState = clientState.subscribe;
export const attachProfileClientState = clientState.attach;
