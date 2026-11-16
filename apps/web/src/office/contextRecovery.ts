/** Renderer outages never change host sessions or reconstruct the mounted scene. */
export type OfficeContextState = 'ready' | 'lost' | 'restoring';

/** The restored event starts recovery; a healthy drawn-frame interval confirms it. */
export function subscribeContextRecovery(canvas: EventTarget, isContextLost: () => boolean, onState: (state: OfficeContextState) => void) {
  let active = true;
  let state: OfficeContextState = 'ready';
  let frames = 0;
  const change = (next: OfficeContextState) => {
    if (!active || state === next) return;
    state = next; onState(next);
  };
  const lost = (event: Event) => { event.preventDefault(); frames = 0; change('lost'); };
  const restored = () => { if (state === 'lost') { frames = 0; change('restoring'); } };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  if (isContextLost()) change('lost');
  return {
    frame() {
      if (!active) return;
      if (isContextLost()) { frames = 0; change('lost'); return; }
      // useFrame precedes drawing; the second healthy frame follows a completed draw.
      if (state === 'restoring' && ++frames >= 2) change('ready');
    },
    dispose() {
      active = false;
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    },
  };
}
