import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createCameraDirectorState, stepCameraDirector, type CameraDirectorCommand, type CameraSubject } from './cameraDirector';
import { cameraTourCountdown, type CameraTourCountdown } from './cameraCountdown';
import { createCameraNewcomers } from './cameraNewcomers';

/** Passive hover is not a camera takeover; a held pointer remains a manual gesture. */
export function subscribeCameraActivity(target: EventTarget, visibilityTarget: EventTarget, interact: () => void, onPointerChange: (down: boolean) => void): () => void {
  const pointers = new Set<number>();
  const down = (event: Event) => {
    pointers.add((event as PointerEvent).pointerId);
    onPointerChange(true); interact();
  };
  const up = (event: Event) => {
    pointers.delete((event as PointerEvent).pointerId);
    onPointerChange(pointers.size > 0); interact();
  };
  const move = (event: Event) => { if (pointers.size > 0 || (event as PointerEvent).buttons > 0) interact(); };
  const visibility = () => { pointers.clear(); onPointerChange(false); interact(); };
  const listeners: readonly [string, EventListener][] = [
    ['pointerdown', down], ['pointerup', up], ['pointercancel', up], ['pointermove', move],
    ['wheel', interact], ['keydown', interact], ['blur', visibility],
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true, passive: type === 'wheel' || type === 'pointermove' });
  visibilityTarget.addEventListener('visibilitychange', visibility);
  return () => {
    for (const [type, listener] of listeners) target.removeEventListener(type, listener, true);
    visibilityTarget.removeEventListener('visibilitychange', visibility);
    pointers.clear(); onPointerChange(false);
  };
}

/** One Office-owned clock. User activity cancels a shot before the next animation frame. */
export function useCameraDirector({ enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, scope, onFocus, onCountdown }: {
  enabled: boolean; suspended: boolean; workingIds: readonly string[]; attentionIds: readonly string[];
  idleIds: readonly string[]; positionReady(id: string): boolean;
  currentFloor?: number | undefined; floorOf?: ((id: string) => number | undefined) | undefined;
  subjectOf?: ((id: string) => CameraSubject | undefined) | undefined;
  reducedMotion: boolean;
  scope: string; onFocus(command: CameraDirectorCommand): void;
  onCountdown?(countdown: CameraTourCountdown | null): void;
}) {
  const [command, setCommand] = useState<CameraDirectorCommand | null>(null);
  const latest = useRef({ enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, onFocus, onCountdown });
  useLayoutEffect(() => { latest.current = { enabled, suspended, reducedMotion, workingIds, idleIds, attentionIds, positionReady, currentFloor, floorOf, subjectOf, onFocus, onCountdown }; });
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
    let previousCountdown: CameraTourCountdown | null = null;
    const publishCountdown = (next: CameraTourCountdown | null) => {
      if (next?.targetId === previousCountdown?.targetId && next?.seconds === previousCountdown?.seconds && next?.windowSeconds === previousCountdown?.windowSeconds) return;
      previousCountdown = next;
      latest.current.onCountdown?.(next);
    };
    latest.current.onCountdown?.(null);
    const interact = () => { lastInteractionAt = performance.now(); publish(null); publishCountdown(null); };
    const tick = () => {
      const options = latest.current;
      const now = performance.now();
      const newcomerIds = newcomers.update(options.workingIds, options.positionReady, now, options.enabled, [...options.workingIds, ...options.idleIds]);
      const editing = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
      const modal = Boolean(document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]'));
      const input = {
        now, lastInteractionAt, enabled: options.enabled,
        suspended: options.suspended || pointerDown || editing || modal || document.hidden,
        workingIds: options.workingIds.filter(options.positionReady), idleIds: options.idleIds.filter(options.positionReady), newcomerIds,
        spawnedIds: newcomers.spawnedIds(), currentFloor: options.currentFloor, floorOf: options.floorOf,
        subjectOf: options.subjectOf,
        attentionIds: options.attentionIds, random: Math.random(),
        reducedMotion: options.reducedMotion,
      };
      const result = stepCameraDirector(state, input);
      state = result.state;
      publish(result.command);
      publishCountdown(result.command ? cameraTourCountdown(state, input) : null);
    };
    const stopActivity = subscribeCameraActivity(window, document, interact, down => { pointerDown = down; });
    const timer = window.setInterval(tick, 200);
    tick();
    return () => {
      window.clearInterval(timer);
      stopActivity();
      latest.current.onCountdown?.(null);
    };
  }, [scope]);
  return command;
}
