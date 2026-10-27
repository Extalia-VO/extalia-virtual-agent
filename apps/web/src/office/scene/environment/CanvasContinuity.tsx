import { useLayoutEffect } from 'react';
import { useStore, type RootStore } from '@react-three/fiber';

/**
 * R3F resizes the drawing buffer synchronously when size or DPR changes. That
 * clears its pixels, but its normal animation frame may run after the browser
 * has presented the empty canvas. Subscribe after R3F's resize listener and
 * redraw the current pose before the resize notification returns.
 */
export function subscribeCanvasContinuity(store: RootStore): () => void {
  const canvas = store.getState().gl.domElement;
  let width = canvas.width;
  let height = canvas.height;
  let size = store.getState().size;
  let dpr = store.getState().viewport.dpr;
  let drawing = false;
  return store.subscribe(() => {
    const state = store.getState();
    if (canvas.width === width && canvas.height === height && state.size.width === size.width &&
      state.size.height === size.height && state.viewport.dpr === dpr) return;
    // Capture before rendering: an onBeforeRender callback may notify the store.
    width = canvas.width;
    height = canvas.height;
    size = state.size;
    dpr = state.viewport.dpr;
    if (drawing || !state.internal.active || width <= 0 || height <= 0 || state.gl.getContext().isContextLost()) return;
    drawing = true;
    try {
      // Do not advance the clock or useFrame subscribers: movement runs once
      // in the regular animation frame, and this only restores the current pose.
      state.gl.render(state.scene, state.camera);
    } finally {
      drawing = false;
    }
  });
}

export function CanvasContinuity() {
  const store = useStore();
  useLayoutEffect(() => subscribeCanvasContinuity(store), [store]);
  return null;
}
