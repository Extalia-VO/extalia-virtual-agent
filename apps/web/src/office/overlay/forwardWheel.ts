import type { WheelEvent as ReactWheelEvent } from 'react';

/**
 * Overlays over the 3D stage must not swallow the mouse wheel: unless the overlay itself can
 * scroll in the wheel's direction, the wheel is handed to the Office canvas so zooming keeps
 * working with the pointer over cards (OrbitControls listen on the canvas element).
 */
export function forwardWheelToCanvas(event: ReactWheelEvent<HTMLElement>): void {
  const box = event.currentTarget;
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  const canScroll = sideways ? box.scrollWidth > box.clientWidth + 1 : box.scrollHeight > box.clientHeight + 1;
  if (canScroll) return;
  const canvas = box.closest('.office-stage')?.querySelector('canvas');
  if (!canvas) return;
  canvas.dispatchEvent(new WheelEvent('wheel', {
    deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
    clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
    ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    bubbles: true, cancelable: true,
  }));
}
