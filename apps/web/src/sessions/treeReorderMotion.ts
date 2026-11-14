import { useLayoutEffect, useRef, type RefObject } from 'react';

export const TREE_REORDER_MS = 340;
export const TREE_FOLDER_SELECTOR = ':scope > .session-browser-folder';
export const TREE_ROW_SELECTOR = ':scope > .session-list > li, :scope > .candidate-list > li';

type Position = { top: number; left: number };
type Sample = Position & { node: HTMLElement; offset: Position };

/** Own transforms only: subtracting the scope rect removes every ancestor's motion. */
function offset(node: HTMLElement, view: Window): Position {
  const transform = view.getComputedStyle(node).transform;
  if (!transform || transform === 'none') return { top: 0, left: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { top: matrix.m42, left: matrix.m41 };
}

/** A bounded sibling-list FLIP owner; DOM identity follows React's existing keyed nodes. */
export function createTreeReorderMotion(scope: HTMLElement, selector: string) {
  const view = scope.ownerDocument.defaultView;
  const preference = view?.matchMedia('(prefers-reduced-motion: reduce)');
  let before = new Map<HTMLElement, Position>();
  const active = new Map<HTMLElement, Animation>();
  let disposed = false;

  const stop = (node: HTMLElement) => {
    const animation = active.get(node);
    active.delete(node);
    if (animation) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    node.classList.remove('is-tree-overtaking', 'is-tree-overtaking-up');
  };
  const stopAll = () => { for (const node of active.keys()) stop(node); };
  const changed = () => { if (preference?.matches) stopAll(); };
  preference?.addEventListener('change', changed);

  return {
    scope,
    update() {
      if (disposed || !view) return;
      const rect = scope.getBoundingClientRect();
      // Read all positions before cancelling or starting any animation. The current
      // computed transform preserves continuity when another reorder interrupts us.
      const samples: Sample[] = Array.from(scope.querySelectorAll<HTMLElement>(selector), node => {
        const own = offset(node, view), box = node.getBoundingClientRect();
        return { node, offset: own, top: box.top - rect.top - own.top, left: box.left - rect.left - own.left };
      });
      const after = new Map(samples.map(({ node, top, left }) => [node, { top, left }]));
      const previousOrder = [...before.keys()].filter(node => after.has(node));
      const nextOrder = samples.map(sample => sample.node).filter(node => before.has(node));
      const previousRank = new Map(previousOrder.map((node, index) => [node, index]));
      const crossed = new Set<HTMLElement>();
      // A rank inversion on either side means this node passed a sibling. Two
      // linear scans also catch crossings with an unchanged final numeric rank.
      let highest = -1, lowest = Infinity;
      for (const node of nextOrder) {
        const rank = previousRank.get(node)!;
        if (rank < highest) crossed.add(node);
        highest = Math.max(highest, rank);
      }
      for (let index = nextOrder.length - 1; index >= 0; index--) {
        const node = nextOrder[index]!, rank = previousRank.get(node)!;
        if (rank > lowest) crossed.add(node);
        lowest = Math.min(lowest, rank);
      }
      for (const node of active.keys()) if (!after.has(node)) stop(node);
      if (preference?.matches) stopAll();
      else for (const sample of samples) {
        const last = before.get(sample.node);
        // Insertion, removal, expansion and initial mounting do not change the
        // relative rank of surviving siblings and therefore never create fly-ins.
        if (!last || !crossed.has(sample.node)) continue;
        const top = last.top + sample.offset.top - sample.top;
        const left = last.left + sample.offset.left - sample.left;
        stop(sample.node);
        if (Math.abs(top) < 1 || typeof sample.node.animate !== 'function') continue;
        sample.node.classList.add('is-tree-overtaking');
        if (top > 0) sample.node.classList.add('is-tree-overtaking-up');
        const animation = sample.node.animate([
          { transform: `translate(${left}px, ${top}px)` },
          { transform: `translate(${top > 0 ? 3 : -3}px, ${top * .48}px)`, offset: .48 },
          { transform: 'translate(0px, 0px)' },
        ], { duration: TREE_REORDER_MS, easing: 'cubic-bezier(.22,.68,.24,1)' });
        active.set(sample.node, animation);
        const finished = () => { if (active.get(sample.node) === animation) stop(sample.node); };
        animation.onfinish = finished;
        animation.oncancel = finished;
      }
      before = after;
    },
    dispose() {
      disposed = true;
      preference?.removeEventListener('change', changed);
      stopAll();
      before.clear();
    },
  };
}

/** Each expanded parent owns its siblings; collapsed branches retain no DOM work. */
export function useTreeReorderMotion(ref: RefObject<HTMLElement | null>, selector: string): void {
  const owner = useRef<ReturnType<typeof createTreeReorderMotion> | null>(null);
  useLayoutEffect(() => {
    const scope = ref.current;
    if (owner.current?.scope !== scope) {
      owner.current?.dispose();
      owner.current = scope ? createTreeReorderMotion(scope, selector) : null;
    }
    owner.current?.update();
  });
  useLayoutEffect(() => () => { owner.current?.dispose(); owner.current = null; }, []);
}
