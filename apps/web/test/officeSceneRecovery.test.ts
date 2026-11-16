import { createElement, Suspense, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { subscribeContextRecovery, type OfficeContextState } from '../src/office/contextRecovery';
import { createSceneAttempt } from '../src/office/sceneAttempt';
import { createSceneReadiness } from '../src/office/sceneReadiness';

function contextHarness(initiallyLost = false) {
  const canvas = new EventTarget(), states: OfficeContextState[] = [];
  let lost = initiallyLost;
  const recovery = subscribeContextRecovery(canvas, () => lost, state => states.push(state));
  const event = (type: 'webglcontextlost' | 'webglcontextrestored') => {
    lost = type === 'webglcontextlost';
    const event = new Event(type, { cancelable: true }); canvas.dispatchEvent(event); return event;
  };
  return { recovery, event, states, loseWithoutEvent: () => { lost = true; } };
}

describe('Office graphics context recovery', () => {
  it('permits browser restoration and confirms healthy frames before declaring the scene ready', () => {
    const h = contextHarness();
    expect(h.event('webglcontextlost').defaultPrevented).toBe(true);
    h.recovery.frame(); h.recovery.frame();
    expect(h.states).toEqual(['lost']);
    h.event('webglcontextrestored');
    expect(h.states).toEqual(['lost', 'restoring']);
    h.recovery.frame();
    expect(h.states.at(-1)).toBe('restoring');
    h.recovery.frame(); h.recovery.frame();
    expect(h.states).toEqual(['lost', 'restoring', 'ready']);
  });

  it('does not treat a second loss during recovery as a completed restoration', () => {
    const h = contextHarness();
    h.event('webglcontextlost'); h.event('webglcontextrestored'); h.recovery.frame();
    h.event('webglcontextlost'); h.recovery.frame();
    expect(h.states).toEqual(['lost', 'restoring', 'lost']);
    h.event('webglcontextrestored'); h.recovery.frame();
    expect(h.states.at(-1)).toBe('restoring');
    h.recovery.frame();
    expect(h.states.at(-1)).toBe('ready');
  });

  it('detects a missed or already-lost context without requiring a render exception', () => {
    const initial = contextHarness(true);
    expect(initial.states).toEqual(['lost']);
    const h = contextHarness();
    h.loseWithoutEvent(); h.recovery.frame();
    expect(h.states).toEqual(['lost']);
  });

  it('ignores duplicate events and detached scene callbacks', () => {
    const h = contextHarness();
    h.event('webglcontextrestored');
    expect(h.states).toEqual([]);
    h.event('webglcontextlost'); h.event('webglcontextlost');
    expect(h.states).toEqual(['lost']);
    h.recovery.dispose();
    expect(h.event('webglcontextlost').defaultPrevented).toBe(false);
    h.event('webglcontextrestored'); h.recovery.frame(); h.recovery.frame();
    expect(h.states).toEqual(['lost']);
  });
});

describe('explicit Office scene retry', () => {
  it('retries a failed lazy engine only on a new attempt and retains successful loads within that attempt', async () => {
    const Recovered = ({ label }: { label: string }) => createElement('div', null, label);
    const load = vi.fn<() => Promise<{ default: ComponentType<{ label: string }> }>>()
      .mockRejectedValueOnce(new Error('Synthetic transient engine load failure'))
      .mockResolvedValue({ default: Recovered });
    const render = (Scene: ReturnType<typeof createSceneAttempt<{ label: string }>>) => renderToString(
      createElement(Suspense, { fallback: createElement('span', null, 'Loading') }, createElement(Scene, { label: 'Scene ready' })),
    );
    const first = createSceneAttempt(load);
    expect(render(first)).toContain('Loading');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(render(first)).not.toContain('<div>Scene ready</div>');
    expect(load).toHaveBeenCalledTimes(1);
    const retry = createSceneAttempt(load);
    render(retry);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(render(retry)).toContain('<div>Scene ready</div>');
    expect(render(retry)).toContain('<div>Scene ready</div>');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('Office readiness lifetime', () => {
  const harness = () => {
    const callbacks: (() => void)[] = [];
    const cancel = vi.fn();
    const readiness = createSceneReadiness(callback => { callbacks.push(callback); return callbacks.length - 1; }, cancel);
    return { readiness, callbacks, cancel };
  };

  it('cancels the pending notification and fences a callback already queued at unmount', () => {
    const h = harness(), ready = vi.fn();
    h.readiness.mount(); h.readiness.frame(false, ready); h.readiness.frame(false, ready);
    h.readiness.unmount();
    expect(h.cancel).toHaveBeenCalledWith(0);
    h.callbacks[0]!();
    expect(ready).not.toHaveBeenCalled();
  });

  it('requires fresh frames after a StrictMode cleanup/remount and ignores the retired generation', () => {
    const h = harness(), oldReady = vi.fn(), currentReady = vi.fn();
    h.readiness.mount(); h.readiness.frame(false, oldReady); h.readiness.frame(false, oldReady);
    h.readiness.unmount(); h.readiness.mount();
    h.readiness.frame(false, currentReady);
    expect(h.callbacks).toHaveLength(1);
    h.readiness.frame(false, currentReady);
    h.callbacks[0]!(); h.callbacks[1]!();
    expect(oldReady).not.toHaveBeenCalled();
    expect(currentReady).toHaveBeenCalledOnce();
    h.readiness.frame(false, currentReady);
    expect(h.callbacks).toHaveLength(2);
  });

  it('does not count frames while assets are loading', () => {
    const h = harness(), ready = vi.fn();
    h.readiness.mount(); h.readiness.frame(false, ready); h.readiness.frame(true, ready);
    h.readiness.frame(false, ready);
    expect(h.callbacks).toHaveLength(0);
    h.readiness.frame(false, ready); h.callbacks[0]!();
    expect(ready).toHaveBeenCalledOnce();
  });
});
