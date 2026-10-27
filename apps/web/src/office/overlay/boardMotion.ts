import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { BOARD_REORDER_MS, nextBoardOrder } from './boardTree';

/** v0.0.50: a row's flip (overtaking) duration. */
export const BOARD_FLIP_MS = 280;

/** A board row's place in the list: its top in layout pixels (transforms do not count) and its index. */
export interface FlipRecord { top: number; index: number }

/**
 * v0.0.50: the rows that must glide to their new place: a row whose index changed and that moved at least `minPx`.
 * `delta` is where it starts, relative to where it ends (positive: it starts lower and moves up).
 */
export function flipPlan(before: ReadonlyMap<string, FlipRecord>, after: ReadonlyMap<string, FlipRecord>, minPx = 1): { key: string; delta: number }[] {
  const plan: { key: string; delta: number }[] = [];
  for (const [key, next] of after) {
    const prev = before.get(key);
    if (!prev || prev.index === next.index) continue;
    const delta = prev.top - next.top;
    if (Math.abs(delta) >= minPx) plan.push({ key, delta });
  }
  return plan;
}

/**
 * v0.0.50: the board order shown on screen. A change of who is listed applies at once; a pure reorder applies at most once per
 * `BOARD_REORDER_MS`: it waits for the cooldown that starts at the last change, and the newest order is taken when it ends.
 */
export function useSettledBoardOrder(desired: readonly string[]): readonly string[] {
  const [shown, setShown] = useState<readonly string[]>(desired);
  const [cooling, setCooling] = useState(false);
  const next = nextBoardOrder(shown, desired, cooling);
  if (next.changed) {
    setShown(next.ids);
    setCooling(true);
  }
  useEffect(() => {
    if (!cooling) return;
    const timer = window.setTimeout(() => setCooling(false), BOARD_REORDER_MS);
    return () => window.clearTimeout(timer);
  }, [cooling]);
  return next.ids;
}

/** v0.0.50: a row's current translateY from a flip in progress (0 at rest). */
function flipOffset(row: HTMLElement): number {
  if (!row.style.transition || typeof DOMMatrixReadOnly === 'undefined') return 0;
  const transform = getComputedStyle(row).transform;
  return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
}

/**
 * v0.0.50: FLIP for the board list. Every render, it records each keyed row's layout top (`data-flip-key`), and when a row's
 * place in the list changed it glides from where it was to where it is (280 ms ease-out). A row moving up is raised above
 * the rows it passes. Reads come first (one layout), then the writes, then one forced layout before the transitions start.
 * No motion when `reduced` (prefers-reduced-motion).
 */
export function useBoardFlip(list: RefObject<HTMLElement | null>, reduced: boolean): void {
  const record = useRef(new Map<string, FlipRecord>());
  const owner = useRef(new WeakMap<HTMLElement, number>());
  const run = useRef(0);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const rows = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.flipKey !== undefined);
    const byKey = new Map<string, HTMLElement>();
    const after = new Map<string, FlipRecord>();
    const before = new Map<string, FlipRecord>();
    rows.forEach((row, index) => {
      const key = row.dataset.flipKey ?? '';
      const last = record.current.get(key);
      byKey.set(key, row);
      after.set(key, { top: row.offsetTop, index });
      // Where the row was on screen: its last layout top, shifted by the part of a flip it still has to cover.
      if (last) before.set(key, { top: last.top + flipOffset(row), index: last.index });
    });
    record.current = after;
    if (reduced) return;
    const plan = flipPlan(before, after);
    if (plan.length === 0) return;
    const id = ++run.current;
    for (const { key, delta } of plan) {
      const row = byKey.get(key);
      if (!row) continue;
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      row.style.zIndex = delta > 0 ? '2' : '';
      owner.current.set(row, id);
    }
    // One forced layout so the start places apply, then every row glides to its new place.
    const flushed = element.offsetHeight;
    void flushed;
    for (const { key } of plan) {
      const row = byKey.get(key);
      if (!row) continue;
      row.style.transition = `transform ${BOARD_FLIP_MS}ms ease-out`;
      row.style.transform = '';
    }
    window.setTimeout(() => {
      for (const { key } of plan) {
        const row = byKey.get(key);
        if (!row || owner.current.get(row) !== id) continue;
        owner.current.delete(row);
        row.style.transition = '';
        row.style.zIndex = '';
      }
    }, BOARD_FLIP_MS + 40);
  });
}
