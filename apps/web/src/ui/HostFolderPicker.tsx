import type { AgentHostApi, FileSystemCapability } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { DirectoryBrowser } from '../setup/DirectoryBrowser';
import { Icon } from './Icon';

type Props = {
  t: Messages; agents: AgentHostApi; picker?: FileSystemCapability | undefined; startPath?: string | undefined;
  disabled?: boolean | undefined; label?: string | undefined; title?: string | undefined;
  onSelect(path: string): void | Promise<void>; onBusyChange?(busy: boolean): void;
};

/** Select a host path on either Desktop or Web; browser directory handles are not host paths. */
export function HostFolderPicker(props: Props) {
  const [scope, setScope] = useState({ agents: props.agents, picker: props.picker, disabled: props.disabled, path: props.startPath, key: 0 });
  const changed = scope.agents !== props.agents || scope.picker !== props.picker || scope.disabled !== props.disabled || scope.path !== props.startPath;
  const key = scope.key + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, picker: props.picker, disabled: props.disabled, path: props.startPath, key });
  return <FolderPicker key={key} {...props} />;
}

function FolderPicker({ t, agents, picker, startPath, disabled, label, title, onSelect, onBusyChange }: Props) {
  const owner = useRef({ active: true, busy: false });
  const [picking, setPicking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { const current = owner.current; current.active = true; return () => { current.active = false; }; }, []);
  useEffect(() => { onBusyChange?.(picking); return () => onBusyChange?.(false); }, [picking, onBusyChange]);
  const finish = () => {
    owner.current.busy = false;
    if (owner.current.active) { setPicking(false); setBrowsing(false); }
  };
  const commit = async (path: string) => {
    if (!owner.current.active || disabled) return;
    setBrowsing(false);
    try { await onSelect(path); }
    catch (failure) { if (owner.current.active) setError(errorMessage(failure)); }
    finally { finish(); }
  };
  const choose = async () => {
    if (!owner.current.active || owner.current.busy || disabled) return;
    owner.current.busy = true; setPicking(true); setError(undefined);
    if (!picker) { setBrowsing(true); return; }
    try {
      const selected = await picker.selectDirectory();
      if (!owner.current.active) return;
      if (!selected) finish();
      else if (selected.path?.trim()) await commit(selected.path);
      else setBrowsing(true);
    } catch (failure) {
      if (owner.current.active) setError(errorMessage(failure));
      finish();
    }
  };
  return <>
    <button type="button" className="button small" disabled={disabled || picking} aria-busy={picking || undefined} onClick={() => void choose()}><Icon name="folder" />{label ?? t.knowledgeVault.choose}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    {browsing && <DirectoryBrowser t={t} agents={agents} title={title ?? t.knowledgeVault.folderOptions} {...(startPath ? { startPath } : {})}
      onSelect={path => { void commit(path); }} onClose={finish} />}
  </>;
}
