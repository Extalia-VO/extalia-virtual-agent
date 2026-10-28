import type { FolderCheck } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { emptyWorkspaceDraft } from '../src/setup/validation';
import { createWorkspaceFolderRequests } from '../src/setup/workspaceFolderRequest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('workspace folder validation races', () => {
  it('merges a delayed validation result into the latest name, runtime and permissions', async () => {
    const requests = createWorkspaceFolderRequests(emptyWorkspaceDraft('initial'));
    const pending = requests.check('/projects/one');
    const response = deferred<FolderCheck>();
    const result = response.promise.then(value => requests.accept(pending.request, value));
    requests.sync({ ...requests.draft(), name: 'Renamed while checking', runtimeId: 'hermes', hermesProfile: 'work', hermesModel: 'provider/model', connectionId: 'updated', permissions: { fileWrite: 'allow', commands: 'allow' }, gateCommand: 'pnpm check' });
    response.resolve({ ok: true, path: '/canonical/one', name: 'one' });
    expect(await result).toMatchObject({ name: 'Renamed while checking', runtimeId: 'hermes', hermesProfile: 'work', hermesModel: 'provider/model', connectionId: 'updated', permissions: { fileWrite: 'allow', commands: 'allow' }, gateCommand: 'pnpm check', folderInput: '/canonical/one', folder: { path: '/canonical/one', name: 'one' } });
  });

  it('ignores an older success and its finalizer while a newer folder is being checked', async () => {
    const requests = createWorkspaceFolderRequests(emptyWorkspaceDraft());
    const first = requests.check('/projects/old');
    const oldResponse = deferred<FolderCheck>();
    let finalized = 0;
    const result = oldResponse.promise.then(value => requests.accept(first.request, value)).finally(() => { if (requests.current(first.request)) finalized++; });
    const second = requests.check('/projects/new');
    oldResponse.resolve({ ok: true, path: '/projects/old', name: 'old' });
    expect(await result).toBeUndefined();
    expect(finalized).toBe(0);
    expect(requests.current(second.request)).toBe(true);
    expect(requests.accept(second.request, { ok: true, path: '/projects/new', name: 'new' })).toMatchObject({ name: 'new', folderInput: '/projects/new' });
  });

  it('invalidates validation errors and finalizers on path edits or an external workspace change', async () => {
    const requests = createWorkspaceFolderRequests(emptyWorkspaceDraft());
    const pending = requests.check('/projects/old');
    const response = deferred<FolderCheck>();
    const errors: string[] = [];
    let finalized = false;
    const result = response.promise.catch(error => { if (requests.current(pending.request)) errors.push(error.message); }).finally(() => { if (requests.current(pending.request)) finalized = true; });
    requests.sync({ ...requests.draft(), folderInput: '/projects/edited', folder: undefined });
    response.reject(new Error('Old folder failed'));
    await result;
    expect(errors).toEqual([]);
    expect(finalized).toBe(false);
    const next = requests.check('/projects/edited');
    requests.sync({ ...requests.draft(), id: 'another-workspace' });
    expect(requests.accept(next.request, { ok: true, path: '/projects/edited' })).toBeUndefined();
  });

  it('discards native picker results and validations after cancellation or unmount, then allows a remount', async () => {
    const requests = createWorkspaceFolderRequests(emptyWorkspaceDraft());
    const selection = requests.begin();
    const chosenPath = deferred<string>();
    const chosen = chosenPath.promise.then(path => requests.current(selection) ? requests.check(path) : undefined);
    requests.invalidate();
    chosenPath.resolve('/projects/too-late');
    expect(await chosen).toBeUndefined();
    expect(requests.current(selection)).toBe(false);
    const pending = requests.check('/projects/one');
    requests.invalidate();
    expect(requests.accept(pending.request, { ok: true, path: '/projects/one' })).toBeUndefined();
    expect(requests.current(pending.request)).toBe(false);
    const remounted = requests.check('/projects/remounted');
    expect(requests.accept(remounted.request, { ok: true, path: '/projects/remounted' })?.folder?.path).toBe('/projects/remounted');
  });

  it('suggests a name only when the original blank or folder-derived name is unchanged', () => {
    const requests = createWorkspaceFolderRequests({ ...emptyWorkspaceDraft(), name: 'old', folderInput: '/old', folder: { name: 'old', path: '/old' } });
    const pending = requests.check('/new');
    expect(requests.accept(pending.request, { ok: true, path: '/new', name: 'new' })?.name).toBe('new');
    const next = requests.check('/third');
    requests.sync({ ...requests.draft(), name: '' });
    expect(requests.accept(next.request, { ok: true, path: '/third', name: 'third' })?.name).toBe('');
  });
});
