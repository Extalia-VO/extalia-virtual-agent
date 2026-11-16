import { describe, expect, it, vi } from 'vitest';
import { browserFullscreenActive, browserFullscreenAvailable, toggleBrowserFullscreen } from '../src/ui/browserFullscreen';

describe('browser fullscreen', () => {
  it('requests the complete document directly with hidden navigation chrome, then exits', async () => {
    const requestFullscreen = vi.fn(async () => undefined), exitFullscreen = vi.fn(async () => undefined);
    const doc = { documentElement: { requestFullscreen }, fullscreenEnabled: true, fullscreenElement: null, exitFullscreen };
    expect(browserFullscreenAvailable(doc as unknown as Document)).toBe(true);
    const entering = toggleBrowserFullscreen(doc as unknown as Document);
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    await entering;
    const active = { ...doc, fullscreenElement: doc.documentElement };
    expect(browserFullscreenActive(active as unknown as Document)).toBe(true);
    await toggleBrowserFullscreen(active as unknown as Document);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('supports prefixed enter/exit methods without pretending unsupported browsers are fullscreen', async () => {
    const webkitRequestFullscreen = vi.fn(), webkitExitFullscreen = vi.fn();
    const doc = { documentElement: { webkitRequestFullscreen }, webkitFullscreenEnabled: true, webkitExitFullscreen };
    await toggleBrowserFullscreen(doc as unknown as Document);
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
    await toggleBrowserFullscreen({ ...doc, webkitFullscreenElement: doc.documentElement } as unknown as Document);
    expect(webkitExitFullscreen).toHaveBeenCalledOnce();
    const unsupported = { documentElement: {} } as unknown as Document;
    expect(browserFullscreenAvailable(unsupported)).toBe(false);
    await expect(toggleBrowserFullscreen(unsupported)).rejects.toThrow('unavailable');
  });

  it('respects browser policy denial and propagates request rejection for visible feedback', async () => {
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('Denied'));
    const doc = { documentElement: { requestFullscreen }, fullscreenEnabled: false } as unknown as Document;
    expect(browserFullscreenAvailable(doc)).toBe(false);
    await expect(toggleBrowserFullscreen(doc)).rejects.toThrow('unavailable');
    expect(requestFullscreen).not.toHaveBeenCalled();
    await expect(toggleBrowserFullscreen({ ...doc, fullscreenEnabled: true } as unknown as Document)).rejects.toThrow('Denied');
  });
});
