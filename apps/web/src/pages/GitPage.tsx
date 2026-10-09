import type { AgentHostApi, GitChange, GitDiff, HostState } from '@extalia/platform';
import { useMemo, useState } from 'react';
import type { Messages } from '../i18n';
import { changeBadge, diffStats, initialWorkspace, parseDiff } from '../inspect/format';
import { useLoad, type Loaded } from '../inspect/useLoad';
import { WorkspaceBar } from '../inspect/WorkspaceBar';
import { Icon } from '../ui/Icon';

/** The selection that shows every change at once. */
const ALL = '';

function describeChange(t: Messages, change: GitChange): string {
  if (change.untracked) return t.git.states.untracked;
  if (change.conflicted) return t.git.states.unmerged;
  return [
    change.index !== 'unmodified' ? t.git.staged(t.git.states[change.index]) : '',
    change.worktree !== 'unmodified' ? t.git.unstaged(t.git.states[change.worktree]) : '',
  ].filter(Boolean).join(' · ');
}

function splitPath(value: string): { name: string; folder: string } {
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const cut = trimmed.lastIndexOf('/');
  return { name: `${trimmed.slice(cut + 1)}${value.endsWith('/') ? '/' : ''}`, folder: cut > 0 ? trimmed.slice(0, cut) : '' };
}

function DiffViewer({ t, title, change, diff, onClose }: { t: Messages; title: string; change?: GitChange; diff: Loaded<GitDiff>; onClose: () => void }) {
  const lines = useMemo(() => parseDiff(diff.value?.diff ?? ''), [diff.value]);
  const stats = diffStats(lines);
  return (
    <article className="card history-viewer inspect-viewer" aria-labelledby="diff-title">
      <button type="button" className="button small back-to-list" onClick={onClose}><Icon name="chevron" className="flip" />{t.inspect.backToList}</button>
      <header className="viewer-head">
        <h2 id="diff-title" className="viewer-title">{change ? <code>{title}</code> : title}</h2>
        {diff.value && lines.length > 0 && (
          <span className="diff-stats" aria-label={t.git.stats(stats.additions, stats.deletions)}>
            <span className="diff-plus">+{stats.additions}</span> <span className="diff-minus">−{stats.deletions}</span>
          </span>
        )}
      </header>
      {change?.credential ? <p className="note"><Icon name="key" />{t.git.credential}</p>
        : diff.error ? <p className="form-error" role="alert"><Icon name="alert" />{diff.error}</p>
          : !diff.value ? <p className="muted" role="status">{t.common.loading}</p>
            : !lines.length ? <p className="muted">{t.git.noDiff}</p>
              : (
                <>
                  <pre className="diff-view" tabIndex={0} role="region" aria-label={title}>
                    {lines.map((line, index) => <span key={index} className={`diff-line diff-${line.kind}`}>{line.text || ' '}</span>)}
                  </pre>
                  {diff.value.truncated && <p className="note">{t.git.diffTruncated}</p>}
                </>
              )}
    </article>
  );
}

/** Branch, changed files and diffs of a workspace's Git repository (read-only). */
export function GitPage({ t, agents, state, workspaceId }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  /** The workspace selected in Chat, if any. */
  workspaceId?: string;
}) {
  const [workspace, setWorkspace] = useState(() => initialWorkspace(state, workspaceId));
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const status = useLoad(workspace ?? null, version, () => agents.gitStatus(workspace!));
  const repo = status.value?.repository ? status.value : undefined;
  const change = repo?.changes.find(item => item.path === selected);
  const diffKey = workspace && selected !== null && !change?.credential ? `${workspace}\n${selected}` : null;
  const diff = useLoad(diffKey, version, () => agents.gitDiff(workspace!, selected === ALL ? undefined : selected!));

  const header = (
    <header className="page-header">
      <h1>{t.git.title}</h1>
      <p className="lead">{t.git.lead}</p>
    </header>
  );
  if (!workspace) return <div className="page">{header}<section className="card"><p className="muted">{t.inspect.noWorkspace}</p></section></div>;

  const head = repo ? repo.branch ?? (repo.commit ? t.git.detached(repo.commit) : '') : '';
  let body;
  if (status.error) body = <section className="card"><p className="form-error" role="alert"><Icon name="alert" />{status.error}</p></section>;
  else if (!status.value) body = <section className="card"><p className="muted" role="status">{t.common.loading}</p></section>;
  else if (!repo) {
    body = (
      <section className="card empty-state">
        <Icon name="git" className="empty-icon" />
        <p><strong>{t.git.notRepo}</strong></p>
        <p className="muted">{t.git.notRepoHint}</p>
      </section>
    );
  } else if (!repo.changes.length) {
    body = <section className="card empty-state"><p className="status ok"><Icon name="check" />{t.git.clean}</p></section>;
  } else {
    body = (
      <div className={`history inspect ${selected !== null ? 'has-selection' : ''}`}>
        <section className="card history-list inspect-list" aria-label={t.git.changes(repo.changes.length)}>
          <p className="side-heading">{t.git.changes(repo.changes.length)}</p>
          <ul className="tree-list">
            <li>
              <button type="button" className="tree-item" aria-current={selected === ALL ? 'true' : undefined} onClick={() => setSelected(ALL)}>
                <Icon name="git" /><span className="tree-name">{t.git.allChanges}</span>
              </button>
            </li>
            {repo.changes.map(item => {
              const badge = changeBadge(item);
              const { name, folder } = splitPath(item.path);
              const label = describeChange(t, item);
              return (
                <li key={item.path}>
                  <button type="button" className="tree-item change-item" aria-current={selected === item.path ? 'true' : undefined} title={`${item.path}\n${label}`} onClick={() => setSelected(item.path)}>
                    <span className={`change-badge ${badge.tone}`} aria-label={label}>{badge.letter}</span>
                    <span className="change-path">
                      <span className="tree-name">{name}</span>
                      {(folder || item.originalPath) && (
                        <span className="tree-meta">{[folder, item.originalPath ? t.git.renamedFrom(item.originalPath) : ''].filter(Boolean).join(' · ')}</span>
                      )}
                    </span>
                    {item.credential && <Icon name="key" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {repo.truncated && <p className="muted small">{t.git.listTruncated}</p>}
        </section>
        {selected !== null
          ? <DiffViewer t={t} title={selected === ALL ? t.git.allChanges : selected} {...(change ? { change } : {})} diff={diff} onClose={() => setSelected(null)} />
          : <section className="card history-viewer placeholder"><p className="muted">{t.git.select}</p></section>}
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      <WorkspaceBar t={t} state={state} workspaceId={workspace} loading={status.loading || diff.loading}
        onWorkspace={id => { setWorkspace(id); setSelected(null); }} onRefresh={() => setVersion(value => value + 1)}>
        {repo && (
          <p className="git-summary">
            <Icon name="git" />
            <strong className="git-branch">{head}</strong>
            {!repo.commit && <span className="badge">{t.git.noCommits}</span>}
            <span className="muted">{repo.upstream ? t.git.upstream(repo.upstream) : t.git.noUpstream}</span>
            {repo.upstream && (
              <span className="git-ahead-behind" title={t.git.aheadBehind(repo.ahead, repo.behind)}>
                <span aria-hidden="true">↑{repo.ahead} ↓{repo.behind}</span><span className="visually-hidden">{t.git.aheadBehind(repo.ahead, repo.behind)}</span>
              </span>
            )}
          </p>
        )}
      </WorkspaceBar>
      {body}
    </div>
  );
}
