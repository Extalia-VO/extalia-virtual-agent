import { WORKTREE_HOST_METHODS } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreeHostApi } from '../src/service.js';
import { createFileTools } from '../src/tools/files.js';
import { WorktreeError } from '../src/worktrees/git.js';
import { worktreeHostMethods } from '../src/worktrees/hostMethods.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const userError = (message: string) => Object.assign(new Error(message), { name: 'UserError' });

function fake(): { [K in keyof WorktreeHostApi]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => []), status: vi.fn(async () => ({})), diff: vi.fn(async () => ({})), orphans: vi.fn(async () => []),
    remove: vi.fn(async () => undefined), propose: vi.fn(async () => ({})), proposals: vi.fn(async () => []), apply: vi.fn(async () => ({})),
  };
}

describe('renderer worktree methods (ADR 0028)', () => {
  it('validate every argument before the worktree manager or the queue sees it', async () => {
    const api = fake(), methods = worktreeHostMethods(api as unknown as WorktreeHostApi, userError);
    await expect(methods.worktreeStatus('../etc')).rejects.toThrow('Invalid worktree id.');
    await expect(methods.removeWorktree('w-0123456789ab', { fingerprint: 'trust me' })).rejects.toThrow('Invalid discard confirmation.');
    await expect(methods.proposeIntegration('w-0123456789ab', { targetBranch: 'main', gate: { command: '' } })).rejects.toThrow(/test gate/);
    await expect(methods.applyIntegration('i-0123456789ab', { diffDigest: 'latest' })).rejects.toThrow(/diff digest/);
    await expect(methods.applyIntegration('w-0123456789ab', { diffDigest: DIGEST })).rejects.toThrow('Invalid integration proposal id.');
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  it('forward the exact digest and fingerprint, and show only user-safe messages', async () => {
    const api = fake(), methods = worktreeHostMethods(api as unknown as WorktreeHostApi, userError);
    await methods.applyIntegration('i-0123456789ab', { diffDigest: DIGEST });
    expect(api.apply).toHaveBeenCalledWith('i-0123456789ab', { diffDigest: DIGEST });
    await methods.removeWorktree('w-0123456789ab', { fingerprint: DIGEST });
    expect(api.remove).toHaveBeenCalledWith('w-0123456789ab', { fingerprint: DIGEST });
    await methods.removeWorktree('w-0123456789ab');
    expect(api.remove).toHaveBeenLastCalledWith('w-0123456789ab', undefined);
    await methods.proposeIntegration('w-0123456789ab', { targetBranch: 'main', gate: { command: 'pnpm test' } });
    expect(api.propose).toHaveBeenCalledWith('w-0123456789ab', { targetBranch: 'main', gate: { command: 'pnpm test' } });
    api.apply.mockRejectedValueOnce(new WorktreeError('confirmation_mismatch', 'The approval does not match this proposal’s changes.'));
    await expect(methods.applyIntegration('i-0123456789ab', { diffDigest: DIGEST })).rejects.toThrow('The approval does not match');
    api.list.mockRejectedValueOnce(new Error('EACCES /private/path/secret'));
    await expect(methods.listWorktrees()).rejects.toThrow(/^The worktree action failed/);
  });

  it('are never agent tools', () => {
    const names = createFileTools('/tmp').map(tool => tool.name);
    for (const method of WORKTREE_HOST_METHODS) expect(names).not.toContain(method);
    expect(Object.keys(worktreeHostMethods(fake() as unknown as WorktreeHostApi, userError)).sort()).toEqual([...WORKTREE_HOST_METHODS].sort());
  });
});
