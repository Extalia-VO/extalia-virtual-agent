import type { HostState } from '@extalia/platform';
import type { ReactNode } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';

/** Workspace choice and refresh for the Files and Git pages. */
export function WorkspaceBar({ t, state, workspaceId, loading, onWorkspace, onRefresh, children }: {
  t: Messages;
  state: HostState;
  workspaceId: string;
  loading: boolean;
  onWorkspace: (id: string) => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const workspace = state.workspaces.find(item => item.id === workspaceId);
  const options = state.workspaces.map(item => ({
    value: item.id,
    label: item.name,
    description: item.projectLocation,
    icon: 'folder' as const
  }));

  return (
    <section className="card inspect-bar">
      <div className="field inspect-workspace">
        <span>{t.inspect.workspace}</span>
        <Select
          value={workspaceId}
          options={options}
          onChange={onWorkspace}
          aria-label={t.inspect.workspace}
        />
      </div>
      {workspace?.projectLocation && <code className="inspect-location" title={workspace.projectLocation}>{workspace.projectLocation}</code>}
      {children}
      <button type="button" className="button small inspect-refresh" disabled={loading} onClick={onRefresh}>
        <Icon name="refresh" className={loading ? 'spin' : ''} />{t.inspect.refresh}
      </button>
    </section>
  );
}
