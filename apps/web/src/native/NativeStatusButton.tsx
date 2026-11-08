import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import { NativeStatusPanel, type NativeStatusProps } from './NativeStatusPanel';
import './nativeStatus.css';

/** Shared shell control; closing or changing host/profile unmounts the reader. */
export function NativeStatusButton(props: NativeStatusProps) {
  const { t, agents, state } = props;
  const scope = JSON.stringify([state.profile.id, state.dataDirectory, state.host.kind, state.host.version, state.nativeCore?.core]);
  const [owner, setOwner] = useState<{ agents: typeof agents; scope: string }>();
  if (owner && (owner.agents !== agents || owner.scope !== scope)) setOwner(undefined);
  const open = owner?.agents === agents && owner.scope === scope;
  return <>
    <button type="button" className="icon-button native-status-button" aria-label={t.nativeStatus.button} title={t.nativeStatus.button}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOwner(open ? undefined : { agents, scope })}><Icon name="diagnostics" /></button>
    {open && createPortal(<NativeStatusPanel {...props} key={scope} onClose={() => setOwner(undefined)} />, document.body)}
  </>;
}
