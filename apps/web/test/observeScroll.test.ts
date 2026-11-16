import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObserveScroll } from '../src/observe/observeScroll';

class Panel extends EventTarget {
  scrollHeight = 2000;
  clientHeight = 400;
  scrollTop = 0;
  hidden = false;
  children: Element[] = [];
  messages: { id: string; top: number; height: number }[] = [];
  anchorReads = 0;
  getBoundingClientRect() { return { top: 100 }; }
  querySelectorAll() {
    return this.messages.map(message => ({
      dataset: { transcriptId: message.id },
      getBoundingClientRect: () => {
        this.anchorReads++;
        return { top: 100 + message.top - this.scrollTop, bottom: 100 + message.top + message.height - this.scrollTop };
      },
    }));
  }
  element() { return this as unknown as HTMLElement; }
  scroll(top: number) { this.scrollTop = top; this.dispatchEvent(new Event('scroll')); }
  wheel(deltaY: number) { this.dispatchEvent(Object.assign(new Event('wheel'), { deltaY })); }
}

const resizes: TestResizeObserver[] = [];
const mutations: TestMutationObserver[] = [];
class TestResizeObserver {
  observed = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: () => void) { resizes.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
}
class TestMutationObserver {
  disconnected = false;
  constructor(readonly callback: () => void) { mutations.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
}
beforeEach(() => {
  vi.useFakeTimers();
  resizes.length = 0; mutations.length = 0;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('MutationObserver', TestMutationObserver);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function mounted() {
  const changed = vi.fn();
  const controller = createObserveScroll({ onPinnedChange: changed });
  const panel = new Panel();
  controller.update({ sessionKey: 'session', contentReady: true });
  controller.mountPanel(panel.element());
  return { controller, panel, changed };
}

describe('Observe viewport intent', () => {
  it('follows same-ID streaming growth through content resize and DOM mutation', () => {
    const { panel, controller } = mounted();
    expect(panel.scrollTop).toBe(1600);
    panel.scrollHeight = 2500;
    resizes[0]!.callback();
    expect(panel.scrollTop).toBe(2100);
    panel.scrollHeight = 2700;
    mutations[0]!.callback();
    expect(panel.scrollTop).toBe(2300);
    controller.dispose();
  });

  it('retains bottom intent when a failed refresh clears content, then recovers', () => {
    const { panel, controller, changed } = mounted();
    controller.update({ sessionKey: 'session', contentReady: false });
    panel.scrollHeight = 100;
    panel.scroll(0); // Browser clamps the viewport after private history is removed.
    expect(changed).not.toHaveBeenCalled();
    panel.scrollHeight = 3000;
    controller.update({ sessionKey: 'session', contentReady: true });
    expect(panel.scrollTop).toBe(2600);
    controller.dispose();
  });

  it('preserves a historical reading position through short failed snapshots and replacement', () => {
    const { panel, controller } = mounted();
    panel.wheel(-1); panel.scroll(650);
    controller.update({ sessionKey: 'session', contentReady: false });
    panel.scrollHeight = 500; panel.scroll(100);
    const next = new Panel();
    next.scrollHeight = 500;
    controller.mountPanel(next.element());
    next.scrollHeight = 2400;
    controller.update({ sessionKey: 'session', contentReady: true });
    expect(next.scrollTop).toBe(650);
    panel.scroll(0); // Detached panel cannot alter the replacement's intent.
    next.scrollHeight = 2600; resizes.at(-1)!.callback();
    expect(next.scrollTop).toBe(650);
    controller.dispose();
  });

  it('restores a visible message anchor when content above it changes height', () => {
    const { panel, controller } = mounted();
    panel.messages = [{ id: 'message', top: 600, height: 200 }];
    panel.wheel(-1); panel.scroll(650);
    vi.advanceTimersByTime(1100);
    panel.messages[0]!.top = 900;
    panel.scrollHeight += 300;
    resizes[0]!.callback();
    expect(panel.scrollTop).toBe(950);
    const next = new Panel();
    next.messages = [{ id: 'message', top: 1000, height: 200 }];
    controller.mountPanel(next.element());
    expect(next.scrollTop).toBe(1050);
    controller.dispose();
  });

  it('does not mistake a layout clamp just after user input for a new reading position', () => {
    const { panel, controller, changed } = mounted();
    panel.wheel(-1); panel.scroll(650);
    panel.scrollHeight = 500; panel.scroll(100);
    expect(changed.mock.calls).toEqual([[false]]);
    panel.scrollHeight = 2400; resizes[0]!.callback();
    expect(panel.scrollTop).toBe(650);
    controller.dispose();
  });

  it('bounds layout reads when finding an anchor in a long transcript', () => {
    const { panel, controller } = mounted();
    panel.messages = Array.from({ length: 4096 }, (_, index) => ({ id: `message-${index}`, top: index * 100, height: 100 }));
    panel.scrollHeight = 409600;
    resizes[0]!.callback();
    panel.wheel(-1); panel.scroll(200000);
    expect(panel.anchorReads).toBeLessThan(30);
    controller.dispose();
  });

  it('lets explicit scrolling leave and return to latest, and resets on a new session', () => {
    const { panel, controller, changed } = mounted();
    panel.wheel(-1); panel.scroll(500);
    panel.scrollHeight = 2400; resizes[0]!.callback();
    expect(panel.scrollTop).toBe(500);
    panel.wheel(1); panel.scroll(2000);
    expect(changed.mock.calls).toEqual([[false], [true]]);
    panel.scrollHeight = 2700; resizes[0]!.callback();
    expect(panel.scrollTop).toBe(2300);
    panel.wheel(-1); panel.scroll(400);
    controller.update({ sessionKey: 'other-session', contentReady: true });
    expect(panel.scrollTop).toBe(2300);
    controller.dispose();
  });

  it('retains intent while hidden and disconnects listeners and observers', () => {
    const { panel, controller, changed } = mounted();
    panel.hidden = true; panel.clientHeight = 0; panel.scroll(0);
    panel.scrollHeight = 2500;
    resizes[0]!.callback();
    panel.hidden = false; panel.clientHeight = 400;
    mutations[0]!.callback();
    expect(panel.scrollTop).toBe(2100);
    controller.dispose();
    expect(resizes.every(observer => observer.disconnected)).toBe(true);
    expect(mutations.every(observer => observer.disconnected)).toBe(true);
    panel.wheel(-1); panel.scroll(0);
    expect(changed).not.toHaveBeenCalled();
  });
});
