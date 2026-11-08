import type { AgentHostApi, ImportCandidate, ImportLocation, ImportScan } from '@extalia/platform';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';

export const LIVE_SELECTION_LIMIT = 10;
export type DiscoveryPurpose = 'observe' | 'import';

export function nativeSelectableIds(candidates: readonly ImportCandidate[], purpose: DiscoveryPurpose): string[] {
  return candidates.filter(item => item.supported && (purpose !== 'observe' || !item.ignored)).map(item => item.id);
}

/** A host-bound lease rejects duplicate actions and late completions after host replacement/unmount. */
export function createOperationScope() {
  let active = true, generation = 0;
  let pending: symbol | undefined;
  const capture = () => {
    const started = generation;
    return { isCurrent: () => active && generation === started };
  };
  return {
    activate() { if (!active) { active = true; generation++; } },
    dispose() { active = false; generation++; pending = undefined; },
    capture,
    acquire() {
      if (!active || pending) return undefined;
      const token = Symbol();
      pending = token;
      return { ...capture(), release() { if (pending === token) pending = undefined; } };
    },
  };
}

export function useOperationScope(agents: AgentHostApi) {
  const scope = useMemo(() => ({ ...createOperationScope(), owner: agents }), [agents]);
  useEffect(() => { scope.activate(); return () => scope.dispose(); }, [scope]);
  return scope;
}

type DiscoveryState = {
  locations: ImportLocation[] | null;
  locationsChosen: ReadonlySet<string>;
  scan: ImportScan | null;
  selected: ReadonlySet<string>;
  query: string;
  consent: boolean;
  scanning: boolean;
  error: string | null;
};
const empty = (): DiscoveryState => ({ locations: null, locationsChosen: new Set(), scan: null, selected: new Set(), query: '', consent: false, scanning: false, error: null });

/** Discovery reads metadata only. Transcript access is an explicit page-owned action. */
export function useNativeDiscovery(agents: AgentHostApi, purpose: DiscoveryPurpose) {
  const scope = useOperationScope(agents);
  const [stored, setStored] = useState<DiscoveryState & { scope: typeof scope }>(() => ({ ...empty(), scope }));
  const state = stored.scope === scope ? stored : { ...empty(), scope };
  const update = (patch: Partial<DiscoveryState>) => setStored(previous => ({ ...(previous.scope === scope ? previous : { ...empty(), scope }), ...patch }));

  useEffect(() => {
    const lease = scope.capture();
    agents.importLocations().then(locations => {
      if (!lease.isCurrent()) return;
      setStored({ ...empty(), scope, locations, locationsChosen: new Set(locations.filter(item => item.available && item.supported).map(item => item.id)) });
    }, failure => {
      if (lease.isCurrent()) setStored({ ...empty(), scope, locations: [], error: errorMessage(failure) });
    });
  }, [agents, scope]);

  async function startScan() {
    if (!state.locationsChosen.size) return;
    const lease = scope.acquire();
    if (!lease) return;
    update({ scanning: true, error: null });
    try {
      const scan = await agents.scanImports([...state.locationsChosen]);
      if (lease.isCurrent()) update({ scan, selected: new Set(), query: '', consent: false });
    } catch (failure) {
      if (lease.isCurrent()) update({ error: errorMessage(failure) });
    } finally {
      if (lease.isCurrent()) update({ scanning: false });
      lease.release();
    }
  }

  const choose = (ids: readonly string[], checked: boolean) => {
    if (!state.scan) return;
    const eligible = new Set(nativeSelectableIds(state.scan.sessions, purpose));
    const selected = new Set(state.selected);
    for (const id of ids) { if (checked && eligible.has(id)) selected.add(id); else selected.delete(id); }
    update({ selected, consent: false });
  };
  return { ...state, scope, update, choose, startScan };
}

export type NativeDiscovery = ReturnType<typeof useNativeDiscovery>;
