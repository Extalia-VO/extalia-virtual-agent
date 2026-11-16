import type { HostState, VaultProfile, VaultProfilesCatalog } from '@extalia/platform';
import { useId, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { CopyButton } from '../ui/CopyButton';
import './knowledgeContext.css';

export interface KnowledgeVaultContextProps {
  t: Messages;
  workspaces?: HostState['workspaces'] | undefined;
  workspaceId?: string | undefined;
  onWorkspace?: ((id: string) => void) | undefined;
  catalog?: VaultProfilesCatalog | undefined;
  profile?: VaultProfile | undefined;
  error?: string | undefined;
  loading: boolean;
  scoped: boolean;
  locked: boolean;
  stale?: boolean | undefined;
  configurable?: boolean | undefined;
  onRefresh(): void;
  configuration: ReactNode;
}

/** Describe only the host-confirmed binding; a friendly index label is not a filesystem path. */
export function KnowledgeVaultContext({ t, workspaces, workspaceId, onWorkspace, catalog, profile, error, loading, scoped, locked, stale, configurable = true, onRefresh, configuration }: KnowledgeVaultContextProps) {
  const k = t.knowledgeContext, id = useId();
  const verified = Boolean(profile && !error && !loading && scoped);
  const others = profile?.workspaceIds.filter(value => value !== workspaceId)
    .map(value => catalog?.workspaces.find(workspace => workspace.id === value)?.name ?? value) ?? [];
  return <section className="card knowledge-connection" aria-labelledby={`${id}-title`}>
    <div className="knowledge-connection-heading">
      <h2 id={`${id}-title`}><Icon name="files" />{k.title}</h2>
      {verified && <span className="badge subtle">{profile!.name}</span>}
    </div>
    {!!workspaces?.length && <div className="knowledge-connection-workspace" data-workspace-id={workspaceId}>
      <Select label={k.workspace} placeholder={k.workspace} value={workspaceId ?? ''} disabled={locked || !onWorkspace}
        onChange={value => onWorkspace?.(value)}
        options={workspaces.map(workspace => ({ value: workspace.id, label: workspace.name, icon: 'folder' as const }))} />
    </div>}
    {!workspaces?.length && <p className="muted small">{k.defaultScope}</p>}
    {verified ? <>
      <dl className="knowledge-connection-location"><div><dt>{stale ? k.previousLocation : k.location}</dt><dd>
        <div className="knowledge-folder-location"><code>{profile!.root}</code><CopyButton text={profile!.root} label={stale ? k.previousLocation : k.location} /></div>
      </dd></div></dl>
      {!stale && <p className="muted small knowledge-connection-browse">{k.browseHint}</p>}
      {!stale && others.length > 0 && <p className="knowledge-connection-shared"><Icon name="users" />{k.shared(others.join(', '))}</p>}
      {configurable && !stale && <details className="knowledge-connection-config">
        <summary aria-disabled={locked || undefined}>{k.configure}</summary>
        {configuration}
        <p className="muted small">{k.manageHint}</p>
      </details>}
    </> : <div className="knowledge-connection-pending">
      <p className={error || !scoped ? 'form-error' : 'muted small'} role={error || !scoped ? 'alert' : 'status'}>
        {!scoped ? k.unsupported : loading ? k.loading : k.unavailable}
      </p>
      {error && <p className="muted small">{error}</p>}
      {!loading && scoped && <button type="button" className="button small" onClick={onRefresh}><Icon name="refresh" />{k.refresh}</button>}
    </div>}
    {locked && !stale && <p className="muted small knowledge-connection-lock" role="status">{k.locked}</p>}
  </section>;
}
