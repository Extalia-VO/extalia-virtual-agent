import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { dockCharacterPopover, placeCharacterPopover, type PopoverPlacement, type Rect } from '../overlay/popoverModel';
import type { FurnishedOfficeView } from './FurnishedFloors';
import type { CharacterPositionSource } from './movement/positionStore';

// The card element lives outside React state so the render loop can keep it
// beside a walking character without re-rendering anything.
let popoverElement: HTMLElement | null = null;

export function setCharacterPopoverElement(element: HTMLElement | null) {
  popoverElement = element;
}

/** Stage overlays the card avoids; anything else can opt in with `data-popover-obstacle`. */
export const POPOVER_OBSTACLES = '.office-panel, .office-lead-bar, .office-toast, .office-prompt-dock, .office-board, .office-connect-drawer, [data-popover-obstacle]';
const HEAD_HEIGHT = 1.8;
const OBSTACLE_REFRESH_FRAMES = 8;

/** Writes a placement to the card element; only changed attributes are touched. */
export function applyPopoverPlacement(element: HTMLElement, placement: PopoverPlacement) {
  element.style.transform = `translate3d(${Math.round(placement.x)}px, ${Math.round(placement.y)}px, 0)`;
  element.style.setProperty('--popover-arrow', `${Math.round(placement.arrow)}px`);
  if (element.dataset.side !== placement.side) element.dataset.side = placement.side;
  const anchored = placement.side === 'docked' ? 'false' : 'true';
  if (element.dataset.anchored !== anchored) element.dataset.anchored = anchored;
}

/**
 * Anchors the character card to its character every frame (it walks, the camera
 * moves). A character on another floor or off screen docks the card instead.
 */
export function PopoverAnchor({ characterId, live, view }: { characterId: string | null; live: CharacterPositionSource; view: FurnishedOfficeView }) {
  const camera = useThree(state => state.camera);
  const size = useThree(state => state.size);
  const gl = useThree(state => state.gl);
  const scratch = useMemo(() => new Vector3(), []);
  const cache = useRef<{ frame: number; obstacles: Rect[]; origin: [number, number] }>({ frame: 0, obstacles: [], origin: [0, 0] });

  useFrame(() => {
    const element = popoverElement;
    if (!element || !characterId) return;
    const stage = element.offsetParent as HTMLElement | null;
    const memo = cache.current;
    if (stage && memo.frame++ % OBSTACLE_REFRESH_FRAMES === 0) {
      // Canvas pixels and stage pixels differ only by the canvas offset inside the stage.
      const base = stage.getBoundingClientRect();
      const canvas = gl.domElement.getBoundingClientRect();
      memo.origin = [canvas.left - base.left - stage.clientLeft, canvas.top - base.top - stage.clientTop];
      memo.obstacles = [...stage.querySelectorAll<HTMLElement>(POPOVER_OBSTACLES)].flatMap(item => {
        const rect = item.getBoundingClientRect();
        return rect.width && rect.height ? [{ x: rect.left - canvas.left, y: rect.top - canvas.top, width: rect.width, height: rect.height }] : [];
      });
    }
    const card: [number, number] = [element.offsetWidth, element.offsetHeight];
    const viewport: [number, number] = [size.width, size.height];
    const feet = live.position(characterId);
    let placement: PopoverPlacement | undefined;
    if (feet && (typeof view !== 'number' || live.floor(characterId) === view)) {
      scratch.set(feet[0], feet[1] + HEAD_HEIGHT, feet[2]).project(camera);
      const head: [number, number] = [(scratch.x + 1) * size.width / 2, (1 - scratch.y) * size.height / 2];
      const headInFront = scratch.z < 1;
      scratch.set(feet[0], feet[1], feet[2]).project(camera);
      const foot: [number, number] = [(scratch.x + 1) * size.width / 2, (1 - scratch.y) * size.height / 2];
      const onScreen = headInFront && head[0] > 0 && head[0] < size.width && foot[1] > 0 && head[1] < size.height;
      if (onScreen) placement = placeCharacterPopover(head, foot, card, viewport, { obstacles: memo.obstacles });
    }
    placement ??= dockCharacterPopover(card, viewport, { obstacles: memo.obstacles });
    applyPopoverPlacement(element, { ...placement, x: placement.x + memo.origin[0], y: placement.y + memo.origin[1] });
  });
  return null;
}
