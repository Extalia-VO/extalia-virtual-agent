import { describe, expect, it } from 'vitest';
import { PORTRAIT_FRAME_MS, portraitFrameInterval } from '../src/office/overlay/portrait3d/model';

describe('shared portrait CSS-size cadence', () => {
  it('uses ten frames per second only when every visible target is a small thumbnail', () => {
    expect(portraitFrameInterval([{ width: 36, height: 42 }, { width: 64, height: 64 }])).toBe(100);
    expect(portraitFrameInterval([{ width: 44, height: 56 }])).toBe(100);
  });
  it('keeps fifteen frames per second whenever a large portrait is visible', () => {
    expect(portraitFrameInterval([{ width: 36, height: 42 }, { width: 192, height: 224 }])).toBe(PORTRAIT_FRAME_MS);
    expect(portraitFrameInterval([{ width: 65, height: 32 }])).toBe(PORTRAIT_FRAME_MS);
    expect(portraitFrameInterval([{ width: 32, height: 65 }])).toBe(PORTRAIT_FRAME_MS);
  });
  it('defaults to full cadence for no visible targets or an unmeasured target', () => {
    expect(portraitFrameInterval([])).toBe(PORTRAIT_FRAME_MS);
    expect(portraitFrameInterval([{ width: NaN, height: 30 }])).toBe(PORTRAIT_FRAME_MS);
    // Hidden canvases are not included: an offscreen dialog cannot raise the
    // cadence of its remaining visible board thumbnail.
    const targets = [{ width: 192, height: 224, visible: false }, { width: 44, height: 48, visible: true }];
    expect(portraitFrameInterval(targets.filter(target => target.visible))).toBe(100);
  });
});
