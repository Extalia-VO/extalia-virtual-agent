import { Select } from '../ui/Select';
import type { GitRepositoryList } from '@extalia/platform';
import type { Messages } from '../i18n';

export function GitRepositoryPicker({ t, list, selected, onSelect }: {
  t: Messages; list: GitRepositoryList; selected: string; onSelect: (path: string) => void;
}) {
  if (list.repositories.length === 0 && !list.truncated) return null;
  return <div className="git-repository-tools">
    {list.repositories.length > 0 && <div className="field git-repository-picker"><span>{t.git.repository}</span>
      <Select aria-label={t.git.repository} value={selected} onChange={onSelect}
        options={list.repositories.map(repository => ({ value: repository.path, label: repository.path || t.git.workspaceRoot }))} />
    </div>}
    {list.truncated && <p className="note small" role="status">{t.git.repositoriesTruncated}</p>}
  </div>;
}
