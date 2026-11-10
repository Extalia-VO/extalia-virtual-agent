import { useEffect, useRef, useState } from 'react';
import type { SkillBook } from './skillLibraryModel';
import { createSkillShelf, type ShelfActions, type ShelfHover, type ShelfReader } from './skillShelfRenderer';

export default function SkillShelfCanvas({ books, reader, onSelect, onTurn, onClose, onAvailability, onShelfRest, onHover }: {
  books: readonly SkillBook[]; reader: ShelfReader;
  onSelect: (id: string) => void; onTurn: (direction: -1 | 1) => void; onClose: () => void; onAvailability: (ready: boolean) => void; onShelfRest: () => void;
  onHover?: (hover: ShelfHover | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<ReturnType<typeof createSkillShelf> | null>(null);
  const callbacks = useRef({ onSelect, onTurn, onClose, onAvailability, onShelfRest, onHover });
  const [failed, setFailed] = useState(false);
  const latest = useRef({ books, reader });
  const visualKey = JSON.stringify(books.map(book => [book.id, book.title, book.category]));
  useEffect(() => { callbacks.current = { onSelect, onTurn, onClose, onAvailability, onShelfRest, onHover }; latest.current = { books, reader }; });
  useEffect(() => {
    if (failed || !canvas.current) return;
    let live = true;
    const unavailable = () => { if (live) { callbacks.current.onHover?.(null); setFailed(true); callbacks.current.onAvailability(false); } };
    const actions: ShelfActions = {
      onSelect: id => callbacks.current.onSelect(id), onTurn: direction => callbacks.current.onTurn(direction),
      onClose: () => callbacks.current.onClose(), onUnavailable: unavailable, onShelfRest: () => callbacks.current.onShelfRest(),
      onHover: hover => callbacks.current.onHover?.(hover),
    };
    let created: ReturnType<typeof createSkillShelf>;
    try { created = createSkillShelf(canvas.current, latest.current.books, actions); }
    catch { const timer = setTimeout(unavailable, 0); return () => { live = false; clearTimeout(timer); }; }
    renderer.current = created;
    created.read(latest.current.reader);
    // A restored context / newly mounted shelf replaces the same-area text fallback.
    queueMicrotask(() => { if (live) callbacks.current.onAvailability(true); });
    return () => { live = false; callbacks.current.onHover?.(null); created.dispose(); renderer.current = null; };
  }, [visualKey, failed]);
  useEffect(() => { renderer.current?.read(reader); }, [reader]);
  return failed ? null : <canvas ref={canvas} className="skill-shelf-canvas" aria-hidden="true" />;
}
