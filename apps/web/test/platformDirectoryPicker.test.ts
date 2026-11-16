import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_HOST_GLOBAL } from '@extalia/platform';
import { resolvePlatform } from '../src/platform';

afterEach(() => vi.unstubAllGlobals());
function browser(token?: string) {
  const select = vi.fn(async () => ({ name: 'Chosen folder' }));
  const surface: Record<string, unknown> = { showDirectoryPicker: select };
  vi.stubGlobal('window', surface);
  vi.stubGlobal('navigator', { userAgent: 'Example Linux browser' });
  vi.stubGlobal('location', { search: '', reload: vi.fn() });
  vi.stubGlobal('document', { querySelector: () => token ? { content: token } : null });
  vi.stubGlobal('__APP_VERSION__', 'test');
  return { surface, select };
}

describe('folder picker composition', () => {
  it('forwards localized hints and a chosen native path through Desktop', async () => {
    const f = browser(), result = { name: 'Example', path: '/projects/example' };
    const native = vi.fn(async () => result);
    f.surface[DESKTOP_HOST_GLOBAL] = { info: async () => ({ kind: 'desktop', appVersion: 'test', os: 'macos' }), selectDirectory: native };
    const platform = await resolvePlatform();
    const options = { purpose: 'knowledge-vault' as const, title: 'Pilih folder vault Knowledge', initialPath: '/projects/notes' };
    expect(await platform.capabilities.filesystem!.selectDirectory(options)).toBe(result);
    expect(native).toHaveBeenCalledWith(options);
    expect(f.select).not.toHaveBeenCalled();
  });

  it('uses the authenticated Bridge folder browser without opening a pathless browser picker first', async () => {
    const f = browser('synthetic-token');
    const platform = await resolvePlatform();
    expect(platform.capabilities.agents?.browseDirectories).toBeTypeOf('function');
    expect(platform.capabilities.filesystem).toBeUndefined();
    expect(f.select).not.toHaveBeenCalled();
  });

  it('retains a browser-only selection without inventing a host path', async () => {
    const f = browser(), platform = await resolvePlatform();
    expect(await platform.capabilities.filesystem!.selectDirectory()).toEqual({ name: 'Chosen folder' });
    expect(f.select).toHaveBeenCalledWith({ mode: 'read' });
    expect(platform.capabilities.agents).toBeUndefined();
  });
});
