import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { Select } from '../src/ui/Select';
import { GitRepositoryPicker } from '../src/inspect/GitRepositoryPicker';
import { selectedGitRepository } from '../src/inspect/gitRepositories';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe('Git repository selection', () => {
  const nested = { repositories: [{ path: 'apps/frontend' }, { path: 'services/api' }], truncated: false };
  it('automatically selects a child when the workspace itself has no repository', () => {
    expect(selectedGitRepository(nested, null)).toBe('apps/frontend');
    expect(selectedGitRepository(nested, 'services/api')).toBe('services/api');
  });
  it('preserves the workspace scope when it is a repository or belongs to a parent repository', () => {
    expect(selectedGitRepository({ ...nested, repositories: [...nested.repositories, { path: '' }] }, null)).toBe('');
  });
  it('recovers a removed selection without retaining a stale repository path', () => {
    expect(selectedGitRepository(nested, 'removed')).toBe('apps/frontend');
    expect(selectedGitRepository({ repositories: [], truncated: false }, 'services/api')).toBe('');
    expect(selectedGitRepository(undefined, null)).toBe('');
  });
  for (const language of ['en', 'id'] as const) it(`labels relative repositories and scan limits in ${language}`, () => {
    const t = MESSAGES[language], onSelect = vi.fn();
    const tree = GitRepositoryPicker({ t, list: { repositories: [{ path: '' }, { path: 'apps/<literal>' }], truncated: true }, selected: '', onSelect });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(`aria-label="${t.git.repository}"`);
    expect(html).toContain(t.git.workspaceRoot);
    expect(html).toContain(t.git.repositoriesTruncated);
    const select = elements(tree).find(element => element.type === Select)!;
    expect(select.props.value).toBe('');
    expect(select.props.options).toEqual([{ value: '', label: t.git.workspaceRoot }, { value: 'apps/<literal>', label: 'apps/<literal>' }]);
    const literal = renderToStaticMarkup(createElement(GitRepositoryPicker, { t, list: { repositories: [{ path: 'apps/<literal>' }], truncated: false }, selected: 'apps/<literal>', onSelect }));
    expect(literal).toContain('apps/&lt;literal&gt;');
    expect(literal).not.toContain('apps/<literal>');
    (select.props.onChange as (value: string) => void)('apps/<literal>');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('apps/<literal>');
    (select.props.onChange as (value: string) => void)('');
    expect(onSelect).toHaveBeenLastCalledWith('');
  });
  it('does not render an empty chooser, but keeps incomplete-scan feedback', () => {
    expect(GitRepositoryPicker({ t: MESSAGES.en, list: { repositories: [], truncated: false }, selected: '', onSelect: () => undefined })).toBeNull();
    expect(renderToStaticMarkup(createElement(GitRepositoryPicker, { t: MESSAGES.en, list: { repositories: [], truncated: true }, selected: '', onSelect: () => undefined }))).toContain(MESSAGES.en.git.repositoriesTruncated);
  });
});
