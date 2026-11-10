import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindBookPreviewEvents, BOOK_PREVIEW_FADE_MS, bookPreviewPosition, createBookPreviewController, type BookPreviewPoint } from '../src/skills/bookPreviewController';

function harness(reducedMotion = false) {
  const frames = new Map<number, () => void>();
  let serial = 0;
  const controller = createBookPreviewController('catalog-a', {
    request: callback => { frames.set(++serial, callback); return serial; },
    cancel: frame => { frames.delete(frame); },
  }, () => reducedMotion);
  return { controller, frames, flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); } };
}
const point = (id = 'book-a', origin: BookPreviewPoint['origin'] = 'pointer'): BookPreviewPoint => ({ id, clientX: 100, clientY: 150, origin });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Grimoire preview lifecycle', () => {
  it('publishes only the latest cursor position once per frame, then rests', () => {
    const h = harness(), listener = vi.fn();
    h.controller.subscribe(listener);
    for (let clientX = 0; clientX < 100; clientX++) h.controller.show({ ...point(), clientX });
    expect(h.frames.size).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    h.flush();
    expect(h.controller.getSnapshot()?.clientX).toBe(99);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.frames.size).toBe(0);
  });

  it('dismisses until leave or a new book entry, including samples pending on Escape', () => {
    const h = harness();
    h.controller.show(point()); h.controller.dismiss(); h.controller.show(point()); h.flush();
    expect(h.controller.getSnapshot()).toBeNull();
    h.controller.show(point('book-b')); h.flush();
    expect(h.controller.getSnapshot()?.id).toBe('book-b');
    h.controller.dismiss(); h.controller.leave('pointer'); h.controller.show(point('book-b')); h.flush();
    expect(h.controller.getSnapshot()?.id).toBe('book-b');
  });

  it('retains a keyboard preview when the canvas pointer leaves, then fades it on blur', () => {
    const h = harness();
    h.controller.show(point('keyboard-book', 'focus')); h.flush();
    h.controller.leave('pointer');
    expect(h.controller.getSnapshot()?.id).toBe('keyboard-book');
    h.controller.leave('focus');
    expect(h.controller.getSnapshot()).toMatchObject({ id: 'keyboard-book', exiting: true });
    vi.advanceTimersByTime(BOOK_PREVIEW_FADE_MS);
    expect(h.controller.getSnapshot()).toBeNull();
    h.controller.show(point('keyboard-book', 'focus')); h.controller.clear(); h.flush();
    expect(h.controller.getSnapshot()).toBeNull();
    expect(h.frames.size).toBe(0);
  });

  it('clears on scroll/resize/hidden and removes listeners and queued work on unmount', () => {
    const h = harness(), windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), { hidden: false });
    const dispose = bindBookPreviewEvents(h.controller, windowTarget, documentTarget);
    for (const event of ['scroll', 'resize']) {
      h.controller.clear(); h.controller.show(point()); h.flush();
      windowTarget.dispatchEvent(new Event(event));
      expect(h.controller.getSnapshot()).toBeNull();
      h.controller.show(point()); h.flush();
      expect(h.controller.getSnapshot()).toBeNull();
    }
    h.controller.clear(); h.controller.show(point()); h.flush();
    windowTarget.dispatchEvent(new Event('blur'));
    expect(h.controller.getSnapshot()?.exiting).toBe(true);
    vi.advanceTimersByTime(BOOK_PREVIEW_FADE_MS);
    expect(h.controller.getSnapshot()).toBeNull();
    h.controller.clear(); h.controller.show(point()); h.flush();
    documentTarget.hidden = true; documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(h.controller.getSnapshot()).toBeNull();
    h.controller.show(point()); expect(h.frames.size).toBe(1);
    dispose(); h.flush(); expect(h.controller.getSnapshot()).toBeNull();
    h.controller.show(point()); h.flush();
    windowTarget.dispatchEvent(new Event('scroll'));
    expect(h.controller.getSnapshot()?.id).toBe('book-a');
  });

  it('consumes the first Escape only while a preview is visible', () => {
    const h = harness(), windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), { hidden: false });
    const dispose = bindBookPreviewEvents(h.controller, windowTarget, documentTarget);
    const escape = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    h.controller.show(point()); h.flush();
    const first = escape(); windowTarget.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true); expect(h.controller.getSnapshot()?.exiting).toBe(true);
    const second = escape(); windowTarget.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a fixed exiting snapshot for exactly the fade duration without extending on repeated leave', () => {
    const h = harness();
    h.controller.show(point()); h.flush(); h.controller.leave('pointer');
    expect(h.controller.getSnapshot()).toEqual({ ...point(), exiting: true });
    expect(h.frames.size).toBe(0);
    vi.advanceTimersByTime(BOOK_PREVIEW_FADE_MS - 1);
    h.controller.leave('pointer');
    expect(h.controller.getSnapshot()?.exiting).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.controller.getSnapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the old exit when a new entry appears, and clears context changes immediately', () => {
    const h = harness();
    h.controller.show(point()); h.flush(); h.controller.leave('pointer');
    h.controller.show(point('book-b')); h.flush();
    expect(h.controller.getSnapshot()).toEqual({ ...point('book-b'), exiting: false });
    vi.advanceTimersByTime(BOOK_PREVIEW_FADE_MS);
    expect(h.controller.getSnapshot()?.id).toBe('book-b');
    h.controller.leave('pointer'); h.controller.clear();
    expect(h.controller.getSnapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never strands an exit when a rapid reentry leaves again before its frame', () => {
    const h = harness();
    h.controller.show(point()); h.flush(); h.controller.leave('pointer');
    h.controller.show(point()); h.controller.leave('pointer');
    expect(h.frames.size).toBe(0);
    vi.advanceTimersByTime(BOOK_PREVIEW_FADE_MS);
    expect(h.controller.getSnapshot()).toBeNull();
  });

  it('removes previews immediately with reduced motion and cancels pending work on teardown', () => {
    const h = harness(true);
    h.controller.show(point()); h.flush(); h.controller.leave('pointer');
    expect(h.controller.getSnapshot()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    h.controller.show(point()); h.flush(); h.controller.dismiss();
    expect(h.controller.getSnapshot()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    h.controller.show(point()); h.controller.clear(); h.flush();
    expect(h.controller.getSnapshot()).toBeNull(); expect(h.frames.size).toBe(0);
  });
});

describe('Grimoire preview viewport boundaries', () => {
  const size = { width: 240, height: 80 }, viewport = { width: 800, height: 600 };
  it('offsets from the cursor and flips at right/bottom boundaries', () => {
    expect(bookPreviewPosition({ clientX: 100, clientY: 100 }, size, viewport)).toEqual({ x: 118, y: 118 });
    expect(bookPreviewPosition({ clientX: 790, clientY: 590 }, size, viewport)).toEqual({ x: 532, y: 492 });
  });
  it('clamps near corners and on narrow phone viewports', () => {
    expect(bookPreviewPosition({ clientX: 0, clientY: 0 }, size, viewport)).toEqual({ x: 18, y: 18 });
    const narrow = bookPreviewPosition({ clientX: 160, clientY: 170 }, { width: 296, height: 100 }, { width: 320, height: 200 });
    expect(narrow).toEqual({ x: 12, y: 52 });
  });
});
