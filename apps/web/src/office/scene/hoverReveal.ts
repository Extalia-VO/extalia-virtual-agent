import { useCallback, useEffect, useRef, useState } from 'react';

/** Grace before a hover-revealed tag hides, so moving from the character onto its tag does not flicker. */
export const HOVER_HIDE_DELAY_MS = 140;

/**
 * Hover state shared by a character's pick mesh (R3F pointer events, no extra
 * raycasts) and its DOM tag. `enter`/`leave` may come from either; leaving
 * hides after a short grace so crossing between them keeps the tag shown.
 */
export function useHoverReveal(): { hovered: boolean; enter: () => void; leave: () => void } {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enter = useCallback(() => {
    clearTimeout(timer.current);
    setHovered(true);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(false), HOVER_HIDE_DELAY_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { hovered, enter, leave };
}
