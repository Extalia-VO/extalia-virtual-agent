import type { GitRepositoryList } from '@extalia/platform';

/** Prefer the workspace root, then the host's deterministic first nested repository. */
export function selectedGitRepository(list: GitRepositoryList | undefined, requested: string | null): string {
  const paths = list?.repositories.map(repository => repository.path) ?? [];
  if (requested !== null && paths.includes(requested)) return requested;
  return paths.includes('') ? '' : paths[0] ?? '';
}
