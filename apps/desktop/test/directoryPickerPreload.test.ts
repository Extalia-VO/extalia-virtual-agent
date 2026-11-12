import type { DesktopHostApi, DirectoryPickerOptions } from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../src/ipc';

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('native directory picker preload boundary', () => {
  it('forwards optional presentation hints over the audited channel and preserves native cancellation', async () => {
    mocks.invoke.mockResolvedValue(null);
    await import('../src/preload');
    const api = mocks.expose.mock.calls[0]![1] as DesktopHostApi;
    const options: DirectoryPickerOptions = { title: 'Choose a knowledge folder', initialPath: '/tmp/example-vault', purpose: 'knowledge-vault' };
    expect(await api.selectDirectory(options)).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC.selectDirectory, options);
    mocks.invoke.mockClear();
    expect(await api.selectDirectory()).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC.selectDirectory, undefined);
  });
});
