import type { AgentHostApi, DirectoryPickerOptions, FileSystemCapability } from '@extalia/platform';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { DirectoryBrowser } from './DirectoryBrowser';

/** Native Desktop chooser; Bridge browsing supplies real host paths without guessing browser handles. */
export function DirectoryPickerButton({ t, agents, picker, initialPath, purpose, title, label, disabled = false, scopeKey, onSelected }: {
  t: Messages; agents: AgentHostApi; picker?: FileSystemCapability | undefined; initialPath?: string | undefined;
  purpose?: DirectoryPickerOptions['purpose']; title: string; label: string; disabled?: boolean; scopeKey?: string;
  onSelected(path: string): void | Promise<void>;
}) {
  const [browsing, setBrowsing] = useState<object | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<{ context: object; message: string }>();
  const identity = useMemo(() => ({ agents, picker, initialPath, purpose, disabled, scopeKey }), [agents, picker, initialPath, purpose, disabled, scopeKey]);
  const committed = useRef(identity);
  const sequence = useRef(0);
  const pending = useRef(false);
  const live = useRef(true);
  const selected = useRef(onSelected);
  useLayoutEffect(() => {
    committed.current = identity; selected.current = onSelected;
  }, [identity, onSelected]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      sequence.current++; // eslint-disable-line react-hooks/exhaustive-deps -- invalidates request IDs, not a DOM ref
    };
  }, []);
  const current = (context: object, request: number) => live.current && committed.current === context && sequence.current === request;
  const choose = async () => {
    if (disabled || pending.current) return;
    const context = identity, request = ++sequence.current;
    pending.current = true; setPicking(true); setError(undefined);
    try {
      if (!picker) { setBrowsing(context); return; }
      const result = await picker.selectDirectory({ title, ...(purpose ? { purpose } : {}), ...(initialPath ? { initialPath } : {}) });
      if (!current(context, request)) return;
      if (result?.path) await selected.current(result.path);
      else if (result) setBrowsing(context);
    } catch (failure) { if (current(context, request)) setError({ context, message: errorMessage(failure) }); }
    finally { pending.current = false; if (live.current) setPicking(false); }
  };
  return <>
    <button type="button" className="button small" disabled={disabled || picking} onClick={() => void choose()}><Icon name="folder" />{label}</button>
    {browsing === identity && !disabled && <DirectoryBrowser key={scopeKey} t={t} title={title} agents={agents} {...(initialPath ? { startPath: initialPath } : {})}
      onClose={() => setBrowsing(null)} onSelect={path => {
        setBrowsing(null);
        if (live.current && committed.current === identity) void Promise.resolve().then(() => { if (live.current && committed.current === identity) return selected.current(path); }).catch(failure => {
          if (live.current && committed.current === identity) setError({ context: identity, message: errorMessage(failure) });
        });
      }} />}
    {error?.context === identity && <p className="form-error" role="alert">{error.message}</p>}
  </>;
}
