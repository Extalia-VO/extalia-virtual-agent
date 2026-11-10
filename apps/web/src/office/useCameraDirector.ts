import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createCameraDirectorState, stepCameraDirector, type CameraDirectorCommand, type CameraSubject } from './cameraDirector';
import { createCameraNewcomers } from './cameraNewcomers';

/** One Office-owned clock. User activity cancels a shot before the next animation frame. */
export function useCameraDirector({ enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, scope, onFocus }: {
  enabled: boolean; suspended: boolean; workingIds: readonly string[]; attentionIds: readonly string[];
  idleIds: readonly string[]; positionReady(id: string): boolean;
  currentFloor?: number | undefined; floorOf?: ((id: string) => number | undefined) | undefined;
  subjectOf?: ((id: string) => CameraSubject | undefined) | undefined;
  reducedMotion: boolean;
  scope: string; onFocus(command: CameraDirectorCommand): void;
}) {
  const [command, setCommand] = useState<CameraDirectorCommand | null>(null);
  const latest = useRef({ enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, onFocus });
  useLayoutEffect(() => { latest.current = { enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, onFocus }; });
  useEffect(() => {
    let state = createCameraDirectorState();
    let lastInteractionAt = performance.now();
    let previous: CameraDirectorCommand | null | undefined;
    let pointerDown = false;
    const newcomers = createCameraNewcomers();
    const publish = (next: CameraDirectorCommand | null) => {
      if (next === previous) return;
      previous = next;
      setCommand(next);
      if (next?.phase === 'focus') latest.current.onFocus(next);
    };
    const interact = () => { lastInteractionAt = performance.now(); publish(null); };
    const down = () => { pointerDown = true; interact(); };
    const up = () => { pointerDown = false; interact(); };
    const visibility = () => { pointerDown = false; interact(); };
    const tick = () => {
      const options = latest.current;
      const now = performance.now();
      const newcomerIds = newcomers.update(options.workingIds, options.positionReady, now, options.enabled, [...options.workingIds, ...options.idleIds]);
      const editing = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
      const modal = Boolean(document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]'));
      const result = stepCameraDirector(state, {
        now, lastInteractionAt, enabled: options.enabled,
        suspended: options.suspended || pointerDown || editing || modal || document.hidden,
        workingIds: options.workingIds.filter(options.positionReady), idleIds: options.idleIds.filter(options.positionReady), newcomerIds,
        spawnedIds: newcomers.spawnedIds(), currentFloor: options.currentFloor, floorOf: options.floorOf,
        subjectOf: options.subjectOf,
        attentionIds: options.attentionIds, random: Math.random(),
        reducedMotion: options.reducedMotion,
      });
      state = result.state;
      publish(result.command);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('pointermove', interact, { capture: true, passive: true });
    window.addEventListener('wheel', interact, { capture: true, passive: true });
    window.addEventListener('keydown', interact, true);
    window.addEventListener('blur', visibility);
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(tick, 200);
    tick();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('pointermove', interact, true);
      window.removeEventListener('wheel', interact, true);
      window.removeEventListener('keydown', interact, true);
      window.removeEventListener('blur', visibility);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [scope]);
  return command;
}
