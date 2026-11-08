import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';

export interface Loaded<T> { value?: T; error?: string; loading: boolean }

/**
 * Load a host value for `key` (null loads nothing). A new `version` reloads
 * the same key and keeps showing the previous result until the new one arrives.
 * An optional owner isolates results when the host connection changes.
 */
export function useLoad<T>(key: string | null, version: number, load: () => Promise<T>, owner?: unknown): Loaded<T> {
  const [result, setResult] = useState<{ key: string; version: number; owner: unknown; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let active = true;
    load().then(
      value => { if (active) setResult({ key, version, owner, value }); },
      failure => { if (active) setResult({ key, version, owner, error: errorMessage(failure) }); },
    );
    return () => { active = false; };
    // `load` is a new closure on every render; `key`, `version` and `owner` identify what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, owner]);
  const current = key !== null && result?.key === key && result.owner === owner ? result : undefined;
  return {
    ...(current && 'value' in current ? { value: current.value as T } : {}),
    ...(current?.error ? { error: current.error } : {}),
    loading: key !== null && (!current || current.version !== version),
  };
}
