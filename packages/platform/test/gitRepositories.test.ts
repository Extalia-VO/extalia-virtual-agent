import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, normalizeGitRepositoryPath } from '../src/agentHost.js';

describe('workspace-relative Git repository selection', () => {
  it('exposes additive discovery while preserving the empty root selection', () => {
    expect(AGENT_HOST_METHODS).toContain('gitRepositories');
    expect(normalizeGitRepositoryPath(undefined)).toBe('');
    expect(normalizeGitRepositoryPath('')).toBe('');
    for (const value of ['apps/frontend', 'another repo/日本語', 'folder/.github']) expect(normalizeGitRepositoryPath(value)).toBe(value);
  });
  it('rejects absolute, traversal, Git-internal and malformed selections', () => {
    for (const value of [null, 1, {}, [], '/tmp/repo', 'C:/repo', 'C:repo', '\\\\server\\repo', 'apps\\frontend', '.', '..', 'apps/../repo',
      'apps/./repo', 'apps//repo', 'apps/.git', '.GIT/config', 'repo/', ' repo', 'repo ', 'repo\u0000', 'x'.repeat(4097)]) {
      expect(() => normalizeGitRepositoryPath(value)).toThrow('Choose a repository inside the workspace.');
    }
  });
});
