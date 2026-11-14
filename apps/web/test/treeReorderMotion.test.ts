import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTreeReorderMotion, TREE_FOLDER_SELECTOR, TREE_REORDER_MS, TREE_ROW_SELECTOR } from '../src/sessions/treeReorderMotion';

type FakeAnimation = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: Mock<() => void> };
type FakeNode = {
  top: number; x: number; y: number; classes: Set<string>;
  classList: { add: (...names: string[]) => void; remove: (...names: string[]) => void };
  getBoundingClientRect: () => { top: number; left: number };
  animate: Mock<(frames: Keyframe[], options: KeyframeAnimationOptions) => FakeAnimation>;
};

function fixture(selector = TREE_FOLDER_SELECTOR) {
  const listeners = new Set<() => void>();
  const preference = { matches: false, addEventListener: vi.fn((_name, listener: () => void) => listeners.add(listener)), removeEventListener: vi.fn((_name, listener: () => void) => listeners.delete(listener)) };
  let ancestorTop = 100;
  const view = { matchMedia: vi.fn(() => preference), getComputedStyle: (node: FakeNode) => ({ transform: `matrix(1,0,0,1,${node.x},${node.y})` }) };
  const scope = { ownerDocument: { defaultView: view }, getBoundingClientRect: () => ({ top: ancestorTop, left: 20 }), querySelectorAll: vi.fn(() => nodes as unknown as HTMLElement[]) };
  const nodes: FakeNode[] = [];
  function row(top: number): FakeNode {
    const classes = new Set<string>();
    const node: FakeNode = {
      top, x: 0, y: 0, classes,
      classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) },
      getBoundingClientRect: () => ({ top: ancestorTop + node.top + node.y, left: 20 + node.x }),
      animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
        const animation = { onfinish: null as (() => void) | null, oncancel: null as (() => void) | null, cancel: vi.fn(() => { node.x = 0; node.y = 0; }) };
        return animation;
      }),
    };
    nodes.push(node);
    return node;
  }
  vi.stubGlobal('DOMMatrixReadOnly', class {
    m41: number; m42: number;
    constructor(matrix: string) { const values = matrix.slice(7, -1).split(',').map(Number); this.m41 = values[4]!; this.m42 = values[5]!; }
  });
  const motion = createTreeReorderMotion(scope as unknown as HTMLElement, selector);
  return { nodes, row, motion, scope, preference, listeners, ancestor: (top: number) => { ancestorTop = top; }, reduced: (value: boolean) => { preference.matches = value; listeners.forEach(listener => listener()); } };
}
afterEach(() => vi.unstubAllGlobals());

describe('session tree sibling overtaking', () => {
  it('moves the existing whole folder from its prior place, then releases its temporary layer', () => {
    const f = fixture(), first = f.row(0), second = f.row(160);
    f.motion.update();
    expect(first.animate).not.toHaveBeenCalled();
    f.nodes.reverse(); second.top = 0; first.top = 60;
    f.motion.update();
    expect(second.animate.mock.calls[0]![0][0]).toEqual({ transform: 'translate(0px, 160px)' });
    expect(first.animate.mock.calls[0]![0][0]).toEqual({ transform: 'translate(0px, -60px)' });
    expect(second.animate.mock.calls[0]![1].duration).toBe(TREE_REORDER_MS);
    expect(second.classes.has('is-tree-overtaking-up')).toBe(true);
    second.animate.mock.results[0]!.value.onfinish?.();
    expect(second.classes.size).toBe(0);
    f.motion.dispose();
  });

  it('keeps mounts, pagination, removal and expansion free of reorder motion', () => {
    const f = fixture(), first = f.row(0), second = f.row(40);
    f.motion.update();
    first.top = 0; second.top = 180; // Opening the first folder only changes geometry.
    f.motion.update();
    const added = f.row(0);
    f.nodes.splice(0, 0, f.nodes.pop()!); first.top = 40; second.top = 220;
    f.motion.update();
    f.nodes.shift(); first.top = 0; second.top = 180;
    f.motion.update();
    expect(first.animate).not.toHaveBeenCalled();
    expect(second.animate).not.toHaveBeenCalled();
    expect(added.animate).not.toHaveBeenCalled();
    f.motion.dispose();
  });

  it('reverses a running reorder from its current visual position and ignores ancestor translation', () => {
    const f = fixture(TREE_ROW_SELECTOR), first = f.row(0), second = f.row(50);
    f.motion.update();
    f.nodes.reverse(); first.top = 50; second.top = 0;
    f.motion.update();
    const interrupted = first.animate.mock.results[0]!.value;
    first.y = -30; first.x = -2; second.y = 30; second.x = 2;
    f.ancestor(350); // The containing folder is gliding at the same time.
    f.nodes.reverse(); first.top = 0; second.top = 50;
    f.motion.update();
    expect(first.animate.mock.calls[1]![0][0]).toEqual({ transform: 'translate(-2px, 20px)' });
    expect(second.animate.mock.calls[1]![0][0]).toEqual({ transform: 'translate(2px, -20px)' });
    expect(interrupted.cancel).toHaveBeenCalledOnce();
    expect(interrupted.onfinish).toBeNull();
    expect(f.scope.querySelectorAll).toHaveBeenLastCalledWith(TREE_ROW_SELECTOR);
    f.motion.dispose();
  });

  it('animates crossed siblings even when one retains its numeric index between differently sized folders', () => {
    const f = fixture(), first = f.row(0), middle = f.row(50), last = f.row(80);
    f.motion.update();
    f.nodes.reverse(); last.top = 0; middle.top = 100; first.top = 130;
    f.motion.update();
    expect(middle.animate.mock.calls[0]![0][0]).toEqual({ transform: 'translate(0px, -50px)' });
    f.motion.dispose();
  });

  it('cancels in-flight motion immediately on a live reduced-motion change, then uses fresh positions', () => {
    const f = fixture(), first = f.row(0), second = f.row(50);
    f.motion.update();
    f.nodes.reverse(); first.top = 50; second.top = 0; f.motion.update();
    const animation = first.animate.mock.results[0]!.value;
    f.reduced(true);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(first.classes.size).toBe(0);
    f.nodes.reverse(); first.top = 0; second.top = 50; f.motion.update();
    expect(first.animate).toHaveBeenCalledOnce();
    f.reduced(false);
    f.motion.update();
    expect(first.animate).toHaveBeenCalledOnce();
    f.nodes.reverse(); first.top = 50; second.top = 0; f.motion.update();
    expect(first.animate).toHaveBeenCalledTimes(2);
    f.motion.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it('cancels detached rows and every animation/listener on unmount with no retained callbacks', () => {
    const f = fixture(), first = f.row(0), second = f.row(50);
    f.motion.update(); f.nodes.reverse(); first.top = 50; second.top = 0; f.motion.update();
    const removed = first.animate.mock.results[0]!.value, retained = second.animate.mock.results[0]!.value;
    f.nodes.pop(); f.motion.update();
    expect(removed.cancel).toHaveBeenCalledOnce();
    f.motion.dispose();
    expect(retained.cancel).toHaveBeenCalledOnce();
    expect(removed.oncancel).toBeNull();
    expect(retained.onfinish).toBeNull();
    expect(f.preference.removeEventListener).toHaveBeenCalledOnce();
    f.motion.update();
    expect(first.animate).toHaveBeenCalledOnce();
  });
});
