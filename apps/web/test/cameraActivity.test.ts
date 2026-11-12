import { describe, expect, it, vi } from 'vitest';
import { subscribeCameraActivity } from '../src/office/useCameraDirector';

const pointer = (type: string, pointerId = 1, buttons = 0) => Object.assign(new Event(type), { pointerId, buttons });

describe('automatic camera interaction ownership', () => {
  it('ignores passive pointer hover while clicks, dragging, keys and scrolling take control', () => {
    const target = new EventTarget(), document = new EventTarget(), interact = vi.fn(), held = vi.fn();
    const stop = subscribeCameraActivity(target, document, interact, held);
    for (let move = 0; move < 20; move++) target.dispatchEvent(pointer('pointermove'));
    expect(interact).not.toHaveBeenCalled();
    target.dispatchEvent(pointer('pointerdown', 1, 1));
    expect(held).toHaveBeenLastCalledWith(true);
    target.dispatchEvent(pointer('pointermove', 1, 1));
    target.dispatchEvent(pointer('pointerup'));
    expect(held).toHaveBeenLastCalledWith(false);
    target.dispatchEvent(new Event('wheel'));
    target.dispatchEvent(new Event('keydown'));
    expect(interact).toHaveBeenCalledTimes(5);
    stop();
    target.dispatchEvent(new Event('keydown')); document.dispatchEvent(new Event('visibilitychange'));
    expect(interact).toHaveBeenCalledTimes(5);
  });

  it('keeps a multi-pointer gesture suspended until its last pointer releases', () => {
    const target = new EventTarget(), document = new EventTarget(), held = vi.fn();
    const stop = subscribeCameraActivity(target, document, () => undefined, held);
    target.dispatchEvent(pointer('pointerdown', 1, 1));
    target.dispatchEvent(pointer('pointerdown', 2, 1));
    target.dispatchEvent(pointer('pointerup', 1));
    expect(held).toHaveBeenLastCalledWith(true);
    target.dispatchEvent(pointer('pointercancel', 2));
    expect(held).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('clears a held gesture on blur and visibility changes without leaving an old pointer suspended', () => {
    const target = new EventTarget(), document = new EventTarget(), held = vi.fn(), interact = vi.fn();
    const stop = subscribeCameraActivity(target, document, interact, held);
    target.dispatchEvent(pointer('pointerdown', 1, 1));
    target.dispatchEvent(new Event('blur'));
    expect(held).toHaveBeenLastCalledWith(false);
    const afterBlur = interact.mock.calls.length;
    target.dispatchEvent(pointer('pointermove'));
    expect(interact).toHaveBeenCalledTimes(afterBlur);
    target.dispatchEvent(pointer('pointerdown', 2, 1));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(held).toHaveBeenLastCalledWith(false);
    stop();
  });
});
