import type { HostState } from '@extalia/platform';
import type { ReactNode } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

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
  return (
    <section className="card inspect-bar">
      <label className="field inspect-workspace">
        <span>{t.inspect.workspace}</span>
        <select value={workspaceId} onChange={event => onWorkspace(event.target.value)}>
          {state.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {workspace?.projectLocation && <code className="inspect-location" title={workspace.projectLocation}>{workspace.projectLocation}</code>}
      {children}
      <button type="button" className="button small inspect-refresh" disabled={loading} onClick={onRefresh}>
        <Icon name="refresh" className={loading ? 'spin' : ''} />{t.inspect.refresh}
      </button>
    </section>
  );
}
